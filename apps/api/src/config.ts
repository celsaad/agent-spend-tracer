import { baseSepolia } from "viem/chains";
import type { Address } from "@agent-spend-tracer/shared";

export const chain = baseSepolia;

// USDC on Base Sepolia (testnet).
// Source: Circle, "USDC contract addresses"
// https://developers.circle.com/stablecoins/usdc-contract-addresses
export const USDC_ADDRESS: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_DECIMALS = 6;
