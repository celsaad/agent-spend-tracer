import { createPublicClient, createWalletClient, erc20Abi, http, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, USDC_ADDRESS } from "./config.js";
import { env } from "./env.js";
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
const transport = http(env.rpcUrl);

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
