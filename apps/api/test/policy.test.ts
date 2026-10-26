import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { parseUnits } from "viem";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Decision } from "@agent-spend-tracer/shared";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { agents, decisions, mandates } from "../src/db/schema.js";
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

// libsql on Windows keeps database files locked after close(), so test databases share one
// directory that is removed best-effort at the end instead of after each test.
const dir = mkdtempSync(join(tmpdir(), "agent-spend-tracer-"));
let db: Db;
let app: ReturnType<typeof buildApp>;
let agentId: string;
let mandateId: string;

beforeEach(async () => {
  // A file, not :memory: — libsql gives each transaction its own connection, and an
  // in-memory database exists only on one connection.
  db = await createDb(join(dir, `${randomUUID()}.db`));
  app = buildApp(db, { logger: false, now: () => NOW });

  [{ id: agentId }] = await db
    .insert(agents)
    .values({ name: "test agent", walletAddress: "0x3333333333333333333333333333333333333333" })
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

function authorize(amountUsdc: number, recipient: string = ALLOWED) {
  return app.inject({
    method: "POST",
    url: "/api/authorize",
    payload: { agentId, amount: String(usdc(amountUsdc)), recipient },
  });
}

function approve(id: string) {
  return app.inject({ method: "POST", url: `/api/decisions/${id}/approve` });
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
    ["zero amount", { amount: "0", recipient: ALLOWED }],
    ["decimal amount", { amount: "1.5", recipient: ALLOWED }],
    ["numeric amount", { amount: 5, recipient: ALLOWED }],
    ["bad address", { amount: "1", recipient: "0x123" }],
    ["unsafe integer", { amount: "9007199254740993", recipient: ALLOWED }],
  ])("rejects %s with 400", async (_, body) => {
    const res = await app.inject({ method: "POST", url: "/api/authorize", payload: { agentId, ...body } });
    expect(res.statusCode).toBe(400);
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
