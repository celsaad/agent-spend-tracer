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
};
