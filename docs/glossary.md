# Glossary

Terms used in the code and docs, grouped by area.

## The product

**Agent.** Software that wants to spend money: any HTTP client calling `POST /api/authorize`. In the
database, an agent has a name and a wallet address.

**Operator.** The organization an agent spends on behalf of. Implicit in this app; explicit in
Saifuro, whose verdicts must be under a mandate the operator agreed with you.

**Mandate.** An agent's spending rules: per-payment limit, rolling 30-day limit, review threshold,
allowed recipients. Never edited, only revoked or superseded. The newest one applies.

**Decision.** One evaluated spend request: the policy's verdict plus everything that happened
after (review, payment). The row the trace is built from.

**Verdict.** The policy's answer for a request: `allow`, `review`, `deny_limit`, `deny_recipient`,
`deny_revoked`. In Saifuro's context, also the name of the signed token carrying that answer.

**Review.** A verdict for a request above the review threshold: a human must approve or deny it.
A pending review doesn't reserve budget.

**Rolling 30-day limit.** The most an agent may commit in any 30-day window ending now. Counts
allowed and approved payments that didn't fail.

**Payment status.** What happened to a payable decision's transfer: `approved` → `submitted` →
`confirmed` or `failed`.

**Unauthorized transfer.** A USDC transfer out of the agent wallet that no approved decision
accounts for (no decision with its hash, or one with a different amount or recipient, or one that
was never approved).

**Trace.** The timeline from request to confirmed onchain transfer, shown on the decision page.

## The chain

**Base / Base Sepolia.** Base is an Ethereum layer-2 network built on the OP Stack; Base Sepolia is
its testnet (chain id 84532). Blocks every ~2 seconds.

**Account / address / private key.** An address (`0x` + 40 hex) is controlled by whoever holds its
private key (`0x` + 64 hex). The same key controls the same address on every EVM chain.

**ERC-20.** The standard interface for tokens on EVM chains: `balanceOf`, `transfer`, the
`Transfer` event, and others.

**USDC.** Circle's dollar stablecoin, an ERC-20 contract. On Base Sepolia at
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`. 6 decimals.

**Decimals / base units.** Tokens store integers. USDC has 6 decimals, so 1 USDC = 1,000,000 base
units. `parseUnits` converts "1.5" → 1500000n; `formatUnits` the reverse.

**Gas.** The fee for running a transaction, paid in the native coin (ETH on Base), even when the
transaction only moves USDC. Paid even if the transaction reverts.

**Transaction nonce.** A per-account counter; each transaction from an account must use the next
number. Managed by viem's `nonceManager` in this app. *Not the same thing as the verdict nonce.*

**Calldata / function selector.** The encoded function call inside a transaction. The first 4 bytes
identify the function (`0xa9059cbb` = `transfer(address,uint256)`).

**`eth_call`.** Run a contract function against current state without making a transaction. Used by
`readContract` and `simulateContract`.

**Simulation.** An `eth_call` of the exact transaction about to be sent, to learn whether it would
revert and why, before paying gas.

**Revert.** A contract refusing a call (e.g. insufficient balance). A reverted transaction is still
mined, still costs gas, changes nothing else, and emits no events.

**Mempool.** Where broadcast transactions wait to be included in a block.

**Receipt.** The node's record of a mined transaction: block, gas used, `status`
(`success` / `reverted`), logs.

**Log / event.** Data a contract emits during a transaction, e.g. `Transfer(from, to, value)`.
Indexed parameters become **topics** that nodes can filter on.

**`getLogs`.** Query logs in a block range (`eth_getLogs`). Deterministic for final blocks.

**Node-side filter.** `eth_newFilter` + `eth_getFilterChanges`: the node remembers a cursor for you.
Fragile behind load balancers.

**Confirmations.** How many blocks a transaction is under, counting its own block. `H − B + 1` for a
transaction in block `B` when the newest block is `H`.

**Reorg (reorganization).** The most recent blocks being replaced by a different version, undoing
transactions only in the replaced blocks. Why "confirmed" waits for depth.

**Finality.** The point after which a block can't be reorged. On Base, tied to Ethereum L1 finality
(minutes). viem exposes it as the `"finalized"` block tag.

**RPC / JSON-RPC.** The HTTP API nodes expose (`eth_call`, `eth_sendRawTransaction`, …). viem talks
to it through a *transport*.

**Block explorer.** A website showing chain data: here <https://sepolia.basescan.org>.

## viem

**Public client.** Read-only client: calls, simulations, logs, receipts, block numbers.

**Wallet client.** Client that can sign and send transactions; needs an account.

**Local account.** An account whose private key is in your process; viem signs locally.

**Transport.** How a client reaches the node; here `http(url)`.

**ABI.** A contract's interface description. `erc20Abi` is viem's built-in, typed ERC-20 ABI.

## The indexer

**Live watch.** `watchContractEvent` polling for new Transfer events; records them as `pending`.

**Finality scan.** `getLogs` over ranges that are now N blocks deep; the authoritative pass that
confirms, matches and flags.

**Checkpoint.** The last block the finality scan has completed, stored in `indexer_state`. Where a
restart resumes.

**Backfill.** Scanning the blocks mined while the indexer wasn't running.

## Saifuro verdicts

**Signed verdict.** A JWT (ES256) from Saifuro recording one payment evaluation, verifiable with its
public key.

**JWT / JWS.** JSON Web Token: `header.payload.signature`, base64url-encoded. JWS is the signing format
underneath.

**JWK Set (JWKS).** A JSON document listing public keys, each with a `kid` (key id).

**`kid`.** Which key signed the token. Saifuro's test keys start with `sandbox-`.

**ES256.** ECDSA signatures on the P-256 curve with SHA-256; a 64-byte R‖S signature.

**High S / low S.** For any ECDSA signature (R, S), (R, n − S) is also valid. Why replay protection
keys on a claim, not the token string.

**Verdict nonce.** A random value in each verdict; seeing it twice means a replay. *Not the
transaction nonce.*

**`supersedes`.** On an `allow` that approves a review, the `jti` of that review. A second `allow`
superseding the same review must be refused.

**Relying party.** Whoever verifies a verdict and settles the payment.

**Test vectors.** Tokens with known correct answers, published by Saifuro to test verifiers.
