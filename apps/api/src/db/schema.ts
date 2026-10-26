import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Address, Verdict } from "@agent-spend-tracer/shared";

export const spends = sqliteTable("spends", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txHash: text("tx_hash").notNull().unique(),
  to: text("to").notNull(),
  amount: text("amount").notNull(),
  memo: text("memo"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// Amounts and limits are USDC base units (6 decimals). SQLite integers are 64-bit,
// and the API rejects anything above Number.MAX_SAFE_INTEGER (~9 billion USDC).
// Timestamps are ISO-8601 UTC strings, so they compare correctly as text.

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  walletAddress: text("wallet_address").$type<Address>().notNull(),
});

export const mandates = sqliteTable(
  "mandates",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    currency: text("currency", { enum: ["USDC"] }).notNull().default("USDC"),
    perTxLimit: integer("per_tx_limit").notNull(),
    rolling30dLimit: integer("rolling_30d_limit").notNull(),
    reviewThreshold: integer("review_threshold").notNull(),
    allowedRecipients: text("allowed_recipients", { mode: "json" }).$type<Address[]>().notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("mandates_agent_created_idx").on(t.agentId, t.createdAt)],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    mandateId: text("mandate_id")
      .notNull()
      .references(() => mandates.id),
    amount: integer("amount").notNull(),
    recipient: text("recipient").$type<Address>().notNull(),
    verdict: text("verdict").$type<Verdict>().notNull(),
    createdAt: text("created_at").notNull(),
    approvedAt: text("approved_at"),
  },
  (t) => [index("decisions_agent_created_idx").on(t.agentId, t.createdAt)],
);

export type Mandate = typeof mandates.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
