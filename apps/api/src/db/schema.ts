import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
