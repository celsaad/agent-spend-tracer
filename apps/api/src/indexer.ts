import { and, between, eq, ne } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Address, Hash } from "viem";
import { writeTransaction, type Db, type Tx } from "./db/client.js";
import { decisions, indexerState, transfers } from "./db/schema.js";

/** One USDC Transfer event. */
export interface TransferLog {
  txHash: Hash;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hash;
  from: Address;
  to: Address;
  value: bigint;
}

/** Where transfer events come from. The real one (viem) lives in chain.ts; tests use a fake. */
export interface TransferSource {
  /** The wallet whose outgoing transfers are indexed. */
  wallet: Address;
  getBlockNumber(): Promise<bigint>;
  /** All transfers from `wallet` in [fromBlock, toBlock], straight from the node. */
  getTransfers(fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]>;
  /** Live transfers from `fromBlock` on. Returns an unwatch function. */
  watchTransfers(fromBlock: bigint, onLogs: (logs: TransferLog[]) => void, onError: (err: Error) => void): () => void;
  /** Called with the latest block number as the chain advances. Returns an unwatch function. */
  watchBlocks(onBlock: (blockNumber: bigint) => void, onError: (err: Error) => void): () => void;
}

interface IndexerOptions {
  /** Blocks a transfer must be buried under, counting its own, before it is confirmed. */
  confirmations: number;
  /** First block to index on a fresh database; defaults to the chain head. */
  startBlock?: bigint;
  /** Block range per getLogs request; public RPCs cap it. */
  chunkSize?: number;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
}

const transferId = (log: Pick<TransferLog, "txHash" | "logIndex">) => `${log.txHash}:${log.logIndex}`;

/**
 * Indexes USDC transfers out of the agent wallet and checks each one against its decision.
 *
 * Two paths feed the `transfers` table:
 * - The live watch inserts transfers as "pending" within seconds of being mined, so the UI can
 *   show them. It's a fast path only: over HTTP it polls a node-side filter, which a
 *   load-balanced public RPC can drop.
 * - The finality scan is the source of truth. Once a block range is `confirmations` deep, it is
 *   fetched again with getLogs. Every transfer that scan returns is marked "confirmed" and
 *   matched to its decision; pending rows in that range it doesn't return were reorged out and
 *   are deleted. The checkpoint (last finalized block) only moves past ranges this scan has
 *   covered, so after a restart the indexer resumes exactly where it stopped.
 *
 * Reorgs deeper than `confirmations` blocks aren't handled.
 */
export function createIndexer(db: Db, source: TransferSource, opts: IndexerOptions) {
  const { confirmations, log } = opts;
  // sepolia.base.org rejects eth_getLogs over more than 200 blocks; paid RPCs allow more.
  const chunkSize = BigInt(opts.chunkSize ?? 200);
  const stateKey = `usdc-transfers:${source.wallet.toLowerCase()}`;
  let unwatch: (() => void)[] = [];
  let syncQueue: Promise<void> = Promise.resolve();

  async function getCheckpoint(): Promise<bigint | undefined> {
    const [row] = await db.select().from(indexerState).where(eq(indexerState.key, stateKey));
    return row ? BigInt(row.lastBlock) : undefined;
  }

  async function setCheckpoint(tx: Tx, block: bigint) {
    await tx
      .insert(indexerState)
      .values({ key: stateKey, lastBlock: Number(block) })
      .onConflictDoUpdate({ target: indexerState.key, set: { lastBlock: Number(block) } });
  }

  /**
   * The decision a transfer belongs to, and whether it's authorized: the decision was approved,
   * its amount and recipient match the event, and no other confirmed transfer already claims it.
   */
  async function match(tx: Tx, t: TransferLog) {
    const [decision] = await tx.select().from(decisions).where(eq(decisions.txHash, t.txHash));
    if (!decision) return { decisionId: null, authorized: false };

    const approved = decision.verdict === "allow" || decision.approvedAt !== null;
    const sameTransfer =
      String(decision.amount) === t.value.toString() && decision.recipient.toLowerCase() === t.to.toLowerCase();
    const [alreadyClaimed] = await tx
      .select({ id: transfers.id })
      .from(transfers)
      .where(
        and(
          eq(transfers.decisionId, decision.id),
          eq(transfers.authorization, "authorized"),
          ne(transfers.id, transferId(t)),
        ),
      );
    return { decisionId: decision.id, authorized: approved && sameTransfer && !alreadyClaimed };
  }

  /** Records transfers from the live watch as pending. Ranges already finalized are skipped. */
  async function ingestPending(logs: TransferLog[]) {
    const checkpoint = (await getCheckpoint()) ?? -1n;
    const fresh = logs.filter((t) => t.blockNumber > checkpoint);
    if (fresh.length === 0) return;

    await writeTransaction(db, async (tx) => {
      for (const t of fresh) {
        // Link the decision early so the UI can show it; authorization waits for confirmation.
        const [decision] = await tx.select({ id: decisions.id }).from(decisions).where(eq(decisions.txHash, t.txHash));
        await tx
          .insert(transfers)
          .values({ ...toRow(t), status: "pending", decisionId: decision?.id ?? null })
          .onConflictDoNothing();
      }
    });
    log.info({ count: fresh.length }, "transfers seen (pending)");
  }

  /** Re-scans [from, to], which is now final, and confirms or removes what's in it. */
  async function finalizeRange(from: bigint, to: bigint) {
    const logs = await source.getTransfers(from, to);
    const unauthorized: TransferLog[] = [];

    await writeTransaction(db, async (tx) => {
      // Pending rows the authoritative scan didn't return were reorged out (or moved to a later
      // block, where a later scan will pick them up).
      const returned = new Set(logs.map(transferId));
      const pending = await tx
        .select({ id: transfers.id })
        .from(transfers)
        .where(and(eq(transfers.status, "pending"), between(transfers.blockNumber, Number(from), Number(to))));
      for (const { id } of pending) {
        if (!returned.has(id)) await tx.delete(transfers).where(eq(transfers.id, id));
      }

      for (const t of logs) {
        const { decisionId, authorized } = await match(tx, t);
        const row = {
          ...toRow(t),
          status: "confirmed" as const,
          authorization: authorized ? ("authorized" as const) : ("unauthorized" as const),
          decisionId,
        };
        await tx
          .insert(transfers)
          .values(row)
          .onConflictDoUpdate({
            target: transfers.id,
            set: {
              blockNumber: row.blockNumber,
              blockHash: row.blockHash,
              status: row.status,
              authorization: row.authorization,
              decisionId,
            },
          });
        if (authorized) {
          await tx.update(decisions).set({ paymentStatus: "confirmed" }).where(eq(decisions.id, decisionId!));
        } else {
          unauthorized.push(t);
        }
      }

      await setCheckpoint(tx, to);
    });

    for (const t of unauthorized) {
      log.error(
        { txHash: t.txHash, to: t.to, amount: t.value.toString() },
        "UNAUTHORIZED transfer from agent wallet: no matching approved decision",
      );
    }
  }

  /** Finalizes every range that has become `confirmations` deep at `head`. */
  async function sync(head: bigint) {
    // A transfer in block B has head - B + 1 confirmations, so B is final once B <= head - N + 1.
    const finalTo = head - BigInt(confirmations) + 1n;
    let from = ((await getCheckpoint()) ?? finalTo) + 1n;
    while (from <= finalTo) {
      const to = from + chunkSize - 1n < finalTo ? from + chunkSize - 1n : finalTo;
      await finalizeRange(from, to);
      from = to + 1n;
    }
  }

  /** Runs syncs one at a time, in order; a failure is logged and the next block retries. */
  function scheduleSync(head: bigint) {
    syncQueue = syncQueue
      .then(() => sync(head))
      .catch((err) => log.warn({ err: String(err) }, "indexer sync failed; retrying next block"));
    return syncQueue;
  }

  async function start() {
    const head = await source.getBlockNumber();

    if ((await getCheckpoint()) === undefined) {
      const startBlock = opts.startBlock ?? head;
      await writeTransaction(db, (tx) => setCheckpoint(tx, startBlock - 1n));
      log.info({ startBlock }, "indexer starting fresh");
    }

    // Backfill: finalize everything that's already deep enough (the downtime since the last run),
    // then show the not-yet-final tail as pending.
    // If the backfill fails it is logged and retried on the next block, so start carries on.
    const checkpoint = (await getCheckpoint())!;
    log.info({ from: checkpoint + 1n, head }, "indexer backfilling");
    await scheduleSync(head);
    // The tail is at most the last N-1 blocks; anything older belongs to the finality scan.
    const finalTo = head - BigInt(confirmations) + 1n;
    const tailFrom = [checkpoint + 1n, finalTo + 1n].reduce((a, b) => (a > b ? a : b));
    if (tailFrom <= head) {
      try {
        await ingestPending(await source.getTransfers(tailFrom, head));
      } catch (err) {
        log.warn({ err: String(err) }, "could not load pending tail; it will be confirmed by the finality scan");
      }
    }

    // Live: new transfers from the block after the backfill, and a finality pass per new block.
    const onError = (err: Error) => log.warn({ err: err.message }, "indexer watch error");
    unwatch = [
      source.watchTransfers(head + 1n, (logs) => void ingestPending(logs).catch(onError), onError),
      source.watchBlocks((block) => void scheduleSync(block), onError),
    ];
  }

  function stop() {
    for (const u of unwatch) u();
    unwatch = [];
    return syncQueue;
  }

  return { start, stop, sync: scheduleSync, ingestPending };
}

function toRow(t: TransferLog) {
  return {
    id: transferId(t),
    txHash: t.txHash,
    logIndex: t.logIndex,
    blockNumber: Number(t.blockNumber),
    blockHash: t.blockHash,
    from: t.from,
    to: t.to,
    amount: t.value.toString(),
    seenAt: new Date().toISOString(),
  };
}

export type Indexer = ReturnType<typeof createIndexer>;
