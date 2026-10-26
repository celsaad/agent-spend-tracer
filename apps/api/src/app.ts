import Fastify from "fastify";
import { desc } from "drizzle-orm";
import type { AuthorizeRequest, Decision, Spend } from "@agent-spend-tracer/shared";
import type { Db } from "./db/client.js";
import { spends, type DecisionRow } from "./db/schema.js";
import { approve, authorize, PolicyError } from "./policy.js";

interface AppOptions {
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
    amount: { type: "string", pattern: "^[1-9][0-9]*$" },
    recipient: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
  },
} as const;

function toDecision(row: DecisionRow): Decision {
  return { ...row, amount: String(row.amount) };
}

export function buildApp(db: Db, { logger = true, now = () => new Date() }: AppOptions = {}) {
  // No type coercion: a JSON number amount would already have lost precision, so require strings.
  const app = Fastify({ logger, ajv: { customOptions: { coerceTypes: false } } });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/spends", async (): Promise<Spend[]> => {
    const rows = await db.select().from(spends).orderBy(desc(spends.createdAt));
    return rows as Spend[];
  });

  app.post<{ Body: AuthorizeRequest }>(
    "/api/authorize",
    { schema: { body: authorizeBodySchema } },
    async (req): Promise<Decision> => {
      const amount = Number(req.body.amount);
      if (!Number.isSafeInteger(amount)) {
        throw new PolicyError(400, "amount_too_large", "amount exceeds the supported range");
      }
      const row = await authorize(db, { ...req.body, amount }, now());
      return toDecision(row);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/decisions/:id/approve",
    async (req): Promise<Decision> => toDecision(await approve(db, req.params.id, now())),
  );

  return app;
}
