# Development

Everything you need to install, configure, run, test and change the project.

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Configure](#configure)
- [A wallet for the agent](#a-wallet-for-the-agent)
- [Run](#run)
- [The database](#the-database)
- [Tests](#tests)
- [Tooling choices](#tooling-choices)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **Node.js 24** or newer (`process.loadEnvFile`, used to read `.env`, needs Node 21+).
- **pnpm 12**, enabled through Corepack: `corepack enable`. The exact version is pinned in the root
  `package.json` (`"packageManager"`).
- Works on macOS, Linux and Windows (developed on Windows).

## Install

```bash
pnpm install
```

pnpm 12 does not run packages' install scripts unless they are approved.
`pnpm-workspace.yaml` approves `esbuild` (Vite and tsx need its binary) and explicitly denies
`better-sqlite3`, an optional peer of Drizzle that pnpm installs but this project does not use
(see [design decisions](design-decisions.md#libsql-instead-of-better-sqlite3)).

pnpm also refuses packages published very recently (a supply-chain protection). If an install
fails on a just-released version, wait a day or pin the previous version rather than disabling the
check.

## Configure

```bash
cp .env.example .env
```

`.env` lives at the repository root and is gitignored. The API reads it at startup
(`apps/api/src/env.ts`).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `RPC_URL` | yes | (example: `https://sepolia.base.org`) | Base Sepolia JSON-RPC endpoint. The public one is rate-limited and caps `eth_getLogs` at 200 blocks. |
| `AGENT_PRIVATE_KEY` | yes | | `0x` + 64 hex characters. The agent wallet's key. **Testnet only.** |
| `API_PORT` | no | `3001` | HTTP port. The web console's proxy expects 3001. |
| `DATABASE_PATH` | no | `./data.db` | SQLite file, relative to where the API runs (`apps/api/`). |
| `DEMO_RECIPIENT` | no | the agent wallet | Address the seeded mandate allows paying. |
| `INDEXER_CONFIRMATIONS` | no | `5` | Blocks before a transfer is confirmed. |
| `INDEXER_START_BLOCK` | no | head at first start | First block indexed on a fresh database. |
| `INDEXER_CHUNK_SIZE` | no | `200` | Blocks per `eth_getLogs` request. |

## A wallet for the agent

Use a wallet that exists only for this project. The same private key controls the same address on
every EVM chain, including mainnets, and `.env` is a plain-text file.

To create a fresh key (run inside `apps/api`, where viem is installed):

```bash
node -e "import('viem/accounts').then(({generatePrivateKey,privateKeyToAccount})=>{const k=generatePrivateKey();console.log('key    ',k);console.log('address',privateKeyToAccount(k).address)})"
```

Put the key in `AGENT_PRIVATE_KEY`, then fund the address on **Base Sepolia**:

- **Test USDC**: <https://faucet.circle.com> (choose Base Sepolia).
- **Base Sepolia ETH** for gas: any Base Sepolia faucet. Very little is needed: one USDC transfer
  costs about 0.0000002 ETH.

Check it with the API running: `curl localhost:3001/api/agent` shows the address and USDC balance.

## Run

```bash
pnpm --filter @agent-spend-tracer/api db:seed   # once per wallet
pnpm dev
```

- `db:seed` creates an agent for the wallet in `.env` and a demo mandate (5 USDC per payment,
  20 USDC per 30 days, review above 2 USDC, paying `DEMO_RECIPIENT` or the wallet itself). It is safe
  to re-run, and prints a ready-to-use `curl` command.
- `pnpm dev` starts the API on <http://localhost:3001> (restarts on file changes) and the console on
  <http://localhost:5173>.

The API logs JSON lines. Useful messages: `payment submitted`, `payment mined`,
`transfers seen (pending)`, `indexer backfilling`, and at error level
`UNAUTHORIZED transfer from agent wallet`.

## The database

SQLite through [Drizzle ORM](https://orm.drizzle.team/) and the `@libsql/client` driver. The file
is `apps/api/data.db` by default (gitignored).

**Migrations** are SQL files in `apps/api/drizzle/`, applied automatically when the API or the seed
script starts. To change the schema:

1. Edit `apps/api/src/db/schema.ts`.
2. `pnpm --filter @agent-spend-tracer/api db:generate` writes a new numbered SQL migration.
3. Read the generated SQL, commit it with the schema change, restart.

**Reset** everything by stopping the API and deleting `apps/api/data.db` (and any `data.db-wal`,
`data.db-shm`). The next start recreates the tables; run `db:seed` again. Transactions already on
chain stay there. If the indexer re-scans a block range containing them, they will show as
unauthorized, since their decisions are gone.

## Tests

```bash
pnpm test                 # everything
pnpm --filter @agent-spend-tracer/api test -- indexer   # one file, by name
pnpm typecheck
```

| Suite | Tests | Covers |
|---|---|---|
| `apps/api/test/policy.test.ts` | 41 | Every verdict, the 30-day window, approval re-checks, deny, concurrency races, payments with a fake sender, decimals, input validation, console queries. |
| `apps/api/test/indexer.test.ts` | 15 | Pending → confirmed, matching, unauthorized cases, reorgs, restarts and backfill, chunking, RPC failures. Uses a fake chain. |
| `apps/api/test/verdict.test.ts` | 149 | All 138 Saifuro test vectors, replay, store failure, the strict parser, the remote key set. |

No test touches the network or a real chain: payments use a fake `PaymentSender` and the indexer a
fake `TransferSource` (see [architecture.md](architecture.md#module-map)). Each test gets its own
temporary SQLite file. The live behavior was checked separately against Base Sepolia, as recorded in
the pull requests.

The web app has no automated tests; it was verified by running it against the live API and taking
screenshots (`docs/screenshots/`).

## Tooling choices

| Tool | Role |
|---|---|
| pnpm workspaces | Monorepo: `apps/api`, `apps/web`, `packages/shared`. |
| TypeScript 6, strict | Everywhere. The shared package is consumed as source (no build step). |
| Fastify 5 | HTTP server, JSON-schema request validation. |
| Drizzle + libsql | Typed SQL and migrations on SQLite. |
| viem 2 | All chain access (see [payments.md](payments.md)). |
| jose 6 | ES256 signature verification in the verdict verifier. |
| tsx | Runs TypeScript directly in development and for scripts. |
| Vitest 5 | Tests. |
| React 19, Vite 8, TanStack Query 5 | The console. |

## Troubleshooting

**`Missing required env var RPC_URL`.** `.env` is missing or not at the repository root.

**`ERR_PNPM_IGNORED_BUILDS`.** A newly added dependency has an install script. Add it to
`allowBuilds` in `pnpm-workspace.yaml` with `true` or `false`.

**`better-sqlite3` fails to build (`gyp ERR!`).** It shouldn't be built at all; make sure
`pnpm-workspace.yaml` still has `better-sqlite3: false`.

**A payment is `failed` with `transfer amount exceeds balance`.** The wallet has no test USDC.

**A payment is `failed` with `… is not the configured sender …`.** The agent was seeded for a
different key. Run `db:seed` again for the current key and use the new agent id.

**Payments stay `Submitted`.** The indexer confirms them, so check the API log for indexer errors.
Rate limits on the public RPC can slow it; a dedicated RPC URL helps.

**`eth_getLogs is limited to a 200 range`.** `INDEXER_CHUNK_SIZE` is set above what the RPC allows.

**`SQLITE_BUSY: database is locked`.** Something is writing outside `writeTransaction()`, or two
processes share the file.

**Tests leave files in the temp folder on Windows.** libsql keeps SQLite files locked after
`close()` on Windows, so test databases are removed on a best-effort basis at the end of each run.
