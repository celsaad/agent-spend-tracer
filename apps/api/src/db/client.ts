import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { env } from "../env.js";
import * as schema from "./schema.js";

const client = createClient({ url: `file:${env.databasePath}` });

export const db = drizzle(client, { schema });

await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
