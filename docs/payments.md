# Payments with viem

This document explains how the API sends a USDC payment on Base Sepolia, and every
[viem](https://viem.sh) call involved: what it does on the wire, why it is there, and what would
go wrong without it. All of the app's viem code is in one file,
[`apps/api/src/chain.ts`](../apps/api/src/chain.ts); the logic that decides *when* to pay and
records the outcome is in [`apps/api/src/payments.ts`](../apps/api/src/payments.ts).

- [Background: what a USDC payment is](#background-what-a-usdc-payment-is)
- [Setting up: transport, account, clients](#setting-up-transport-account-clients)
- [Decimals and parseUnits](#decimals-and-parseunits)
- [Reading: the balance](#reading-the-balance)
- [Sending a payment](#sending-a-payment)
  - [Step 1: simulateContract](#step-1-simulatecontract)
  - [Step 2: writeContract](#step-2-writecontract)
  - [Step 3: waitForTransactionReceipt](#step-3-waitfortransactionreceipt)
- [How payments.ts uses it](#how-paymentsts-uses-it)
- [How a payment can fail](#how-a-payment-can-fail)
- [A real payment, inspected](#a-real-payment-inspected)
- [Why it is built this way](#why-it-is-built-this-way)

## Background: what a USDC payment is

A few facts about EVM chains make the rest of this document make sense.

- **An account** is an address (`0xe71f…f1ab`) controlled by a private key. Whoever has the key can
  sign transactions from that address. The agent's key is `AGENT_PRIVATE_KEY` in `.env`.
- **USDC is not a native coin.** It is a smart contract (an ERC-20 token) at a fixed address.
  On Base Sepolia it is `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (from
  [Circle's docs](https://developers.circle.com/stablecoins/usdc-contract-addresses), cited in
  `config.ts`). "Your USDC balance" is a number stored inside that contract, keyed by your address.
- **Paying someone USDC** therefore means sending a *transaction to the USDC contract* that calls
  its `transfer(to, amount)` function. The contract subtracts from your balance and adds to theirs.
  No ETH moves to the recipient.
- **Gas.** Every transaction costs a fee paid in the chain's native coin (ETH on Base), even if it
  moves only USDC. That is why the agent wallet needs a little Base Sepolia ETH as well as USDC.
- **The transaction nonce** is a per-account counter: your first transaction has nonce 0, the next
  1, and so on. The chain only accepts them in order and never the same one twice. (This is a
  different thing from the `nonce` claim in Saifuro's verdicts; see the [glossary](glossary.md).)
- **Blocks and receipts.** A sent transaction waits in a mempool until a block includes it
  ("mined"). Base produces a block every ~2 seconds. Once mined, the node can give you a
  **receipt**: which block, how much gas, whether it succeeded or **reverted** (the contract
  refused, e.g. insufficient balance), and the **logs** (events) it emitted.
- **Events.** When `transfer` succeeds, the USDC contract emits a `Transfer(from, to, value)`
  event. The [indexer](indexer.md) reads these to see what actually left the wallet.
- **RPC.** The app talks to the chain through an RPC endpoint (`RPC_URL`, by default the public
  `https://sepolia.base.org`) using JSON-RPC methods like `eth_call` and `eth_sendRawTransaction`.
  viem is the library that builds, signs and sends those requests and decodes the answers.

## Setting up: transport, account, clients

```ts
// chain.ts
export const account = privateKeyToAccount(env.agentPrivateKey, { nonceManager });
const transport = http(env.rpcUrl, { methods: { exclude: ["eth_newFilter"] } });
export const publicClient = createPublicClient({ chain, transport });
export const walletClient = createWalletClient({ account, chain, transport });
```

### `privateKeyToAccount` — a local account

viem has two kinds of accounts:

- A **local account** holds the private key in this process. viem signs transactions itself and
  sends the already-signed bytes with `eth_sendRawTransaction`.
- A **JSON-RPC account** is just an address; viem asks the *node* to sign (`eth_sendTransaction`).
  That only works when the node holds your key, like MetaMask or a local dev node.

A public RPC such as `sepolia.base.org` does not have our key and must never have it, so a backend
that signs on its own uses a local account.

### `nonceManager` — handing out transaction nonces locally

Without a nonce manager, every send asks the RPC "what is my next nonce?"
(`eth_getTransactionCount` with `"pending"`). If two payments are sent back to back, both can ask
before either transaction is visible to the node, both get the same nonce, and the node rejects the
second ("nonce too low" or "replacement transaction underpriced").

viem's `nonceManager` keeps a local counter per address and chain on top of the node's pending
count: each send in this process takes the next number and increments it, so concurrent payments
from this API get consecutive nonces instead of the same one. Its limit: it only coordinates
*this process*. Two servers sharing one key would still collide; the
fix there is one sender process or a shared nonce allocator.

### `http(...)` — the transport

The transport is how requests reach the node: plain JSON-RPC over HTTPS. The
`methods: { exclude: ["eth_newFilter"] }` option makes viem refuse to create *node-side filters*.
That matters for event watching, and is explained in
[indexer.md](indexer.md#why-node-side-filters-are-switched-off). For payments it changes nothing.

### Public client vs wallet client

viem splits clients by capability:

| Client | Can do | Used for |
|---|---|---|
| `publicClient` | read-only calls: `eth_call`, `eth_getLogs`, receipts, block numbers | balance, simulation, receipts, all indexer reads |
| `walletClient` | sign and send transactions (needs an `account`) | `writeContract` |

Splitting them makes it obvious in the code which calls can spend money.

### `chain: baseSepolia`

The `chain` object (from `viem/chains`) carries the chain id (84532), the native currency, and
defaults. Passing it means viem signs transactions for chain 84532 specifically (EIP-155 replay
protection: a signature for Base Sepolia is invalid on any other chain), and checks the RPC is
actually on that chain before sending.

## Decimals and parseUnits

ERC-20 tokens do not store fractional numbers. A token declares a number of **decimals**, and every
amount on chain is an integer count of the smallest unit:

| Token | decimals | 1 token in base units |
|---|---|---|
| USDC | 6 | 1,000,000 |
| ETH (and most ERC-20s) | 18 | 1,000,000,000,000,000,000 |

So "send 1.50 USDC" means calling `transfer(to, 1500000)`. Getting this conversion wrong by one
power of ten means paying 10× too much or too little; using 18 instead of 6 for USDC means a
trillion times.

**`parseUnits(text, decimals)`** converts a human-readable decimal string to base units as a
`bigint`, using string arithmetic:

```ts
parseUnits("1.50", 6)    // 1500000n
parseUnits("0.10", 6)    // 100000n
parseUnits("1.005", 6)   // 1005000n
```

**`formatUnits(value, decimals)`** goes the other way, for display:

```ts
formatUnits(1500000n, 6) // "1.5"
```

### Why never go through a JavaScript number

JavaScript numbers are binary floating point (IEEE 754 binary64). Many decimal fractions have no
exact binary representation:

```js
1.005 * 1e6        // 1004999.9999999999  (not 1005000)
0.1 + 0.2          // 0.30000000000000004
```

`Math.round` would hide this case but not others, and numbers above 2^53 (about 9 × 10^15) cannot
even represent every integer. On chain, amounts are `uint256`: up to about 1.16 × 10^77. So:

- **In** (`app.ts`): the API accepts the amount as a *string* (`"1.50"`), validates it has at most 6
  decimal places (the JSON schema rejects a 7th, because `parseUnits` would silently round it), and
  converts it with `parseUnits` once, at the edge.
- **Stored**: integer base units. The API caps amounts at `Number.MAX_SAFE_INTEGER` base units
  (about 9 billion USDC) so the integer column is always exact.
- **To the chain**: `BigInt(decision.amount)`, a `bigint`, which is what viem requires for `uint256`.
- **Out** (`format.ts` in the web app): `formatUnits`, then locale formatting for display only.

The API also refuses a JSON *number* for the amount (`"amount": 1.5`). By the time a JSON number
reaches our code it has already been parsed into a float, so precision may already be lost.

USDC's decimals are hard-coded as `USDC_DECIMALS = 6` in `config.ts` rather than read from the
contract's `decimals()` function. USDC's decimals are fixed at 6 by Circle on every chain; reading
it at startup and asserting it equals 6 would be a cheap extra safety check.

## Reading: the balance

```ts
publicClient.readContract({
  address: USDC_ADDRESS,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [account.address],
}); // → bigint, e.g. 20000000n (20 USDC)
```

- **`readContract`** makes an `eth_call`: the node runs the function against the latest block and
  returns the result, without creating a transaction. Free, instant, changes nothing.
- **`erc20Abi`** is viem's built-in ABI (the contract's interface description) for the standard
  ERC-20 functions and events. Because it is typed `as const`, TypeScript knows that `balanceOf`
  takes one address and returns a `bigint`; a typo in `functionName` or a wrong argument type is a
  compile error.

This powers the wallet balance in the console header (`GET /api/agent`).

## Sending a payment

`usdcSender.send({ to, amount })` in `chain.ts` does two viem calls, and a third one runs later in
the background.

### Step 1: simulateContract

```ts
const { request } = await publicClient.simulateContract({
  account,
  address: USDC_ADDRESS,
  abi: erc20Abi,
  functionName: "transfer",
  args: [to, amount],
});
```

**What it does on the wire:** an `eth_call` of `transfer(to, amount)` *from the agent's address*,
against the latest block. The node executes the contract code exactly as a real transaction
would, then throws the result away. Nothing is signed, nothing is broadcast, no gas is paid.

**What it gives back:**
- If the call would **revert**, `simulateContract` throws a `ContractFunctionRevertedError`
  carrying the decoded reason. With the unfunded demo wallet, the real message was
  `ERC20: transfer amount exceeds balance`.
- If it would succeed, it returns `result` (what `transfer` returns: `true`) and `request`: the
  exact parameters (address, ABI, function, args, account) ready to pass to `writeContract`.

**Why simulate before you write:**

1. **A revert still costs gas.** If you send a transaction that reverts, it is still mined and the
   sender still pays the fee for the work done, and nothing else happens. Simulating first means
   predictable failures (no balance, a paused contract, a blocked address) cost nothing.
2. **You get a readable reason at the right moment.** A revert inside a mined transaction gives you
   a receipt with `status: "reverted"` seconds later, often without the reason. The simulation
   gives the reason immediately, while you can still return it to the caller. In this app it
   becomes the decision's `paymentError` and the console shows it.
3. **What you send is what you simulated.** Passing `request` straight to `writeContract` means the
   arguments cannot drift between the check and the send.
4. **Nothing is recorded as submitted for a payment that was never going to work.** A failed
   simulation marks the decision `failed` with no transaction hash, which is unambiguous: no USDC
   moved. That lets the [spending policy](spending-policy.md) give the budget back.

**What simulation does *not* guarantee:** it runs against the state of the latest block. Between
the simulation and the block that actually includes the transaction, the state can change; another
transaction could drain the balance first, for example. So a simulated-OK transaction can still
revert, which is why step 3 exists.

### Step 2: writeContract

```ts
return walletClient.writeContract(request); // → transaction hash, e.g. "0x51d7…6e5b"
```

`writeContract` turns the call into a signed transaction and broadcasts it. Concretely, viem:

1. **Encodes the calldata.** The 4-byte function selector of `transfer(address,uint256)`,
   `0xa9059cbb`, followed by the recipient and the amount, each ABI-encoded as 32 bytes.
2. **Fills in the transaction fields:**
   - `to`: the USDC contract (not the recipient!), `value`: 0 (no ETH is sent);
   - `nonce`: from the `nonceManager`;
   - `gas`: an estimate from `eth_estimateGas` (which also executes the call, so a revert would
     fail here too);
   - fees: an EIP-1559 transaction with `maxFeePerGas` and `maxPriorityFeePerGas`, based on the
     current base fee;
   - `chainId`: 84532.
3. **Signs** it with the local account's private key (secp256k1, in-process).
4. **Broadcasts** the signed bytes with `eth_sendRawTransaction`.
5. **Returns the transaction hash** as soon as the node accepts it into its mempool.

The hash is returned **before the transaction is mined**. At that point you know the transaction
exists and its hash, but not whether it will be included or succeed. This is why the API stores the
hash and marks the decision `submitted`, not `paid`.

### Step 3: waitForTransactionReceipt

```ts
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
return receipt.status; // "success" | "reverted"
```

This runs in the background after the HTTP response has been sent (`confirmPayment` in
`payments.ts`). viem polls the node until the transaction appears in a block, then returns the
receipt.

Two behaviors are easy to get wrong:

- **It does not throw when the transaction reverted.** A reverted transaction is still a mined
  transaction with a valid receipt; `receipt.status` is `"reverted"`. Code that only wraps it in
  `try/catch` would treat a failed payment as a success.
- **It does throw on `timeout`**, but a timeout only means *we stopped waiting*. The transaction may
  still be mined later. So on a timeout the app leaves the payment `submitted` (not `failed`), and
  `resumeConfirmations()` re-attaches a watcher at the next startup.

**Why this app does not mark a payment "confirmed" from the receipt.** A receipt means the
transaction is in *a* block, one confirmation deep. Blocks near the tip of the chain can still be
replaced by a reorganization (see [indexer.md](indexer.md#reorgs)), which can drop the
transaction. So the receipt is only used to catch **reverts**, which the indexer could not see
anyway (a reverted `transfer` emits no `Transfer` event). Marking `confirmed` is the indexer's job,
once the event is 5 blocks deep.

## How payments.ts uses it

```text
submitPayment(decision)                         // payments.ts
  agent.walletAddress == sender.address ?       // wallet check, else failed
  hash = sender.send({ to, amount })            // simulate + write   (failed on throw)
  decision ← submitted, txHash, submittedAt
  confirmPayment(decision)   ── not awaited ──▶ waitForReceipt(hash)
  return decision                                  "reverted" → failed
                                                   "success"  → leave it to the indexer
                                                   timeout    → leave submitted, resume on restart
```

### Wallet check

The app has one private key but an agent table that could hold any wallet address. Before sending,
`submitPayment` checks that the decision's agent's `walletAddress` is the address of the configured
key. If not, it marks the payment `failed` with an explanatory error instead of paying from the
wrong wallet. This is what happens to the demo agent created for an older key after you change
`AGENT_PRIVATE_KEY`.

## How a payment can fail

| What happens | Where it is caught | Decision ends as | Did USDC move? |
|---|---|---|---|
| Agent's wallet isn't the configured key | `submitPayment` | `failed`, no hash | No |
| Simulation reverts (no balance, paused contract…) | `simulateContract` throws | `failed`, no hash, reason in `paymentError` | No |
| Not enough ETH for gas, bad nonce, RPC rejects | `writeContract` throws | `failed`, no hash | No |
| RPC accepts but the response is lost (network error) | `writeContract` throws | `failed`, no hash | **Maybe** (see below) |
| Mined but reverted (state changed after simulation) | receipt `status: "reverted"` | `failed` with hash | No (gas was paid) |
| Receipt not seen within 120 s | timeout | stays `submitted` | Unknown yet; resolved later |
| Mined, then reorged out | indexer re-scan doesn't find it | stays `submitted` | No, unless re-included |
| Mined and 5 blocks deep | indexer | `confirmed` | Yes |

**The one uncertain case.** If the node accepted the transaction but the HTTP response never
reached us, viem throws and the decision is marked `failed` with no hash, although the transaction
may be mined. Two things limit the damage: the [indexer](indexer.md) will see the Transfer and flag
it **unauthorized** (no decision has its hash), so it cannot go unnoticed; and the budget it
"freed" is visible in that alert. A production system would record the signed transaction (or its
hash, which can be computed before sending) *before* broadcasting, so this case resolves to
`submitted` instead.

## A real payment, inspected

From the first live run of this app (verified directly on chain, not through the API):

```text
tx            0x51d7beb009d0355efed26fe678c32c84af570714ee3ced1f6b8b06a25ac66e5b
to            0x036cbd53842c5426634e7929541ec2318f3dcf7e     ← the USDC contract
status        success, block 50,484,595
Transfer log  from 0xe71f…f1ab  to 0xe71f…f1ab  value 100000  (0.1 USDC, a self-payment)
gas cost      0.000000224754000094 ETH
```

API timeline for that payment: `submitted` immediately, `confirmed` about 2 seconds later (at that
time confirmation still came from the receipt; now the indexer confirms it about 10 seconds later,
after 5 blocks). It is viewable at
<https://sepolia.basescan.org/tx/0x51d7beb009d0355efed26fe678c32c84af570714ee3ced1f6b8b06a25ac66e5b>.

## Why it is built this way

**Why respond at `submitted` instead of waiting for confirmation?** Confirmation takes ~10 s on
Base Sepolia (5 blocks) and much longer on other chains. Holding an HTTP request open that long
ties up the client and fails badly on timeouts. The payment's state lives in the database; clients
poll it.

**Why is the amount converted at the API edge and not in the policy or payment code?** So there is
exactly one conversion from human input to base units, and everything behind it works in integers.
A conversion in two places is two chances to use the wrong number of decimals.

**Why is the policy check in a database transaction but the payment outside it?** Sending a payment
takes hundreds of milliseconds of network calls. Holding a database write lock that long would
block every other request. The decision is committed first (so the budget is reserved), then the
payment is attempted, and its outcome is written in a second, short transaction.

**Why not use `sendTransaction` with hand-encoded calldata?** `writeContract` with a typed ABI
encodes the call for you and type-checks the function name and arguments. Hand-encoding is how you
end up sending `transfer(amount, to)`.
