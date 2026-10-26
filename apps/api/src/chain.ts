import { createPublicClient, createWalletClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, USDC_ADDRESS } from "./config.js";
import { env } from "./env.js";

export const account = privateKeyToAccount(env.agentPrivateKey);

const transport = http(env.rpcUrl);

export const publicClient = createPublicClient({ chain, transport });
export const walletClient = createWalletClient({ account, chain, transport });

export function getUsdcBalance() {
  return publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
}
