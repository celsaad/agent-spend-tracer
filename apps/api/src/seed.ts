// Creates a demo agent for the wallet in AGENT_PRIVATE_KEY, with a small mandate.
// Safe to re-run: reuses the agent and only adds a mandate if it has none.
import { eq } from "drizzle-orm";
import { parseUnits, type Address } from "viem";
import { account } from "./chain.js";
import { USDC_DECIMALS } from "./config.js";
import { createDb } from "./db/client.js";
import { agents, mandates } from "./db/schema.js";
import { env } from "./env.js";

const usdc = (amount: string) => Number(parseUnits(amount, USDC_DECIMALS));

// Paying yourself is a valid ERC-20 transfer, so by default the demo moves test USDC from the
// agent wallet back to itself and nothing is lost. Set DEMO_RECIPIENT to pay somewhere else.
const recipient = (process.env.DEMO_RECIPIENT as Address | undefined) ?? account.address;

const db = await createDb(env.databasePath);

let [agent] = await db.select().from(agents).where(eq(agents.walletAddress, account.address));
agent ??= (await db.insert(agents).values({ name: "Demo agent", walletAddress: account.address }).returning())[0]!;

const [existing] = await db.select().from(mandates).where(eq(mandates.agentId, agent.id));
if (!existing) {
  await db.insert(mandates).values({
    agentId: agent.id,
    perTxLimit: usdc("5"),
    rolling30dLimit: usdc("20"),
    reviewThreshold: usdc("2"),
    allowedRecipients: [recipient],
  });
}

console.log(`Agent ${agent.id} (${agent.walletAddress})
Mandate: up to 5 USDC per payment, 20 USDC per 30 days, review above 2 USDC, pays ${recipient}

Try:
  curl -X POST localhost:${env.port}/api/authorize -H "content-type: application/json" \\
    -d '{"agentId":"${agent.id}","amount":"0.10","recipient":"${recipient}"}'`);
