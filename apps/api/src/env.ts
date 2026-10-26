import { fileURLToPath } from "node:url";
import type { Hex } from "viem";

// .env lives at the repo root
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // no .env file; rely on the real environment
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

export const env = {
  rpcUrl: required("RPC_URL"),
  agentPrivateKey: required("AGENT_PRIVATE_KEY") as Hex,
  port: Number(process.env.API_PORT ?? 3001),
  databasePath: process.env.DATABASE_PATH ?? "./data.db",
  /** Blocks a transfer must be buried under (counting its own) before it is marked confirmed. */
  indexerConfirmations: Number(process.env.INDEXER_CONFIRMATIONS ?? 5),
  /** First block to index on a fresh database. Defaults to the chain head at first start. */
  indexerStartBlock: process.env.INDEXER_START_BLOCK ? BigInt(process.env.INDEXER_START_BLOCK) : undefined,
  /** Blocks per eth_getLogs request. The public Base Sepolia RPC allows at most 200. */
  indexerChunkSize: process.env.INDEXER_CHUNK_SIZE ? Number(process.env.INDEXER_CHUNK_SIZE) : undefined,
};
