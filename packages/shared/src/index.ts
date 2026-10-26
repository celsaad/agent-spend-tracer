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

/**
 * Lifecycle of the USDC transfer for a payable decision:
 * approved → submitted (tx broadcast, hash known) → confirmed | failed
 */
export type PaymentStatus = "approved" | "submitted" | "confirmed" | "failed";

export interface AuthorizeRequest {
  agentId: string;
  /** Human-readable USDC amount, e.g. "1.50" (at most 6 decimal places). */
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
  /** null while the decision isn't payable (denied, or a review still pending). */
  paymentStatus: PaymentStatus | null;
  txHash: Hash | null;
  /** Why the payment failed, when `paymentStatus` is "failed". */
  paymentError: string | null;
}

/** pending: seen in a block that isn't deep enough yet. confirmed: N blocks deep and re-verified. */
export type TransferStatus = "pending" | "confirmed";

/** authorized: matches an approved decision by tx hash, amount and recipient. */
export type TransferAuthorization = "authorized" | "unauthorized";

/** A USDC Transfer event from the agent wallet, as observed onchain. */
export interface Transfer {
  id: string;
  txHash: Hash;
  logIndex: number;
  blockNumber: number;
  blockHash: Hash;
  from: Address;
  to: Address;
  /** USDC amount in base units (6 decimals), as a decimal string. */
  amount: string;
  status: TransferStatus;
  /** null until the transfer is confirmed. */
  authorization: TransferAuthorization | null;
  decisionId: string | null;
  seenAt: string;
}

export interface AgentInfo {
  address: Address;
  chainId: number;
  /** USDC balance in base units (6 decimals), as a decimal string. */
  usdcBalance: string;
}
