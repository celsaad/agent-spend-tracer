# API reference

Base URL in development: `http://localhost:3001`. The web console reaches it through Vite's proxy
at `http://localhost:5173/api/*`. There is no authentication.

Routes are defined in [`apps/api/src/app.ts`](../apps/api/src/app.ts), except `GET /api/agent`,
which needs the live chain and is added in [`apps/api/src/index.ts`](../apps/api/src/index.ts).
Response types are in [`packages/shared/src/index.ts`](../packages/shared/src/index.ts).

| Method | Path | Purpose |
|---|---|---|
| `POST` | [`/api/authorize`](#post-apiauthorize) | Ask to spend; evaluates the policy and pays if allowed |
| `POST` | [`/api/decisions/:id/approve`](#post-apidecisionsidapprove) | Approve a held review (and pay) |
| `POST` | [`/api/decisions/:id/deny`](#post-apidecisionsiddeny) | Reject a held review |
| `GET` | [`/api/decisions`](#get-apidecisions) | Latest 100 decisions, or the review queue |
| `GET` | [`/api/decisions/:id`](#get-apidecisionsid) | One decision |
| `GET` | [`/api/transfers`](#get-apitransfers) | Onchain transfers seen by the indexer |
| `GET` | [`/api/agents`](#get-apiagents) | All agents |
| `GET` | [`/api/agent`](#get-apiagent) | The signing wallet and its USDC balance |
| `GET` | `/api/health` | `{ "ok": true }` |

## Conventions

- **Amounts in requests** are human-readable strings: `"1.50"`.
- **Amounts in responses** are USDC base units as strings: `"1500000"` = 1.5 USDC. Strings, because
  base units can exceed what a JSON number holds exactly.
- **Timestamps** are ISO-8601 UTC strings.
- **Errors** look like `{ "statusCode": 409, "code": "deny_limit", "error": "Conflict", "message": "…" }`.
  The full list is in [spending-policy.md](spending-policy.md#errors).

## The Decision object

```json
{
  "id": "f54fda3d-07c5-4b34-ac24-5e22a65d30ca",
  "agentId": "60ec1ac3-d5f4-41f0-8a43-f59092984175",
  "mandateId": "11f487c7-7edb-416d-9779-4a206506e7a7",
  "amount": "4500000",
  "recipient": "0xe71feB265c01048094FcC06Bf2e0d0C2Fd42f1ab",
  "verdict": "review",
  "createdAt": "2026-10-26T13:45:04.000Z",
  "approvedAt": "2026-10-26T13:45:06.000Z",
  "deniedAt": null,
  "paymentStatus": "confirmed",
  "txHash": "0x8d8c3d5c28802120a931269bac0ea99900ddb0a66dc0b9dd1d2fe5753d07511d",
  "submittedAt": "2026-10-26T13:45:07.000Z",
  "paymentError": null
}
```

| Field | Meaning |
|---|---|
| `verdict` | The policy's answer at request time: `allow`, `review`, `deny_limit`, `deny_recipient`, `deny_revoked`. Never changes. |
| `approvedAt` / `deniedAt` | Set when a human approves or rejects a `review`. |
| `paymentStatus` | `null` (not payable), `approved`, `submitted`, `confirmed`, `failed`. |
| `txHash` / `submittedAt` | Set when the transfer is broadcast. |
| `paymentError` | Why the payment failed, when `paymentStatus` is `failed`. |

## The Transfer object

```json
{
  "id": "0x8d8c…511d:0",
  "txHash": "0x8d8c3d5c28802120a931269bac0ea99900ddb0a66dc0b9dd1d2fe5753d07511d",
  "logIndex": 0,
  "blockNumber": 50502210,
  "blockHash": "0x…",
  "from": "0xe71feB265c01048094FcC06Bf2e0d0C2Fd42f1ab",
  "to": "0xe71feB265c01048094FcC06Bf2e0d0C2Fd42f1ab",
  "amount": "4500000",
  "status": "confirmed",
  "authorization": "authorized",
  "decisionId": "f54fda3d-07c5-4b34-ac24-5e22a65d30ca",
  "seenAt": "2026-10-26T13:45:08.000Z",
  "confirmedAt": "2026-10-26T13:45:09.000Z"
}
```

| Field | Meaning |
|---|---|
| `status` | `pending` (seen, not deep enough) or `confirmed` (N blocks deep and re-verified). |
| `authorization` | `null` while pending; then `authorized` or `unauthorized`. |
| `decisionId` | The decision whose tx hash it carries, or `null`. Set even when unauthorized (e.g. amount mismatch), for investigation. |

## POST /api/authorize

Evaluates a spend request against the agent's current mandate, records the decision, and, if the
verdict is `allow`, sends the payment before responding.

**Body** (no other fields allowed):

| Field | Type | Rules |
|---|---|---|
| `agentId` | string | non-empty |
| `amount` | string | digits with at most 6 decimals, e.g. `"0.10"`, `"12.5"`; greater than 0 |
| `recipient` | string | `0x` + 40 hex characters |

```bash
curl -X POST localhost:3001/api/authorize -H "content-type: application/json" \
  -d '{"agentId":"60ec1ac3-…","amount":"0.10","recipient":"0xe71feB265c01048094FcC06Bf2e0d0C2Fd42f1ab"}'
```

**200** with a Decision. What it contains depends on the verdict:

| Verdict | `paymentStatus` in the response | Next |
|---|---|---|
| `allow` | `submitted` (with `txHash`), or `failed` (with `paymentError`) | the indexer confirms it ~5 blocks later |
| `review` | `null` | appears in the review queue |
| `deny_*` | `null` | final |

**Errors:** 400 (validation, `invalid_amount`), 404 `no_mandate`.

## POST /api/decisions/:id/approve

Approves a pending review after re-checking the mandate and the 30-day total as they are now, then
sends the payment.

**200** with the Decision (`approvedAt` set, `paymentStatus` `submitted` or `failed`).

**Errors:** 404 `not_found`; 409 `not_pending_review`; 409 `deny_limit` / `deny_revoked` /
`deny_recipient` if the re-check fails (the decision stays pending).

## POST /api/decisions/:id/deny

Rejects a pending review. Nothing is paid.

**200** with the Decision (`deniedAt` set). **Errors:** 404 `not_found`, 409 `not_pending_review`.

## GET /api/decisions

The 100 most recent decisions, newest first.

`?pendingReview=true` returns instead **every** review that is neither approved nor denied, oldest
first: the review queue. (Not limited to 100, so an old pending review can't fall off the list.)

## GET /api/decisions/:id

One Decision. **404** `not_found`.

## GET /api/transfers

Up to 100 transfers, newest block first. Filters, combinable:

| Query | Effect |
|---|---|
| `?decisionId=<id>` | transfers matched to that decision (the decision page's "Onchain transfers") |
| `?authorization=unauthorized` | unauthorized transfers (the console's alert) |

## GET /api/agents

```json
[{ "id": "60ec1ac3-…", "name": "Demo agent", "walletAddress": "0xe71feB265c01048094FcC06Bf2e0d0C2Fd42f1ab" }]
```

## GET /api/agent

The wallet of the configured signing key, read live from the chain.

```json
{ "address": "0xe71feB265c01048094FcC06Bf2e0d0C2Fd42f1ab", "chainId": 84532, "usdcBalance": "20000000" }
```

`usdcBalance` is in base units (`"20000000"` = 20 USDC).
