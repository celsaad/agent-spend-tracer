import type { AgentInfo } from "@agent-spend-tracer/shared";
import { buildApp } from "./app.js";
import { account, getUsdcBalance, usdcSender, usdcTransfers } from "./chain.js";
import { chain } from "./config.js";
import { createDb } from "./db/client.js";
import { env } from "./env.js";
import { createIndexer } from "./indexer.js";
import { resumeConfirmations } from "./payments.js";

const db = await createDb(env.databasePath);
const app = buildApp(db, { sender: usdcSender });

app.get("/api/agent", async (): Promise<AgentInfo> => ({
  address: account.address,
  chainId: chain.id,
  usdcBalance: (await getUsdcBalance()).toString(),
}));

const indexer = createIndexer(db, usdcTransfers, {
  confirmations: env.indexerConfirmations,
  startBlock: env.indexerStartBlock,
  chunkSize: env.indexerChunkSize,
  log: app.log,
});
app.addHook("onClose", () => indexer.stop());

await app.listen({ port: env.port });
await resumeConfirmations(db, usdcSender, app.log);
// The API keeps serving if the indexer can't start (e.g. the RPC is down); restart to retry.
await indexer.start().catch((err) => app.log.error({ err: String(err) }, "indexer failed to start"));
