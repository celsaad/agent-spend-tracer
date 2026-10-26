# Spending policy

The spending policy turns a request ("agent X wants to pay Y USDC to Z") into a **decision**:
allow it, hold it for a human, or deny it. It also handles the human's approval or denial of held
requests.

Code: [`apps/api/src/policy.ts`](../apps/api/src/policy.ts). Tests:
[`apps/api/test/policy.test.ts`](../apps/api/test/policy.test.ts).

- [Mandates](#mandates)
- [How a request is evaluated](#how-a-request-is-evaluated)
- [The rolling 30-day window](#the-rolling-30-day-window)
- [Reviews: approve and deny](#reviews-approve-and-deny)
- [Concurrency: why two requests can't both slip under the limit](#concurrency-why-two-requests-cant-both-slip-under-the-limit)
- [Rules and their edge cases](#rules-and-their-edge-cases)
- [Errors](#errors)

## Mandates

A mandate is the set of spending rules an agent operates under:

| Field | Meaning | Demo value (`db:seed`) |
|---|---|---|
| `perTxLimit` | Largest single payment allowed. | 5 USDC |
| `rolling30dLimit` | Most the agent may spend in any 30-day window. | 20 USDC |
| `reviewThreshold` | Payments above this need a human's approval. | 2 USDC |
| `allowedRecipients` | The only addresses the agent may pay. | the agent's own wallet |
| `currency` | Always `USDC`. | |
| `revokedAt` | When set, the mandate allows nothing. | |

All amounts are stored in USDC base units (1 USDC = 1,000,000).

An agent may have several mandates over time; **the most recently created one applies**. Mandates
are not edited: to change the rules you would create a new one or revoke the old one. That way each
decision's `mandateId` points at the exact rules it was judged by.

There is no API to create agents or mandates yet; `pnpm --filter @agent-spend-tracer/api db:seed`
creates the demo ones, and tests insert them directly.

## How a request is evaluated

`authorize()` runs the checks in a fixed order and stops at the first that fails. This is the pure
function `evaluate()`:

```text
1. mandate revoked?                              → deny_revoked
2. recipient not in allowedRecipients?           → deny_recipient
3. amount > perTxLimit?                          → deny_limit
4. spent in last 30 days + amount > rolling limit? → deny_limit
5. amount > reviewThreshold?                     → review
6. otherwise                                     → allow
```

Why this order: the cheapest and most absolute reasons come first. A revoked mandate means "no",
whatever the amount. A recipient outside the allow-list is wrong regardless of size. Limit checks
come before the review check so that **a human is never asked to review something the limits
already forbid**.

The outcome is saved as a decision with:

- `verdict`: the result above;
- `paymentStatus`: `"approved"` if the verdict is `allow` (it will be paid right away), otherwise
  `null`;
- `mandateId`, `amount`, `recipient`, `createdAt`.

If the verdict is `allow`, the HTTP handler then sends the payment (see [payments.md](payments.md)).

Worked example with the demo mandate, nothing spent yet:

| Request | Verdict | Why |
|---|---|---|
| 0.10 USDC to the agent wallet | `allow` | within every limit, below the review threshold |
| 3.00 USDC to the agent wallet | `review` | above the 2 USDC threshold |
| 6.00 USDC to the agent wallet | `deny_limit` | above the 5 USDC per-payment limit |
| 1.00 USDC to `0x2222…` | `deny_recipient` | not on the allow-list |

## The rolling 30-day window

"How much has this agent spent in the last 30 days?" is computed by `spentLast30d()` as a single SQL
`SUM` over the agent's decisions that:

- **committed money**: verdict `allow`, or a review that was approved (`approved_at` set);
- **did not fail**: payment status is not `failed`. A failed payment moved no USDC, so it gives
  the budget back;
- **fall inside the window**: their *effective time* is after `now − 30 days`. The effective time
  is `approved_at` for an approved review (that is when the money was committed) and `created_at`
  otherwise.

Things that do **not** count: denials, reviews still waiting, rejected reviews, failed payments.

The window is **per agent, across all its mandates**, not per mandate. Otherwise replacing a mandate
would reset the agent's 30-day spend to zero, which is a way around the limit.

## Reviews: approve and deny

A `review` decision waits in the console's review queue (`GET /api/decisions?pendingReview=true`).

### Approve: `POST /api/decisions/:id/approve`

Approval **re-runs every check**, against the decision's mandate as it is *now* and the 30-day total
as it is *now*:

- The mandate may have been revoked since the request.
- Other payments may have used up the budget since the request.

If any check fails, the approval is refused with HTTP 409 and the failing verdict as the error code
(`deny_limit`, `deny_revoked`, `deny_recipient`), and **the decision stays pending**. It can be
approved later, for example once older spending falls out of the 30-day window.

If the checks pass, `approved_at` is set, `paymentStatus` becomes `"approved"`, and the handler
sends the payment exactly as for an allowed decision.

Note: a pending review does **not** reserve budget. While it waits, allowed payments can use the
budget up; that is why approval re-checks.

### Deny: `POST /api/decisions/:id/deny`

Sets `denied_at`. Nothing is paid, and the decision never counts toward the limit.

Both endpoints only work on a decision whose verdict is `review` and that has been neither approved
nor denied; otherwise they return 409 `not_pending_review`.

## Concurrency: why two requests can't both slip under the limit

The rolling-limit check is a *read* (sum what was spent) followed by a *write* (record the new
decision). If two requests interleave between those steps, both can pass:

```text
budget left: 50 USDC; two requests of 40 USDC arrive together

request A: reads spent → 50 left, 40 fits
request B: reads spent → 50 left, 40 fits     ← reads before A has written
request A: writes allow 40
request B: writes allow 40                    → 80 committed against a 50 budget
```

The fix is to make read-then-write **one atomic unit**: each `authorize()` and `approve()` runs
inside one database write transaction, so the second request reads only after the first has
committed and sees 10 USDC left → `deny_limit`.

### Why a transaction alone wasn't enough here (the write queue)

The database driver is `@libsql/client` (SQLite). It opens each transaction on its own pooled
connection with `BEGIN IMMEDIATE`, which takes SQLite's write lock up front. A second overlapping
transaction then tries to take the lock on a *different* connection. SQLite would normally wait
for it, but the driver is synchronous and runs on the same event loop as the first transaction:
waiting would block the very thread that has to finish the first one. So it fails immediately with
`SQLITE_BUSY: database is locked`.

The solution is `writeTransaction()` in `db/client.ts`: a small in-process queue (a promise chain
per database). Every write transaction waits for the previous one to finish before it begins. The
second request then simply waits a few milliseconds instead of failing. All writes in the app go
through it, including payment status updates and the indexer.

This was verified, not assumed. The test "lets only one of two concurrent requests through when
together they exceed the rolling limit" fails both ways when the protection is removed:

| Version | Result of two concurrent 40 USDC requests with 50 left |
|---|---|
| no transaction, no queue | both `allow`: overspent |
| transaction, no queue | one `allow`, one crashes with `SQLITE_BUSY` (HTTP 500) |
| transaction + queue (current) | one `allow`, one `deny_limit` |

The same is tested for two concurrent approvals.

**Limit:** the queue coordinates one process. Several API instances writing to one SQLite file
would be back to `SQLITE_BUSY` (safe, but not graceful). Production would use Postgres, where the
same pattern is a transaction with a row lock on the agent, or `SERIALIZABLE` isolation.

## Rules and their edge cases

| Rule | Behavior |
|---|---|
| Limits are inclusive | Exactly 5.00 USDC passes a 5 USDC per-payment limit; spending exactly up to the 30-day limit passes. |
| Review threshold is strict | Exactly 2.00 USDC with a 2 USDC threshold is `allow`; 2.000001 is `review`. |
| Empty allow-list | Allows nobody. |
| Recipient comparison | Case-insensitive hex (`0xAbC…` equals `0xabc…`), since these are EVM addresses. |
| No mandate | HTTP 404 `no_mandate`, and no decision is recorded (a decision must point at a mandate). |
| Amount format | A string with at most 6 decimals, greater than zero, at most `Number.MAX_SAFE_INTEGER` base units. A JSON number is rejected. |

## Errors

Errors use Fastify's error format, with a machine-readable `code`:

```json
{ "statusCode": 409, "code": "deny_limit", "error": "Conflict", "message": "Approval rejected on re-check: deny_limit" }
```

| Status | `code` | When |
|---|---|---|
| 400 | `FST_ERR_VALIDATION` | Body fails the schema (missing field, bad address, amount not a string, 7+ decimals). |
| 400 | `invalid_amount` | Amount is zero or too large. |
| 404 | `no_mandate` | The agent has no mandate. |
| 404 | `not_found` | Unknown decision id. |
| 409 | `not_pending_review` | Approve/deny on a decision that isn't a pending review. |
| 409 | `deny_limit` / `deny_recipient` / `deny_revoked` | Approval refused because a re-check failed. |

A *denied request* is **not** an error: `POST /api/authorize` returns 200 with the decision, whose
`verdict` says `deny_*`. The request was processed successfully; the answer was no.
