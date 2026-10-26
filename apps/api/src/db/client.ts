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
