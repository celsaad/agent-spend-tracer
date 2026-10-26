# Verdict verifier

[Saifuro](https://docs.saifuro.com) checks payments that AI agents try to make against a mandate a
human approved, and returns a **signed verdict**: a JWT that says `allow`, `review` or `deny_*` for
one specific payment. A party that settles the payment can verify the verdict with Saifuro's public
key, without trusting whoever presented it.

`apps/api/src/verdict/` is a TypeScript verifier for those verdicts. It implements the verification
procedure of the Internet-Draft
[draft-dias-agent-payment-verdicts-00](https://www.ietf.org/archive/id/draft-dias-agent-payment-verdicts-00.txt),
Section 6, which Saifuro's page [Verifying a verdict](https://docs.saifuro.com/reference/verify-a-verdict)
summarizes, and it passes all **138** of Saifuro's published
[test vectors](https://docs.saifuro.com/reference/verdict-test-vectors).

**It is standalone: nothing in the app calls it yet.** See
[How it would plug into the app](#how-it-would-plug-into-the-app).

- [How this relates to the rest of the app](#how-this-relates-to-the-rest-of-the-app)
- [What a verdict looks like](#what-a-verdict-looks-like)
- [Using it](#using-it)
- [The twelve steps, and why each exists](#the-twelve-steps-and-why-each-exists)
- [Checking a stored verdict](#checking-a-stored-verdict)
- [Files](#files)
- [The test vectors](#the-test-vectors)
- [How it would plug into the app](#how-it-would-plug-into-the-app)

## How this relates to the rest of the app

This app has its own spending policy ([spending-policy.md](spending-policy.md)) that decides
allow/review/deny itself. Saifuro is the same idea as a service: the decision is made elsewhere and
arrives as a signed token. The verifier is the code a payment system runs before trusting such a
token. The concepts line up closely:

| This app | Saifuro verdict |
|---|---|
| mandate (limits, review threshold, recipients) | `mandate` claim: the mandate that was evaluated |
| decision with `verdict` | the verdict token, with `verdict` |
| `allow` / `review` / `deny_limit` / `deny_revoked` | the same codes, plus `deny_velocity`, `deny_category`, `deny_expired`, `deny_no_mandate` |
| review approved → paid | a new `allow` verdict carrying `supersedes: <review jti>` |
| amount / recipient checked against the payment | steps 9–11 |
| one approval pays once | step 12 replay protection |

## What a verdict looks like

A JWT in three base64url parts, `header.payload.signature`. Decoded:

```json
// header
{ "alg": "ES256", "typ": "JWT", "kid": "verdict-2026-09" }
// payload
{
  "iss": "https://verdicts.saifuro.com",
  "jti": "dec_5b2e",
  "iat": 1788424980,
  "exp": 1788425280,
  "verdict": "allow",
  "mandate": "mnd_7f3a",
  "policy_version": "pol_2026-08-12.1",
  "nonce": "n_9d02c6e4",
  "request": { "agent": "agt_procurement_01", "amount": 340, "currency": "USD",
               "recipient": "vendor:acme_saas", "category": "saas" }
}
```

It is signed with ES256 (ECDSA on the P-256 curve) by a key published in Saifuro's JWK Set at
`https://verdicts.saifuro.com/.well-known/jwks.json`. It expires 5 minutes after issue.

## Using it

```ts
import { remoteKeySet } from "./verdict/keys.js";
import { MemoryReplayStore } from "./verdict/replay.js";
import { verifyForSettlement } from "./verdict/verify.js";

const config = {
  issuers: {
    "https://verdicts.saifuro.com": remoteKeySet("https://verdicts.saifuro.com/.well-known/jwks.json"),
  },
  audience: null, // or your identifier, if verdicts may carry `aud`
};
const replayStore = new MemoryReplayStore(); // single process only; see step 12

const result = await verifyForSettlement(token, config, {
  payment: { amount: "340.00", currency: "USD", recipient: "vendor:acme_saas" },
  agreedMandates: ["mnd_7f3a"], // mandate ids the paying operator agreed with you
  testingOnly: false,
  replayStore,
});

if (result.valid) settle(result.verdict);
else console.log(`rejected at step ${result.step}: ${result.reason}`);
```

Every rejection names the step that rejected it and why, e.g.
`{ valid: false, step: 9, reason: "amount 340 does not equal the payment's 340.50" }`.

## The twelve steps, and why each exists

A JWT library such as `jose` does part of steps 1, 2, 4, 5 and 7 when configured with the right
algorithm, issuer and clock tolerance. The draft is explicit that steps 3, 6, 8, 9, 10, 11 and 12
are the relying party's own code. This verifier uses `jose` only for the signature itself (step 5)
and does every other step explicitly, including the parts of 1, 2 and 4 that libraries are lenient
about.

### 1. Parse
Bound the token's size (11,000 characters) and the JSON nesting depth. Exactly three segments, each
**unpadded base64url**: reject `=` padding, whitespace, `+` or `/`, and a length of 1 mod 4. Decode
as UTF-8 and reject invalid bytes. Header and payload must be JSON objects with **no duplicate
member names at any depth**.

*Why:* many base64 decoders accept padding and whitespace, and `JSON.parse` silently keeps the *last*
of two duplicate members. If two parts of a system parse the same bytes differently (one sees the
first `recipient`, another the second), an attacker can make the verified value differ from the
used value. The custom parser (`json.ts`) rejects duplicates and keeps numbers as their literal
text for step 9.

### 2. Header
`alg` exactly `"ES256"` (not `es256`, not `none`, not `HS256`); no `crit`; `kid` a non-empty string;
reject `jku`, `jwk`, `x5u`, `x5c`.

*Why:* classic JWT attacks. `alg: none` means "no signature". `HS256` with the public key as the HMAC
secret makes a forgeable token. `jwk`/`jku` let the *token* supply the key that verifies it, so an
attacker signs with their own key. Keys must only come from the verifier's configuration.

### 3. Environment
Reject a `kid` starting with `sandbox-` unless the verifier is used only for testing.

*Why:* Saifuro's test environment signs with keys published in the same JWK Set. Anyone with a test
account can get a correctly signed test `allow` for any recipient and amount; it must never count as
a production approval.

### 4. Issuer and key
`iss` must exactly equal a configured issuer (case-sensitive, no trailing-slash tolerance). Look up
`kid` **only in that issuer's key set**, never across all configured sets. It must appear exactly
once; if absent, refetch the set once, rate-limited. The key must be EC P-256, with `alg` ES256 and
`use` sig if those members are present.

*Why:* if keys from several issuers were pooled, a token claiming issuer A could be signed with
issuer B's key. A `kid` listed twice is ambiguous, and libraries differ on which one they pick. The
refetch handles key rotation; the rate limit stops made-up `kid`s from hammering the issuer.

### 5. Signature
Exactly 64 bytes (R‖S, not DER); R and S in [1, n−1] where n is the P-256 group order; the public key
must be a point on the curve; then `jose`'s `flattenedVerify` checks the signature. High-S signatures
are accepted.

*Why:* an all-zero signature verified any message in Java's ECDSA (CVE-2022-21449); keys off the
curve enable invalid-curve attacks. Rejecting high S would reject about half of genuine verdicts,
because Saifuro doesn't normalize S. (In testing, `jose` and OpenSSL already reject the bad cases
here; the explicit checks are defense in depth in case a library changes.)

### 6. Token kind and structure
Not an event token (no `type` claim, `jti` not starting `evt_`). Required claims with the right
types: `iat`/`exp` integers with `exp > iat`; non-empty strings for `jti`, `verdict`,
`policy_version`, `nonce`; `request` an object whose `agent`, `currency`, `recipient`, `category` are
non-empty strings and `amount` a number greater than zero. An `allow` must name a `mandate`;
`supersedes` only on an `allow`. If `aud` is present it must name this verifier.

*Why:* Saifuro's webhook events are signed with the same key under the same issuer. Without this
step, a forwarded event containing `"verdict": "allow"` could pass for a verdict.

### 7. Time
With 60 s of clock skew: reject at or after `exp + 60`, if `iat` is more than 60 s in the future, or
before `nbf − 60`.

*Why:* a verdict is an approval for a 5-minute settlement window, not a permanent permission.

### 8. Decision and operator
`verdict` must be exactly `"allow"`, and `mandate` must be one of the mandate ids **the operator
whose funds you are drawing on** agreed with you.

*Why:* any Saifuro customer can create a mandate that allows any recipient and amount, and get a
genuine signed `allow` for it. The signature proves Saifuro evaluated *some* mandate, not that *your
counterparty* authorized this payment. Pinning agreed mandate ids closes that.

### 9. Amount
Compare `request.amount` with the payment record **by decimal value** (`340` equals `340.00`), read
from the literal digits in the payload, never as a float. Amounts the issuer would never write
(exponent notation, more than 15 digits before the point or 6 after) are rejected *before* any
conversion.

*Why:* JSON numbers are usually parsed as binary64 floats, and above 2^33,
`8589934592.000001` and `8589934592.000002` are the same float. A verdict for one amount would
then "match" a payment of another. And a literal like `1e400000` can make some decimal libraries
allocate enormous memory. `decimal.ts` compares with `BigInt` after checking the form.

### 10. Currency
Exactly equal, case-sensitive: `USD` ≠ `usd`.

### 11. Recipient
Equal **code point for code point**: no Unicode normalization, no trimming, no case folding.

*Why:* every "helpful" normalization is a way for a verdict issued for one payee to match a
different payee: an NFC vs NFD form, a trailing space, a zero-width space, a different case.

### 12. Replay
Reject if the pair `(iss, nonce)` has been accepted before; otherwise record it, **only after every
other step has passed**, in the same atomic operation as acceptance. Also (Section 10.12) record
`(iss, supersedes)` and reject a second `allow` that supersedes the same review.

*Why:* a valid verdict is a bearer token for its lifetime; without a replay store the same approval
could settle twice. The key is a claim value, never the token string, because ECDSA signatures are
malleable: `(R, n−S)` is a second valid signature over the same claims (the "low-S twin" vector).
Recording only after everything passes means a rejected attempt doesn't burn the nonce. The store
must be shared by every instance that can accept verdicts; `MemoryReplayStore` is only correct for a
single process.

## Checking a stored verdict

`verifyRecord()` is for an auditor looking at a stored verdict, for example a refusal, rather than
settling a payment (Section 6.2). It runs steps 1, 2, 4, 5 and 6; step 3 only if test verdicts are
being separated; step 7 against the time the verdict was *received*, if that was recorded, otherwise
not at all; and never steps 8–12. It never refetches keys: a `kid` missing from the stored copy of the
key set is a failure, since a refetch would verify against today's keys rather than the ones the
record keeper stored.

## Files

```text
apps/api/src/verdict/
├── verify.ts          the 12 steps; verifyForSettlement() and verifyRecord()
├── json.ts            strict JSON parser: rejects duplicates, bounds depth, keeps numbers as text
├── decimal.ts         sign without expansion, issuer-form check, exact BigInt comparison
├── keys.ts            KeySetProvider: staticKeySet(), remoteKeySet() (HTTPS only, no redirects,
│                      size and time bounds, 5-minute cache, 30-second unknown-kid rate limit)
├── replay.ts          ReplayStore interface and the in-process MemoryReplayStore
├── vectors.ts         runs one test vector exactly as the vectors page configures it
└── vectors-report.ts  CLI report: pnpm --filter @agent-spend-tracer/api verdict:vectors
apps/api/test/
├── verdict.test.ts    every vector as a test, plus replay, store, parser and key-set tests
└── fixtures/saifuro/  the vectors file, unmodified, with its source and SHA-256 in SOURCE.md
```

## The test vectors

Saifuro publishes 138 vectors: tokens with known answers for each step, signed with published test
keys (issuers `https://issuer.example` and `https://issuer-b.example`; never use these keys for real
payments). Each vector says which step should reject it, if any.

```text
$ pnpm --filter @agent-spend-tracer/api verdict:vectors
PASS  settle appendix-a
PASS  settle appendix-a-low-s-twin
...
PASS  record record-verdict-empty

138/138 pass (valid matches expected); accepts 24/24, rejects 114/114;
0 rejected at a different step than expected
```

### Each custom check is necessary

To check the checks, each was removed in turn and the vectors were re-run:

| Check removed | Vectors that then fail |
|---|---|
| sandbox- kid (step 3) | sandbox-key-production, record-test-verdict |
| decimal amounts, replaced by float comparison (step 9) | amount-binary64-collision |
| issuer-form check (step 9) | amount-form-seven-decimals, amount-form-sixteen-digits |
| exact recipient, replaced by NFC + trim + lowercase (step 11) | recipient-normalization, -trailing-space, -zero-width, -case |
| case-sensitive currency (step 10) | currency-case |
| replay store (step 12) | replayed-nonce, low-s-twin-replay, replayed-supersedes |
| supersedes in the replay key (§10.12) | replayed-supersedes |
| strict base64url (step 1) | segment-padded |
| no refetch for stored verdicts (§6.2) | record-key-not-in-copy |
| per-issuer key lookup (step 4) | kid-from-other-issuer |

The step-5 range, curve and length checks change nothing in these vectors, because `jose` and
OpenSSL also reject those inputs; they are kept as a backstop. This exercise also found a real bug,
since fixed: without the form check, `1e400000` crashed the verifier instead of being rejected.

### The page's sample code, for comparison

The verify page shows a short `jose` sample and says it is "a starting point, not the whole check".
Run against the 125 settlement vectors (with a nonce set added), it gets 94 right. All 31 misses are
tokens it **accepts** that should be rejected, for example a mandate the operator never agreed to,
an `iat` an hour in the future, a zero or negative amount, the float amount collision, an `aud` for
another party, and a second `allow` for the same review. Those are the steps listed above that the
sample leaves to the reader.

## How it would plug into the app

Today the app's own policy decides and pays. With Saifuro in the loop, an agent would present a
verdict with its request, and the API would verify it against the exact payment before sending
USDC:

```text
POST /api/authorize { agentId, amount, recipient, verdictToken }
  ├─ own policy (policy.ts)          → allow / review / deny
  ├─ verifyForSettlement(token, …)   → steps 1–12 against this payment
  │     payment = { amount, currency: "USDC", recipient }
  │     agreedMandates = the operator's mandate ids
  └─ only if both pass → submitPayment (payments.ts)
```

To do that properly it would also need a replay store in the database (shared and persistent,
instead of `MemoryReplayStore`), the verdict stored on the decision so `verifyRecord` can audit it
later, and a "verdict verified" step in the console's trace.
