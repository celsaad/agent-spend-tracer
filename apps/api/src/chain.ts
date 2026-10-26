import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAbiItem,
  http,
  nonceManager,
  type Log,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, USDC_ADDRESS } from "./config.js";
import { env } from "./env.js";
import type { TransferLog, TransferSource } from "./indexer.js";
import type { PaymentSender } from "./payments.js";

// A "local account": viem keeps the private key in this process, signs transactions itself and
// sends the signed bytes with eth_sendRawTransaction. (A "JSON-RPC account" would instead ask the
// node to sign, which public RPCs like sepolia.base.org can't do since they don't hold your key.)
//
// nonceManager: every transaction from an address needs the next nonce in sequence. Without a
// manager, viem asks the RPC for it on each send, so two payments sent back to back can both get
// the same nonce before either is mined, and the second is rejected. The manager hands out nonces
// in-process and increments them per send, so concurrent payments don't collide.
export const account = privateKeyToAccount(env.agentPrivateKey, { nonceManager });

// http(): plain JSON-RPC over HTTPS, shared by both clients.
//
// `methods.exclude` makes viem refuse eth_newFilter locally. A filter lives on the one node that
// created it, and behind a load balancer (sepolia.base.org is one) later polls land on other
// nodes and fail with "filter not found". With filters refused, watchContractEvent falls back to
// polling getLogs over the new blocks, which is stateless and works on any node.
const transport = http(env.rpcUrl, { methods: { exclude: ["eth_newFilter"] } });

// viem splits clients by what they can do. A public client only reads (eth_call, simulations,
// receipts); a wallet client signs and sends. Passing `chain` tells viem the chain id to sign
// with (EIP-155 replay protection) and lets it check the RPC is on the chain we expect.
export const publicClient = createPublicClient({ chain, transport });
export const walletClient = createWalletClient({ account, chain, transport });

// erc20Abi is viem's built-in ABI for the standard ERC-20 functions. Because it's typed `as
// const`, viem infers that functionName "balanceOf" takes [address] and returns bigint.
export function getUsdcBalance() {
  return publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
}

export const usdcSender: PaymentSender = {
  address: account.address,

  async send({ to, amount }) {
    // simulateContract runs transfer() with eth_call against the latest block without sending
    // anything. If it would revert (not enough USDC, say), it throws here with the decoded revert
    // reason, before we sign or pay gas. On success it returns `request`, already shaped for
    // writeContract, so what we broadcast is exactly what we simulated.
    const { request } = await publicClient.simulateContract({
      account,
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amount],
    });

    // writeContract encodes the calldata, estimates gas and fees, signs with the local account and
    // broadcasts. It resolves with the hash as soon as the node accepts the transaction; it has
    // not been mined yet.
    return walletClient.writeContract(request);
  },

  async waitForReceipt(hash) {
    // waitForTransactionReceipt polls until the transaction is in a block. It does NOT throw when
    // the transaction reverted onchain: it returns a receipt with status "reverted", so callers
    // check it. It does throw after `timeout`, which only means we stopped waiting.
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return receipt.status;
  },
};

// getAbiItem pulls one entry out of an ABI, keeping its type. getLogs takes a single `event`,
// and with this one viem decodes each log's topics and data into typed `args`.
const transferEvent = getAbiItem({ abi: erc20Abi, name: "Transfer" });

// A mined log always has a block and tx hash; viem types them as nullable only for pending logs.
type TransferEventLog = Log<bigint, number, false, typeof transferEvent, true>;

function toTransferLog(log: TransferEventLog): TransferLog {
  return {
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    from: log.args.from,
    to: log.args.to,
    value: log.args.value,
  };
}

export const usdcTransfers: TransferSource = {
  wallet: account.address,

  getBlockNumber: () => publicClient.getBlockNumber(),

  async getTransfers(fromBlock, toBlock) {
    // getLogs is eth_getLogs: a one-off query over a block range. `args: { from }` works because
    // `from` is an indexed event parameter, so it becomes a topic the node filters on: only the
    // agent's outgoing transfers come back, not every USDC transfer on the chain. `strict: true`
    // drops logs that don't decode cleanly instead of returning them with partial args.
    const logs = await publicClient.getLogs({
      address: USDC_ADDRESS,
      event: transferEvent,
      args: { from: account.address },
      fromBlock,
      toBlock,
      strict: true,
    });
    return logs.map(toTransferLog);
  },

  watchTransfers(fromBlock, onLogs, onError) {
    // watchContractEvent subscribes to an event going forward. Over HTTP there are no push
    // subscriptions, so viem polls every `pollingInterval` (4s by default): it installs a node-side
    // filter (eth_newFilter) and reads changes, or falls back to getLogs if the RPC has no filters.
    // `fromBlock` makes it start right after the backfill so nothing falls in between.
    // (Here filters are switched off on the transport, so it always takes the getLogs route.)
    return publicClient.watchContractEvent({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: account.address },
      fromBlock,
      strict: true,
      onLogs: (logs) => onLogs(logs.map(toTransferLog)),
      onError,
    });
  },

  watchBlocks(onBlock, onError) {
    // watchBlockNumber polls eth_blockNumber and calls back when it changes. Skipped blocks aren't
    // replayed (emitMissed defaults to false); the finality scan only needs the latest head.
    return publicClient.watchBlockNumber({ onBlockNumber: onBlock, onError });
  },
};
