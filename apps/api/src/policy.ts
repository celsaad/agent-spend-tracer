import { and, desc, eq, gt, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Address, Verdict } from "@agent-spend-tracer/shared";
import { writeTransaction, type Db, type Tx } from "./db/client.js";
import { decisions, mandates, type DecisionRow, type Mandate } from "./db/schema.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Fastify replies with `statusCode` and includes `code` in the error body. */
export class PolicyError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface SpendRequest {
  amount: number;
  recipient: Address;
}

/**
 * Checks run in order: revoked, recipient, per-tx limit, rolling 30-day limit, review threshold.
 * Limits are inclusive maxima; amounts strictly above `reviewThreshold` are held for review.
 * An empty `allowedRecipients` list allows no one.
 */
export function evaluate(mandate: Mandate, req: SpendRequest, spentLast30d: number): Verdict {
  if (mandate.revokedAt) return "deny_revoked";
  const recipient = req.recipient.toLowerCase();
  if (!mandate.allowedRecipients.some((a) => a.toLowerCase() === recipient)) return "deny_recipient";
  if (req.amount > mandate.perTxLimit) return "deny_limit";
  if (spentLast30d + req.amount > mandate.rolling30dLimit) return "deny_limit";
  if (req.amount > mandate.reviewThreshold) return "review";
  return "allow";
}

/**
 * Total committed spend for the agent in the 30 days before `now`, across all of its mandates
 * (so replacing a mandate doesn't reset the window). Allowed decisions count from creation,
 * approved reviews from approval. Pending reviews don't count until approved, and failed
 * payments don't count because no USDC moved (see payments.ts for when "failed" is set).
 */
async function spentLast30d(tx: Tx, agentId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${decisions.amount}), 0)` })
    .from(decisions)
    .where(
      and(
        eq(decisions.agentId, agentId),
        or(eq(decisions.verdict, "allow"), isNotNull(decisions.approvedAt)),
        or(isNull(decisions.paymentStatus), ne(decisions.paymentStatus, "failed")),
        gt(sql`coalesce(${decisions.approvedAt}, ${decisions.createdAt})`, since),
      ),
    );
  return Number(row!.total);
}

// The rolling-limit check reads the window and then writes a decision, so authorize and approve
// each run in one write transaction and two requests can't interleave between those steps.

export function authorize(
  db: Db,
  req: SpendRequest & { agentId: string },
  now: Date,
): Promise<DecisionRow> {
  return writeTransaction(db, async (tx) => {
    const [mandate] = await tx
      .select()
      .from(mandates)
      .where(eq(mandates.agentId, req.agentId))
      .orderBy(desc(mandates.createdAt))
      .limit(1);
    if (!mandate) throw new PolicyError(404, "no_mandate", `No mandate for agent ${req.agentId}`);

    const verdict = evaluate(mandate, req, await spentLast30d(tx, req.agentId, now));
    const [decision] = await tx
      .insert(decisions)
      .values({
        agentId: req.agentId,
        mandateId: mandate.id,
        amount: req.amount,
        recipient: req.recipient,
        verdict,
        createdAt: now.toISOString(),
        paymentStatus: verdict === "allow" ? "approved" : null,
      })
      .returning();
    return decision!;
  });
}

/**
 * Approves a held review after re-running every check against the decision's mandate as it is
 * now. If a check fails the decision stays pending (it can be retried once the window frees up)
 * and the failing verdict is returned as a 409 error code.
 */
export function approve(db: Db, decisionId: string, now: Date): Promise<DecisionRow> {
  return writeTransaction(db, async (tx) => {
    const decision = await pendingReview(tx, decisionId);
    const [mandate] = await tx.select().from(mandates).where(eq(mandates.id, decision.mandateId));
    const verdict = evaluate(mandate!, decision, await spentLast30d(tx, decision.agentId, now));
    if (verdict !== "allow" && verdict !== "review") {
      throw new PolicyError(409, verdict, `Approval rejected on re-check: ${verdict}`);
    }

    const [approved] = await tx
      .update(decisions)
      .set({ approvedAt: now.toISOString(), paymentStatus: "approved" })
      .where(eq(decisions.id, decisionId))
      .returning();
    return approved!;
  });
}

/** Rejects a held review. Nothing is paid, and it never counts toward the rolling limit. */
export function deny(db: Db, decisionId: string, now: Date): Promise<DecisionRow> {
  return writeTransaction(db, async (tx) => {
    await pendingReview(tx, decisionId);
    const [denied] = await tx
      .update(decisions)
      .set({ deniedAt: now.toISOString() })
      .where(eq(decisions.id, decisionId))
      .returning();
    return denied!;
  });
}

async function pendingReview(tx: Tx, decisionId: string): Promise<DecisionRow> {
  const [decision] = await tx.select().from(decisions).where(eq(decisions.id, decisionId));
  if (!decision) throw new PolicyError(404, "not_found", `No decision ${decisionId}`);
  if (decision.verdict !== "review" || decision.approvedAt || decision.deniedAt) {
    throw new PolicyError(409, "not_pending_review", "Decision is not awaiting review");
  }
  return decision;
}
