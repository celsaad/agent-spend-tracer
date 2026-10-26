import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Address, Hash } from "viem";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { agents, decisions, indexerState, mandates, transfers } from "../src/db/schema.js";
import { createIndexer, type Indexer, type TransferLog, type TransferSource } from "../src/indexer.js";

const WALLET: Address = "0x3333333333333333333333333333333333333333";
const RECIPIENT: Address = "0x1111111111111111111111111111111111111111";
const CONFIRMATIONS = 3;

const hash = (n: number): Hash => `0x${n.toString(16).padStart(64, "0")}`;

/**
 * A chain you can mine and reorg by hand. `logs` is what the node currently says happened;
 * the watch callbacks are captured so a test can deliver (or withhold) live events.
 */
function fakeChain(head = 100n) {
  const chain = {
    wallet: WALLET,
    head,
    logs: [] as TransferLog[],
    getTransfersCalls: [] as [bigint, bigint][],
    /** Makes the next getTransfers call fail, like an RPC hiccup. */
    failNextGetTransfers: false,
    watchFrom: undefined as bigint | undefined,
    onLogs: undefined as ((logs: TransferLog[]) => void) | undefined,

    async getBlockNumber() {
      return chain.head;
    },
    async getTransfers(from: bigint, to: bigint) {
      chain.getTransfersCalls.push([from, to]);
      if (chain.failNextGetTransfers) {
        chain.failNextGetTransfers = false;
        throw new Error("RPC Request failed");
      }
      // like sepolia.base.org
      if (to - from + 1n > 200n) throw new Error("eth_getLogs is limited to a 200 range");
      return chain.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    },
    watchTransfers(fromBlock: bigint, onLogs: (logs: TransferLog[]) => void) {
      chain.watchFrom = fromBlock;
      chain.onLogs = onLogs;
      return () => (chain.onLogs = undefined);
    },
    watchBlocks() {
      return () => {};
    },

    /** Adds a transfer from the wallet to the chain and returns its log. */
    mine(block: bigint, txHash: Hash, value: bigint, to: Address = RECIPIENT): TransferLog {
      const log = { txHash, logIndex: 0, blockNumber: block, blockHash: hash(Number(block) * 1000), from: WALLET, to, value };
      chain.logs.push(log);
      return log;
    },
  };
  return chain satisfies TransferSource;
}

const dir = mkdtempSync(join(tmpdir(), "agent-spend-tracer-indexer-"));
let db: Db;
let chain: ReturnType<typeof fakeChain>;
let indexer: Indexer;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let agentId: string;
let mandateId: string;

function newIndexer(opts: { startBlock?: bigint; chunkSize?: number } = {}) {
  return createIndexer(db, chain, { confirmations: CONFIRMATIONS, log: log as never, ...opts });
}

beforeEach(async () => {
  db = await createDb(join(dir, `${randomUUID()}.db`));
  chain = fakeChain();
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  indexer = newIndexer();

  [{ id: agentId }] = await db.insert(agents).values({ name: "agent", walletAddress: WALLET }).returning();
  [{ id: mandateId }] = await db
    .insert(mandates)
    .values({ agentId, perTxLimit: 1e9, rolling30dLimit: 1e9, reviewThreshold: 1e9, allowedRecipients: [RECIPIENT] })
    .returning();
});

afterEach(async () => {
  await indexer.stop();
  db.$client.close();
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // libsql on Windows keeps files locked after close(); see policy.test.ts
  }
});

/** A decision whose payment was sent, as payments.ts leaves it. */
async function submittedDecision(txHash: Hash, amount = 1_000_000, extra: Partial<typeof decisions.$inferInsert> = {}) {
  const [row] = await db
    .insert(decisions)
    .values({
      agentId,
      mandateId,
      amount,
      recipient: RECIPIENT,
      verdict: "allow",
      createdAt: new Date().toISOString(),
      paymentStatus: "submitted",
      txHash,
      ...extra,
    })
    .returning();
  return row!;
}

const getTransfers = () => db.select().from(transfers);
const getDecision = async (id: string) => (await db.select().from(decisions).where(eq(decisions.id, id)))[0]!;

describe("indexer", () => {
  it("shows a live transfer as pending, then confirms it and its decision after N blocks", async () => {
    const decision = await submittedDecision(hash(1));
    await indexer.start(); // head 100

    chain.onLogs!([chain.mine(101n, hash(1), 1_000_000n)]);
    await vi.waitFor(async () => expect(await getTransfers()).toHaveLength(1));
    expect((await getTransfers())[0]).toMatchObject({
      status: "pending",
      authorization: null,
      decisionId: decision.id,
      amount: "1000000",
    });

    // block 101 has 2 confirmations at head 102: not yet
    await indexer.sync(102n);
    expect((await getTransfers())[0]!.status).toBe("pending");
    expect((await getDecision(decision.id)).paymentStatus).toBe("submitted");

    // 3 confirmations at head 103
    await indexer.sync(103n);
    expect((await getTransfers())[0]).toMatchObject({
      status: "confirmed",
      authorization: "authorized",
      confirmedAt: expect.any(String),
    });
    expect((await getDecision(decision.id)).paymentStatus).toBe("confirmed");
  });

  it("flags a transfer with no matching decision as unauthorized", async () => {
    await indexer.start();
    chain.mine(101n, hash(99), 5_000_000n);

    await indexer.sync(103n);

    expect(await getTransfers()).toMatchObject([
      { txHash: hash(99), status: "confirmed", authorization: "unauthorized", decisionId: null },
    ]);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: hash(99), amount: "5000000" }),
      expect.stringContaining("UNAUTHORIZED"),
    );
  });

  it("flags a transfer whose amount or recipient differs from its decision", async () => {
    const wrongAmount = await submittedDecision(hash(1), 1_000_000);
    const wrongRecipient = await submittedDecision(hash(2), 1_000_000);
    await indexer.start();
    chain.mine(101n, hash(1), 9_000_000n);
    chain.mine(101n, hash(2), 1_000_000n, "0x2222222222222222222222222222222222222222");

    await indexer.sync(103n);

    const rows = await getTransfers();
    expect(rows.map((r) => r.authorization)).toEqual(["unauthorized", "unauthorized"]);
    expect(rows.map((r) => r.decisionId).sort()).toEqual([wrongAmount.id, wrongRecipient.id].sort());
    expect((await getDecision(wrongAmount.id)).paymentStatus).toBe("submitted");
  });

  it("flags a transfer whose decision was never approved", async () => {
    await submittedDecision(hash(1), 1_000_000, { verdict: "review", approvedAt: null });
    await indexer.start();
    chain.mine(101n, hash(1), 1_000_000n);

    await indexer.sync(103n);

    expect((await getTransfers())[0]!.authorization).toBe("unauthorized");
  });

  it("authorizes only one transfer per decision", async () => {
    await submittedDecision(hash(1), 1_000_000);
    await indexer.start();
    // two identical Transfer events in one transaction
    const first = chain.mine(101n, hash(1), 1_000_000n);
    chain.logs.push({ ...first, logIndex: 1 });

    await indexer.sync(103n);

    expect((await getTransfers()).map((r) => r.authorization).sort()).toEqual(["authorized", "unauthorized"]);
  });

  it("matches a transfer seen before its decision stored the tx hash", async () => {
    const decision = await submittedDecision(hash(1));
    await db.update(decisions).set({ txHash: null }).where(eq(decisions.id, decision.id));
    await indexer.start();
    chain.onLogs!([chain.mine(101n, hash(1), 1_000_000n)]);
    await vi.waitFor(async () => expect(await getTransfers()).toHaveLength(1));

    // payments.ts saves the hash a moment after broadcasting
    await db.update(decisions).set({ txHash: hash(1) }).where(eq(decisions.id, decision.id));
    await indexer.sync(103n);

    expect((await getTransfers())[0]).toMatchObject({ authorization: "authorized", decisionId: decision.id });
  });

  describe("reorgs", () => {
    it("drops a pending transfer that was reorged out, leaving its decision submitted", async () => {
      const decision = await submittedDecision(hash(1));
      await indexer.start();
      chain.onLogs!([chain.mine(101n, hash(1), 1_000_000n)]);
      await vi.waitFor(async () => expect(await getTransfers()).toHaveLength(1));

      chain.logs = []; // block 101 replaced by one without the transfer
      await indexer.sync(103n);

      expect(await getTransfers()).toHaveLength(0);
      expect((await getDecision(decision.id)).paymentStatus).toBe("submitted");
    });

    it("follows a transfer that moved to a later block and confirms it there", async () => {
      await submittedDecision(hash(1));
      await indexer.start();
      chain.onLogs!([chain.mine(101n, hash(1), 1_000_000n)]);
      await vi.waitFor(async () => expect(await getTransfers()).toHaveLength(1));

      chain.logs = [];
      chain.mine(102n, hash(1), 1_000_000n); // re-included one block later
      await indexer.sync(103n); // finalizes 101: gone from there
      expect(await getTransfers()).toHaveLength(0);

      await indexer.sync(104n); // finalizes 102
      expect(await getTransfers()).toMatchObject([
        { blockNumber: 102, blockHash: hash(102_000), status: "confirmed", authorization: "authorized" },
      ]);
    });

    it("ignores a live event for a block that is already finalized", async () => {
      await indexer.start();
      await indexer.sync(103n); // 101 finalized with no transfers

      await indexer.ingestPending([{ ...chain.mine(101n, hash(1), 1n) }]);

      expect(await getTransfers()).toHaveLength(0);
    });
  });

  describe("restarts", () => {
    it("backfills transfers mined while it was down, then watches from the next block", async () => {
      const decision = await submittedDecision(hash(1));
      await indexer.start(); // head 100, checkpoint 99
      await indexer.stop();

      chain.mine(105n, hash(1), 1_000_000n);
      chain.mine(110n, hash(2), 7n);
      chain.head = 120n;

      indexer = newIndexer();
      await indexer.start();

      expect(await getTransfers()).toMatchObject([
        { txHash: hash(1), status: "confirmed", authorization: "authorized" },
        { txHash: hash(2), status: "confirmed", authorization: "unauthorized" },
      ]);
      expect((await getDecision(decision.id)).paymentStatus).toBe("confirmed");
      const [state] = await db.select().from(indexerState);
      expect(state!.lastBlock).toBe(118); // 120 - 3 + 1
      expect(chain.watchFrom).toBe(121n);
    });

    it("shows the not-yet-final tail as pending after a restart", async () => {
      await indexer.start();
      await indexer.stop();
      chain.mine(119n, hash(1), 1n);
      chain.head = 120n;

      indexer = newIndexer();
      await indexer.start();

      expect(await getTransfers()).toMatchObject([{ blockNumber: 119, status: "pending" }]);
    });

    it("scans in contiguous chunks with no gaps or overlaps", async () => {
      chain.head = 150n;
      indexer = newIndexer({ startBlock: 100n, chunkSize: 20 });
      await indexer.start();

      const finalized = chain.getTransfersCalls.slice(0, -1); // last call is the pending tail
      expect(finalized).toEqual([
        [100n, 119n],
        [120n, 139n],
        [140n, 148n],
      ]);
      expect(chain.getTransfersCalls.at(-1)).toEqual([149n, 150n]);
    });

    it("backfills a long gap within the RPC's 200-block getLogs limit by default", async () => {
      chain.mine(1_234n, hash(1), 1n);
      chain.head = 2_000n;
      indexer = newIndexer({ startBlock: 100n });
      await indexer.start();

      expect(await getTransfers()).toMatchObject([{ blockNumber: 1234, status: "confirmed" }]);
      expect(log.warn).not.toHaveBeenCalled();
    });

    it("keeps starting when the backfill fails, and catches up on the next block", async () => {
      chain.mine(150n, hash(1), 1n);
      chain.head = 200n;
      chain.failNextGetTransfers = true;
      indexer = newIndexer({ startBlock: 100n });

      await indexer.start();
      expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("retrying next block"));
      expect(chain.watchFrom).toBe(201n); // live watch still installed
      // the pending tail was only the last N-1 blocks, not the whole unscanned gap
      expect(chain.getTransfersCalls.at(-1)).toEqual([199n, 200n]);

      await indexer.sync(201n);
      expect(await getTransfers()).toMatchObject([{ blockNumber: 150, status: "confirmed" }]);
    });

    it("starts from INDEXER_START_BLOCK on a fresh database", async () => {
      chain.mine(60n, hash(1), 1n);
      indexer = newIndexer({ startBlock: 50n });
      await indexer.start();

      expect(await getTransfers()).toMatchObject([{ blockNumber: 60, status: "confirmed" }]);
    });
  });
});
