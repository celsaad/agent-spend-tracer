export type Address = `0x${string}`;
export type Hash = `0x${string}`;

/** A single USDC payment made by the agent. */
export interface Spend {
  id: number;
  txHash: Hash;
  to: Address;
  /** USDC amount in base units (6 decimals), as a decimal string to avoid precision loss. */
  amount: string;
  memo: string | null;
  createdAt: string;
}

export interface AgentInfo {
  address: Address;
  chainId: number;
  /** USDC balance in base units (6 decimals), as a decimal string. */
  usdcBalance: string;
}
