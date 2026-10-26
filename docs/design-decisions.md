# Design decisions

Every non-obvious choice in the project: what was chosen, what else was possible, and why. The last
section lists known limitations.

- [Money](#money)
- [Policy and concurrency](#policy-and-concurrency)
- [Payments](#payments)
- [Indexer](#indexer)
- [Web console](#web-console)
- [Infrastructure](#infrastructure)
- [Verdict verifier](#verdict-verifier)
- [Known limitations](#known-limitations)

## Money

### Integers in base units, never floats
Amounts are stored as integer USDC base units and handled as `bigint` towards the chain.
*Alternative:* store decimals or floats. *Why not:* binary floating point can't represent most
decimal fractions exactly (`1.005 * 1e6` is `1004999.9999999999`), and chain amounts are integers
anyway. See [payments.md](payments.md#decimals-and-parseunits).

### Human amounts in, converted once, at the edge
`POST /api/authorize` takes `"1.50"` and converts it with `parseUnits` in one place.
*Alternative:* accept base units (`"1500000"`), as the first version did. *Why changed:* readable
requests, and a single conversion point means a single place to get the decimals right.

### Strings for amounts in JSON
Requests reject JSON numbers for `amount`; responses send base units as strings.
*Why:* a JSON number has usually been parsed into a float before your code sees it. Type coercion
is switched off in Fastify for the same reason.

## Policy and concurrency

### Check order: revoked, recipient, per-payment, 30-day, review
Absolute reasons first; limits before the review threshold so a human is never asked to approve
something the limits forbid.

### Inclusive limits, strict review threshold, empty allow-list allows no one
Each is the conservative reading. They are pinned by tests, so changing one is deliberate.

### The 30-day window is per agent, across mandates
*Alternative:* per mandate. *Why not:* replacing a mandate would reset the spend to zero, a way
around the limit.

### Failed payments give the budget back; pending reviews don't reserve it
A `failed` payment moved no USDC, so it shouldn't count. A pending review isn't money yet, and
approval re-checks the limits anyway. *Trade-off:* a review can become unapprovable if other spending
uses the budget first; the console says so ("Would exceed limits now") and it stays approvable later.

### Approval re-checks; a failed re-check leaves the review pending
*Alternative:* fail the decision permanently. *Why not:* the budget frees up as the 30-day window
moves, so the same approval can be valid tomorrow. The history is kept intact.

### One write transaction plus an in-process write queue
The read-then-write of the limit check runs in one transaction; a promise queue serializes write
transactions because libsql's synchronous driver fails overlapping ones with `SQLITE_BUSY` instead of
waiting. Verified by removing each part and watching the race tests fail. See
[spending-policy.md](spending-policy.md#concurrency-why-two-requests-cant-both-slip-under-the-limit).
*Production alternative:* Postgres with a row lock per agent or `SERIALIZABLE` transactions.

## Payments

### Simulate, then write
`simulateContract` before `writeContract`: a revert would still cost gas, simulation gives the
reason immediately, and what is sent is exactly what was simulated. See
[payments.md](payments.md#step-1-simulatecontract).

### Respond at "submitted", not "confirmed"
The HTTP response returns once the transaction is broadcast; confirmation continues in the
background and the client polls. *Why:* confirmation takes ~10 s here and much longer on other
chains; long-held requests time out badly.

### Commit the decision before sending
So a crash between the two never pays something unrecorded. *Trade-off:* a crash can leave a
decision `approved` with no transaction; nothing retries it automatically, because a blind retry
could double-pay. A production system would record the signed transaction before broadcasting so it
could tell the two cases apart.

### The receipt detects reverts; the indexer decides "confirmed"
A receipt is one confirmation deep and can be undone by a reorg; a reverted transaction emits no
event the indexer could see. So each path does the job it can do correctly.

### A local account with viem's nonce manager
A backend signs with its own key (a local account); the nonce manager prevents two back-to-back
payments from getting the same nonce. *Limit:* one process. See
[payments.md](payments.md#noncemanager--handing-out-transaction-nonces-locally).

## Indexer

### The chain as an independent source of truth
Transfers are recorded from chain events, not from our own records. *Why:* it's the only way to catch
money that left the wallet without an approval, and to tell whether what we sent actually landed.

### Live watch for speed, `getLogs` finality scan for correctness
*Alternative:* trust `watchContractEvent` alone. *Why not:* it misses everything during downtime, can
skip windows on failed polls, reports logs from blocks that can still be reorged, and has no durable
position to resume from. See [indexer.md](indexer.md#why-not-trust-the-watcher-alone).

### Confirmed at 5 blocks
A tunable trade-off between speed (~10 s) and certainty. Using the chain's `finalized` block tag would
give real finality at the cost of minutes. See [indexer.md](indexer.md#confirmations).

### Authorization decided at confirmation
Avoids a race with the tx hash being saved milliseconds after broadcast, and means alerts are only
raised for transfers that are final.

### Node-side filters switched off on the transport
`sepolia.base.org` is load-balanced and loses filters between nodes. Excluding `eth_newFilter` makes
viem fall back to stateless `getLogs` polling. Found on a live run, not in theory. See
[indexer.md](indexer.md#why-node-side-filters-are-switched-off).

## Web console

### Polling instead of Server-Sent Events
TanStack Query polls every 2 s. *Alternative:* SSE or WebSockets. *Why not here:* the chain itself
moves in ~2 s blocks and confirmation takes 5 blocks, so push wouldn't feel faster, and polling needs
no server code or connection management. With many viewers or sub-second needs, SSE fed by the
indexer would be the next step.

### A hand-written hash router and plain CSS
Two routes don't justify a router library, and a restrained finance look doesn't need a component
library. Fewer dependencies to explain and update.

### One status label derived from several fields
The database keeps verdict, review outcome and payment status separate (they are different facts);
the console combines them into one badge for scanning, and the trace shows them all.

## Infrastructure

### libsql instead of better-sqlite3
The plan was `better-sqlite3`, but it had no prebuilt binary for Node 24 on Windows, and building it
needs Python and a C++ toolchain. `@libsql/client` is SQLite with prebuilt binaries and first-class
Drizzle support. *Consequence:* its connection pool and synchronous driver are why the write queue
exists.

### SQLite instead of Postgres
Zero setup for a demo. The code would move to Postgres mostly unchanged (Drizzle), and Postgres
would fix the single-process limits below.

### One process does everything
HTTP, receipt watchers and the indexer share one Node process and one database. Simple to run; the
limits are listed below.

### No authentication
Out of scope for a demo, and stated in the README. Anyone who can reach the API can request spends and
approve reviews.

## Verdict verifier

### `jose` for the signature, everything else explicit
Libraries accept things the spec rejects (padding, whitespace, duplicate members, floats for
amounts). Using `jose` only where it is strict, the signature, and writing the rest makes every step
visible and testable.

### A custom JSON parser
`JSON.parse` silently keeps the last duplicate member and turns every number into a float. The spec
requires rejecting duplicates and comparing amounts by decimal value.

### Standalone for now
It is not called by the app yet; wiring it in needs a persistent replay store and a decision about
how it combines with the app's own policy. See
[verdict-verifier.md](verdict-verifier.md#how-it-would-plug-into-the-app).

## Known limitations

| Limitation | Effect | What production would do |
|---|---|---|
| No authentication | Anyone can request spends and approve reviews | Authenticated operators; agents with their own credentials |
| One signing key | Only the agent whose wallet matches `.env` can pay | Per-agent keys in a KMS or HSM, or smart-contract wallets |
| Single process (write queue, nonce manager, replay store) | Two instances would conflict | Postgres locks or transactions, one signer service, a shared replay table |
| Lost broadcast response | A mined payment can be marked `failed` (then flagged unauthorized) | Persist the signed transaction or its hash before broadcasting |
| Crash between commit and send | A decision can stay `approved` and unpaid | The same, plus a reconciler that checks the chain before retrying |
| Reorgs deeper than 5 blocks | A confirmed transfer would not be re-checked | Use the `finalized` block tag for the scan boundary |
| Only outgoing USDC indexed | ETH drained for gas wouldn't alert | Watch native balance and other tokens too |
| No API for agents or mandates | Rules are set by the seed script | A policy editor in the console |
| Pending reviews never expire | They wait forever | Expire them (Saifuro expires reviews after 24 h) |
| Web app untested automatically | Regressions caught only by hand | Component tests and a browser test of the trace |
| Testnet only | No real money | Mainnet configuration, monitoring, key management |
