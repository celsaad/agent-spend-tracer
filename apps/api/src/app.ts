import Fastify from "fastify";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { parseUnits } from "viem";
import type { Agent, AuthorizeRequest, Decision, Transfer, TransferAuthorization } from "@agent-spend-tracer/shared";
import { USDC_DECIMALS } from "./config.js";
import type { Db } from "./db/client.js";
import { agents, decisions, transfers, type DecisionRow } from "./db/schema.js";
import { submitPayment, type PaymentSender } from "./payments.js";
import { approve, authorize, deny, PolicyError } from "./policy.js";

interface AppOptions {
  sender: PaymentSender;
  logger?: boolean;
  /** Injectable clock for tests. */
  now?: () => Date;
}

const authorizeBodySchema = {
  type: "object",
  required: ["agentId", "amount", "recipient"],
  additionalProperties: false,
  properties: {
    agentId: { type: "string", minLength: 1 },
    // At most 6 decimals: parseUnits would silently round a 7th rather than reject it.
    amount: { type: "string", pattern: "^[0-9]+(\\.[0-9]{1,6})?$" },
    recipient: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
  },
} as const;

function toDecision(row: DecisionRow): Decision {
  return { ...row, amount: String(row.amount) };
}

export function buildApp(db: Db, { sender, logger = true, now = () => new Date() }: AppOptions) {
  // No type coercion: a JSON number amount would already have lost precision, so require strings.
  const app = Fastify({ logger, ajv: { customOptions: { coerceTypes: false } } });

  /** Starts the transfer for a decision that just became payable; otherwise returns it as is. */
  async function payIfApproved(row: DecisionRow): Promise<Decision> {
    if (row.paymentStatus === "approved") row = await submitPayment(db, sender, row, app.log);
    return toDecision(row);
  }

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/agents", async (): Promise<Agent[]> => db.select().from(agents));

  app.post<{ Body: AuthorizeRequest }>(
    "/api/authorize",
    { schema: { body: authorizeBodySchema } },
    async (req): Promise<Decision> => {
      // parseUnits turns a decimal string into integer base units using string math, so "0.1"
      // becomes exactly 100000n. Never go through a JS number: 0.1 * 1e6 is fine but 1.005 * 1e6
      // is 1004999.9999999999.
      const amount = parseUnits(req.body.amount, USDC_DECIMALS);
      if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new PolicyError(400, "invalid_amount", "amount must be positive and within range");
      }
      const row = await authorize(db, { ...req.body, amount: Number(amount) }, now());
      return payIfApproved(row);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/decisions/:id/approve",
    async (req): Promise<Decision> => payIfApproved(await approve(db, req.params.id, now())),
  );

  app.post<{ Params: { id: string } }>(
    "/api/decisions/:id/deny",
    async (req): Promise<Decision> => toDecision(await deny(db, req.params.id, now())),
  );

  /** ?pendingReview=true returns every held review (not just the latest 100) for the review queue. */
  app.get<{ Querystring: { pendingReview?: string } }>("/api/decisions", async (req): Promise<Decision[]> => {
    const rows =
      req.query.pendingReview === "true"
        ? await db
            .select()
            .from(decisions)
            .where(and(eq(decisions.verdict, "review"), isNull(decisions.approvedAt), isNull(decisions.deniedAt)))
            .orderBy(decisions.createdAt)
        : await db.select().from(decisions).orderBy(desc(decisions.createdAt)).limit(100);
    return rows.map(toDecision);
  });

  /** Filter with ?decisionId= (a decision's trace) or ?authorization=unauthorized (alerts). */
  app.get<{ Querystring: { decisionId?: string; authorization?: TransferAuthorization } }>(
    "/api/transfers",
    async (req): Promise<Transfer[]> => {
      const filters: SQL[] = [];
      if (req.query.decisionId) filters.push(eq(transfers.decisionId, req.query.decisionId));
      if (req.query.authorization) filters.push(eq(transfers.authorization, req.query.authorization));
      return db
        .select()
        .from(transfers)
        .where(and(...filters))
        .orderBy(desc(transfers.blockNumber), desc(transfers.logIndex))
        .limit(100);
    },
  );

  app.get<{ Params: { id: string } }>("/api/decisions/:id", async (req): Promise<Decision> => {
    const [row] = await db.select().from(decisions).where(eq(decisions.id, req.params.id));
    if (!row) throw new PolicyError(404, "not_found", `No decision ${req.params.id}`);
    return toDecision(row);
  });

  return app;
}
