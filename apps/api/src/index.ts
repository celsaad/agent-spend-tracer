import Fastify from "fastify";
import { desc } from "drizzle-orm";
import type { AgentInfo, Spend } from "@agent-spend-tracer/shared";
import { account, getUsdcBalance } from "./chain.js";
import { chain } from "./config.js";
import { db } from "./db/client.js";
import { spends } from "./db/schema.js";
import { env } from "./env.js";

const app = Fastify({ logger: true });

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/agent", async (): Promise<AgentInfo> => ({
  address: account.address,
  chainId: chain.id,
  usdcBalance: (await getUsdcBalance()).toString(),
}));

app.get("/api/spends", async (): Promise<Spend[]> => {
  const rows = await db.select().from(spends).orderBy(desc(spends.createdAt));
  return rows as Spend[];
});

await app.listen({ port: env.port });
