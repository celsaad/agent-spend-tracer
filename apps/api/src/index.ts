import type { AgentInfo } from "@agent-spend-tracer/shared";
import { buildApp } from "./app.js";
import { account, getUsdcBalance, usdcSender } from "./chain.js";
import { chain } from "./config.js";
import { createDb } from "./db/client.js";
import { env } from "./env.js";
import { resumeConfirmations } from "./payments.js";

const db = await createDb(env.databasePath);
const app = buildApp(db, { sender: usdcSender });

app.get("/api/agent", async (): Promise<AgentInfo> => ({
  address: account.address,
  chainId: chain.id,
  usdcBalance: (await getUsdcBalance()).toString(),
}));

await app.listen({ port: env.port });
await resumeConfirmations(db, usdcSender, app.log);
