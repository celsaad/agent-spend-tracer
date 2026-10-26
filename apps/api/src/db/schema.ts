import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
  Address,
  Hash,
  PaymentStatus,
  TransferAuthorization,
  TransferStatus,
  Verdict,
} from "@agent-spend-tracer/shared";

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
    // null until the decision is payable (allowed, or a review that was approved)
    paymentStatus: text("payment_status").$type<PaymentStatus>(),
    txHash: text("tx_hash").$type<Hash>(),
    paymentError: text("payment_error"),
  },
  (t) => [index("decisions_agent_created_idx").on(t.agentId, t.createdAt)],
);

/** USDC Transfer events sent from the agent wallet, as seen onchain by the indexer. */
export const transfers = sqliteTable(
  "transfers",
  {
    /** `${txHash}:${logIndex}`, unique per event. */
    id: text("id").primaryKey(),
    txHash: text("tx_hash").$type<Hash>().notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: integer("block_number").notNull(),
    blockHash: text("block_hash").$type<Hash>().notNull(),
    from: text("from").$type<Address>().notNull(),
    to: text("to").$type<Address>().notNull(),
    // text, not integer: an unauthorized transfer's amount isn't bounded by our limits
    amount: text("amount").notNull(),
    status: text("status").$type<TransferStatus>().notNull(),
    /** Decided at confirmation; null while pending. */
    authorization: text("authorization").$type<TransferAuthorization>(),
    decisionId: text("decision_id").references(() => decisions.id),
    seenAt: text("seen_at").notNull(),
  },
  (t) => [index("transfers_tx_hash_idx").on(t.txHash), index("transfers_block_idx").on(t.blockNumber)],
);

/** Indexer checkpoints: every block up to `lastBlock` has been scanned and finalized. */
export const indexerState = sqliteTable("indexer_state", {
  key: text("key").primaryKey(),
  lastBlock: integer("last_block").notNull(),
});

export type Mandate = typeof mandates.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
