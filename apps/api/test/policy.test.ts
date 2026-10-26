import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { parseUnits, type Address, type Hash } from "viem";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Decision } from "@agent-spend-tracer/shared";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { agents, decisions, mandates } from "../src/db/schema.js";
import { resumeConfirmations } from "../src/payments.js";
import * as policy from "../src/policy.js";

const usdc = (n: number) => Number(parseUnits(String(n), 6));

const NOW = new Date("2026-10-26T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

const ALLOWED = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";

// per-tx 100, rolling 30d 250, review above 50 (USDC)
const MANDATE = {
  perTxLimit: usdc(100),
  rolling30dLimit: usdc(250),
  reviewThreshold: usdc(50),
  allowedRecipients: [ALLOWED],
} as const;

const AGENT_WALLET = "0x3333333333333333333333333333333333333333";

/**
 * Stands in for the viem sender in chain.ts. Records transfers, hands out fake hashes, and keeps
 * each receipt pending until the test settles it.
 */
function fakeSender() {
  let count = 0;
  const receipts = new Map<Hash, { resolve: (s: "success" | "reverted") => void; reject: (e: Error) => void }>();
  const sender = {
    address: AGENT_WALLET as Address,
    sent: [] as { to: Address; amount: bigint }[],
    /** Makes the next send() throw, like a failed simulation. */
    failNextSend: undefined as Error | undefined,
    async send(transfer: { to: Address; amount: bigint }): Promise<Hash> {
      sender.sent.push(transfer);
      const err = sender.failNextSend;
      sender.failNextSend = undefined;
      if (err) throw err;
      return `0x${(++count).toString(16).padStart(64, "0")}`;
    },
    waitForReceipt(hash: Hash) {
      return new Promise<"success" | "reverted">((resolve, reject) => receipts.set(hash, { resolve, reject }));
    },
    settle(hash: Hash, outcome: "success" | "reverted" | Error) {
      const receipt = receipts.get(hash)!;
      if (outcome instanceof Error) receipt.reject(outcome);
      else receipt.resolve(outcome);
    },
  };
  return sender;
}

// libsql on Windows keeps database files locked after close(), so test databases share one
// directory that is removed best-effort at the end instead of after each test.
const dir = mkdtempSync(join(tmpdir(), "agent-spend-tracer-"));
let db: Db;
let sender: ReturnType<typeof fakeSender>;
let app: ReturnType<typeof buildApp>;
let agentId: string;
let mandateId: string;

beforeEach(async () => {
  // A file, not :memory: — libsql gives each transaction its own connection, and an
  // in-memory database exists only on one connection.
  db = await createDb(join(dir, `${randomUUID()}.db`));
  sender = fakeSender();
  app = buildApp(db, { sender, logger: false, now: () => NOW });

  [{ id: agentId }] = await db
    .insert(agents)
    .values({ name: "test agent", walletAddress: AGENT_WALLET })
    .returning();
  [{ id: mandateId }] = await db
    .insert(mandates)
    .values({ agentId, createdAt: daysAgo(60), ...MANDATE, allowedRecipients: [...MANDATE.allowedRecipients] })
    .returning();
});

afterEach(async () => {
  await app.close();
  db.$client.close();
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // see note on `dir`
  }
});

function authorize(amountUsdc: number | string, recipient: string = ALLOWED) {
  return app.inject({
    method: "POST",
    url: "/api/authorize",
    payload: { agentId, amount: String(amountUsdc), recipient },
  });
}

function approve(id: string) {
  return app.inject({ method: "POST", url: `/api/decisions/${id}/approve` });
}

async function getDecision(id: string) {
  return (await app.inject({ method: "GET", url: `/api/decisions/${id}` })).json<Decision>();
}

/** Seeds a past decision directly, bypassing the policy. */
async function seedDecision(amountUsdc: number, createdAt: string, extra: Partial<typeof decisions.$inferInsert> = {}) {
  await db.insert(decisions).values({
    agentId,
    mandateId,
    amount: usdc(amountUsdc),
    recipient: ALLOWED,
    verdict: "allow",
    createdAt,
    ...extra,
  });
}

describe("POST /api/authorize", () => {
  it("allows an amount at or below the review threshold and records it", async () => {
    const res = await authorize(50);
    expect(res.statusCode).toBe(200);
    const decision = res.json<Decision>();
    expect(decision).toMatchObject({
      agentId,
      mandateId,
      amount: String(usdc(50)),
      recipient: ALLOWED,
      verdict: "allow",
      createdAt: NOW.toISOString(),
      approvedAt: null,
    });

    const [row] = await db.select().from(decisions).where(eq(decisions.id, decision.id));
    expect(row?.verdict).toBe("allow");
  });

  it("matches allowed recipients case-insensitively", async () => {
    const res = await authorize(10, ALLOWED.toUpperCase().replace("0X", "0x"));
    expect(res.json<Decision>().verdict).toBe("allow");
  });

  it("holds an amount above the review threshold for review", async () => {
    const res = await authorize(51);
    expect(res.json<Decision>()).toMatchObject({ verdict: "review", approvedAt: null });
  });

  it("denies an amount above the per-transaction limit", async () => {
    const res = await authorize(101);
    expect(res.json<Decision>().verdict).toBe("deny_limit");
  });

  it("denies when the rolling 30-day total would be exceeded", async () => {
    await seedDecision(100, daysAgo(10));
    await seedDecision(100, daysAgo(20));

    expect((await authorize(51)).json<Decision>().verdict).toBe("deny_limit");
    // exactly at the limit is fine
    expect((await authorize(50)).json<Decision>().verdict).toBe("allow");
  });

  it("ignores spend older than 30 days, denials and unapproved reviews", async () => {
    await seedDecision(100, daysAgo(31));
    await seedDecision(100, daysAgo(5), { verdict: "deny_limit" });
    await seedDecision(100, daysAgo(5), { verdict: "review" });
    await seedDecision(100, daysAgo(5));

    // only the 100 from 5 days ago counts, leaving 150
    expect((await authorize(50)).json<Decision>().verdict).toBe("allow"); // 150
    expect((await authorize(50)).json<Decision>().verdict).toBe("allow"); // 200
    expect((await authorize(50)).json<Decision>().verdict).toBe("allow"); // 250
    expect((await authorize(1)).json<Decision>().verdict).toBe("deny_limit");
  });

  it("counts approved reviews from their approval time", async () => {
    // created 40 days ago but approved 5 days ago: still inside the window
    await seedDecision(100, daysAgo(40), { verdict: "review", approvedAt: daysAgo(5) });
    await seedDecision(100, daysAgo(5));

    expect((await authorize(51)).json<Decision>().verdict).toBe("deny_limit");
  });

  it("denies a recipient that is not on the allow list", async () => {
    const res = await authorize(10, STRANGER);
    expect(res.json<Decision>().verdict).toBe("deny_recipient");
  });

  it("denies everything once the mandate is revoked", async () => {
    await db.update(mandates).set({ revokedAt: daysAgo(1) }).where(eq(mandates.id, mandateId));

    expect((await authorize(10)).json<Decision>().verdict).toBe("deny_revoked");
    // revocation is checked before the recipient
    expect((await authorize(10, STRANGER)).json<Decision>().verdict).toBe("deny_revoked");
  });

  it("evaluates against the agent's most recent mandate", async () => {
    const [newer] = await db
      .insert(mandates)
      .values({ agentId, createdAt: daysAgo(1), ...MANDATE, allowedRecipients: [STRANGER] })
      .returning();

    const res = await authorize(10, STRANGER);
    expect(res.json<Decision>()).toMatchObject({ verdict: "allow", mandateId: newer!.id });
  });

  it("lets only one of two concurrent requests through when together they exceed the rolling limit", async () => {
    await seedDecision(100, daysAgo(10));
    await seedDecision(100, daysAgo(20)); // 50 left
    // each fits on its own and is under the per-tx limit and review threshold
    const req = { agentId, amount: usdc(40), recipient: ALLOWED } as const;

    // Calls the policy directly: HTTP injection staggers requests enough that they never overlap,
    // whereas these start together and interleave at every await.
    const results = await Promise.all([policy.authorize(db, req, NOW), policy.authorize(db, req, NOW)]);

    expect(results.map((d) => d.verdict).sort()).toEqual(["allow", "deny_limit"]);
    expect(await db.select().from(decisions).where(eq(decisions.verdict, "deny_limit"))).toHaveLength(1);
  });

  it("returns 404 for an agent with no mandate and records nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/authorize",
      payload: { agentId: "nope", amount: "1", recipient: ALLOWED },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "no_mandate" });
    expect(await db.select().from(decisions)).toHaveLength(0);
  });

  it.each([
    ["zero amount", { amount: "0.000000", recipient: ALLOWED }],
    ["more than 6 decimals", { amount: "1.0000001", recipient: ALLOWED }],
    ["negative amount", { amount: "-1", recipient: ALLOWED }],
    ["exponent notation", { amount: "1e3", recipient: ALLOWED }],
    ["numeric amount", { amount: 5, recipient: ALLOWED }],
    ["bad address", { amount: "1", recipient: "0x123" }],
    ["amount beyond safe integer base units", { amount: "9007199254.740993", recipient: ALLOWED }],
  ])("rejects %s with 400", async (_, body) => {
    const res = await app.inject({ method: "POST", url: "/api/authorize", payload: { agentId, ...body } });
    expect(res.statusCode).toBe(400);
    expect(sender.sent).toHaveLength(0);
  });

  it("converts decimal amounts to exact base units", async () => {
    // 1.005 * 1e6 in floating point is 1004999.9999999999
    const res = await authorize("1.005");
    expect(res.json<Decision>().amount).toBe("1005000");
    expect(sender.sent).toEqual([{ to: ALLOWED, amount: 1_005_000n }]);
  });
});

describe("payments", () => {
  it("submits an allowed payment and stores the hash, leaving confirmation to the indexer", async () => {
    const decision = (await authorize("12.5")).json<Decision>();

    expect(decision).toMatchObject({ verdict: "allow", paymentStatus: "submitted", paymentError: null });
    expect(decision.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sender.sent).toEqual([{ to: ALLOWED, amount: 12_500_000n }]);

    // a successful receipt is only one block deep; the indexer confirms it later (indexer.test.ts)
    sender.settle(decision.txHash!, "success");
    await new Promise((r) => setTimeout(r, 50));
    expect((await getDecision(decision.id)).paymentStatus).toBe("submitted");
  });

  it("marks a payment failed when it reverts onchain, and stops counting it toward the limit", async () => {
    await seedDecision(200, daysAgo(1)); // 50 left
    const decision = (await authorize(50)).json<Decision>();
    expect(decision.paymentStatus).toBe("submitted");
    expect((await authorize(1)).json<Decision>().verdict).toBe("deny_limit");

    sender.settle(decision.txHash!, "reverted");
    await vi.waitFor(async () =>
      expect(await getDecision(decision.id)).toMatchObject({
        paymentStatus: "failed",
        paymentError: "Transaction reverted onchain",
      }),
    );
    expect((await authorize(1)).json<Decision>().verdict).toBe("allow");
  });

  it("marks a payment failed when the transfer can't be sent, without a hash", async () => {
    sender.failNextSend = new Error("transfer amount exceeds balance");

    const decision = (await authorize(10)).json<Decision>();
    expect(decision).toMatchObject({
      verdict: "allow",
      paymentStatus: "failed",
      txHash: null,
      paymentError: "transfer amount exceeds balance",
    });
  });

  it("keeps watching for a revert after a restart when the receipt couldn't be fetched", async () => {
    const decision = (await authorize(10)).json<Decision>();
    sender.settle(decision.txHash!, new Error("timed out"));

    // give the background confirmation a chance to (wrongly) write
    await new Promise((r) => setTimeout(r, 50));
    expect((await getDecision(decision.id)).paymentStatus).toBe("submitted");

    await resumeConfirmations(db, sender, app.log);
    sender.settle(decision.txHash!, "reverted");
    await vi.waitFor(async () => expect((await getDecision(decision.id)).paymentStatus).toBe("failed"));
  });

  it("does not pay a review until it is approved", async () => {
    const review = (await authorize(80)).json<Decision>();
    expect(review).toMatchObject({ verdict: "review", paymentStatus: null, txHash: null });
    expect(sender.sent).toHaveLength(0);

    const approved = (await approve(review.id)).json<Decision>();
    expect(approved.paymentStatus).toBe("submitted");
    expect(sender.sent).toEqual([{ to: ALLOWED, amount: 80_000_000n }]);
  });

  it("does not pay denied decisions", async () => {
    const denied = (await authorize(10, STRANGER)).json<Decision>();
    expect(denied).toMatchObject({ verdict: "deny_recipient", paymentStatus: null });
    expect(sender.sent).toHaveLength(0);
  });

  it("refuses to pay when the agent's wallet isn't the configured sender", async () => {
    await db.update(agents).set({ walletAddress: STRANGER }).where(eq(agents.id, agentId));

    const decision = (await authorize(10)).json<Decision>();
    expect(decision.paymentStatus).toBe("failed");
    expect(decision.paymentError).toContain("is not the configured sender");
    expect(sender.sent).toHaveLength(0);
  });

  it("lists decisions newest first", async () => {
    await seedDecision(1, daysAgo(2));
    const latest = (await authorize(2)).json<Decision>();
    const list = (await app.inject({ method: "GET", url: "/api/decisions" })).json<Decision[]>();
    expect(list.map((d) => d.amount)).toEqual([latest.amount, String(usdc(1))]);
  });
});

describe("POST /api/decisions/:id/approve", () => {
  async function heldReview(amountUsdc = 80) {
    const decision = (await authorize(amountUsdc)).json<Decision>();
    expect(decision.verdict).toBe("review");
    return decision;
  }

  it("approves a held review and counts it toward the rolling limit", async () => {
    const review = await heldReview(80);

    const res = await approve(review.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<Decision>()).toMatchObject({ id: review.id, verdict: "review", approvedAt: NOW.toISOString() });

    await seedDecision(100, daysAgo(1)); // 180 committed, 70 left
    expect((await authorize(50)).json<Decision>().verdict).toBe("allow");
    expect((await authorize(21)).json<Decision>().verdict).toBe("deny_limit");
  });

  it("rejects approval when spending since the hold has used up the rolling limit", async () => {
    const review = await heldReview(80);
    await seedDecision(100, daysAgo(1));
    await seedDecision(100, daysAgo(1)); // 200 committed, 80 would exceed 250

    const res = await approve(review.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "deny_limit" });

    // left pending, so it can be retried later
    const [row] = await db.select().from(decisions).where(eq(decisions.id, review.id));
    expect(row).toMatchObject({ verdict: "review", approvedAt: null });
  });

  it("rejects approval when the mandate was revoked after the hold", async () => {
    const review = await heldReview();
    await db.update(mandates).set({ revokedAt: NOW.toISOString() }).where(eq(mandates.id, mandateId));

    const res = await approve(review.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "deny_revoked" });
  });

  it("approves only one of two concurrent reviews that together exceed the rolling limit", async () => {
    await seedDecision(100, daysAgo(1)); // 150 left
    const a = await heldReview(80);
    const b = await heldReview(80);

    const results = await Promise.all([approve(a.id), approve(b.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it("rejects approving twice", async () => {
    const review = await heldReview();
    expect((await approve(review.id)).statusCode).toBe(200);

    const res = await approve(review.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "not_pending_review" });
  });

  it("rejects approving a decision that was not held for review", async () => {
    const allowed = (await authorize(10)).json<Decision>();
    const res = await approve(allowed.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "not_pending_review" });
  });

  it("returns 404 for an unknown decision", async () => {
    expect((await approve("nope")).statusCode).toBe(404);
  });
});
