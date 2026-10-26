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

export type Verdict = "allow" | "review" | "deny_limit" | "deny_recipient" | "deny_revoked";

export interface AuthorizeRequest {
  agentId: string;
  /** USDC amount in base units (6 decimals), as a decimal string. */
  amount: string;
  recipient: Address;
}

/** The outcome of one authorization request against the agent's mandate. */
export interface Decision {
  id: string;
  agentId: string;
  mandateId: string;
  /** USDC amount in base units (6 decimals), as a decimal string. */
  amount: string;
  recipient: Address;
  verdict: Verdict;
  createdAt: string;
  /** Set when a held `review` decision is approved. */
  approvedAt: string | null;
}

export interface AgentInfo {
  address: Address;
  chainId: number;
  /** USDC balance in base units (6 decimals), as a decimal string. */
  usdcBalance: string;
}
