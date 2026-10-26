import type { AgentInfo } from "@agent-spend-tracer/shared";
import { buildApp } from "./app.js";
import { account, getUsdcBalance } from "./chain.js";
import { chain } from "./config.js";
import { createDb } from "./db/client.js";
import { env } from "./env.js";

const app = buildApp(await createDb(env.databasePath));

app.get("/api/agent", async (): Promise<AgentInfo> => ({
  address: account.address,
  chainId: chain.id,
  usdcBalance: (await getUsdcBalance()).toString(),
}));

await app.listen({ port: env.port });
