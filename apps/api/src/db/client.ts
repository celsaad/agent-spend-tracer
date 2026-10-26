import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "./schema.js";

export async function createDb(path: string) {
  const client = createClient({ url: `file:${path}` });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return db;
}

export type Db = Awaited<ReturnType<typeof createDb>>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// libsql runs every transaction on its own pooled connection and opens it with BEGIN IMMEDIATE,
// and the driver is synchronous, so a second overlapping write can't wait for the first and
// fails with SQLITE_BUSY instead. Every write goes through this queue so they wait their turn.
const writeQueues = new WeakMap<Db, Promise<unknown>>();

export function writeTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = (writeQueues.get(db) ?? Promise.resolve()).then(() => db.transaction(fn));
  writeQueues.set(
    db,
    run.catch(() => {}),
  );
  return run;
}
