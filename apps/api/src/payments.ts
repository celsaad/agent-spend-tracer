import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { BaseError, type Address, type Hash } from "viem";
import { writeTransaction, type Db } from "./db/client.js";
import { agents, decisions, type DecisionRow } from "./db/schema.js";

/** Sends USDC on chain. The real one lives in chain.ts; tests use a fake. */
export interface PaymentSender {
  /** The wallet payments are sent from. */
  address: Address;
  /** Simulates, then broadcasts a USDC transfer. Resolves with the tx hash once the node accepts it. */
  send(transfer: { to: Address; amount: bigint }): Promise<Hash>;
  /** Resolves once the transaction is mined, with whether it succeeded or reverted. */
  waitForReceipt(hash: Hash): Promise<"success" | "reverted">;
}

type Log = Pick<FastifyBaseLogger, "info" | "warn">;

function errorMessage(err: unknown): string {
  // viem's errors all extend BaseError. `shortMessage` is the one-line reason (e.g. "transfer
  // amount exceeds balance"); `message` adds request arguments, docs links and the viem version.
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

function updateDecision(db: Db, id: string, fields: Partial<DecisionRow>): Promise<DecisionRow> {
  return writeTransaction(db, async (tx) => {
    const [row] = await tx.update(decisions).set(fields).where(eq(decisions.id, id)).returning();
    return row!;
  });
}

/**
 * Pays an approved decision: approved → submitted, or approved → failed if the transfer can't be
 * sent. Resolves as soon as the transaction is broadcast. From there the indexer marks it
 * confirmed once its Transfer event is enough blocks deep, and confirmPayment marks it failed if
 * it reverts.
 *
 * "failed" means no USDC moved, so failed payments stop counting toward the rolling limit. That
 * holds for a failed simulation, an RPC that rejects the transaction, and an onchain revert. The
 * one gap: if the RPC accepts the transaction but the response never arrives, viem throws and we
 * mark it failed even though it may still be mined.
 */
export async function submitPayment(db: Db, sender: PaymentSender, decision: DecisionRow, log: Log) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, decision.agentId));
  if (agent?.walletAddress.toLowerCase() !== sender.address.toLowerCase()) {
    return updateDecision(db, decision.id, {
      paymentStatus: "failed",
      paymentError: `Agent wallet ${agent?.walletAddress} is not the configured sender ${sender.address}`,
    });
  }

  let hash: Hash;
  try {
    // amount is stored in USDC base units (6 decimals) as an integer, so this is exact.
    hash = await sender.send({ to: decision.recipient, amount: BigInt(decision.amount) });
  } catch (err) {
    return updateDecision(db, decision.id, { paymentStatus: "failed", paymentError: errorMessage(err) });
  }

  const submitted = await updateDecision(db, decision.id, { paymentStatus: "submitted", txHash: hash });
  log.info({ decisionId: decision.id, txHash: hash }, "payment submitted");
  void confirmPayment(db, sender, submitted, log);
  return submitted;
}

/**
 * Waits for the receipt of a submitted payment to catch reverts. A reverted transaction emits no
 * Transfer event, so the indexer would never see it. A successful one stays "submitted" here: the
 * indexer confirms it once it is enough blocks deep, which also protects against reorgs.
 */
export async function confirmPayment(db: Db, sender: PaymentSender, decision: DecisionRow, log: Log) {
  const hash = decision.txHash!;
  try {
    const status = await sender.waitForReceipt(hash);
    if (status === "reverted") {
      await updateDecision(db, decision.id, { paymentStatus: "failed", paymentError: "Transaction reverted onchain" });
    }
    log.info({ decisionId: decision.id, txHash: hash, status }, "payment mined");
  } catch (err) {
    // A timeout or RPC error says nothing about the transaction itself; it may still be mined.
    // Leave it "submitted" so resumeConfirmations picks it up on the next start.
    log.warn({ decisionId: decision.id, txHash: hash, err: errorMessage(err) }, "receipt not available yet");
  }
}

/** On startup, resumes waiting on payments that were submitted but never confirmed. */
export async function resumeConfirmations(db: Db, sender: PaymentSender, log: Log) {
  const pending = await db.select().from(decisions).where(eq(decisions.paymentStatus, "submitted"));
  for (const decision of pending) void confirmPayment(db, sender, decision, log);
}
