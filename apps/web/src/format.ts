import { formatUnits } from "viem";
import type { Decision } from "@agent-spend-tracer/shared";

const EXPLORER = "https://sepolia.basescan.org";
export const explorer = {
  tx: (hash: string) => `${EXPLORER}/tx/${hash}`,
  block: (n: number) => `${EXPLORER}/block/${n}`,
  address: (a: string) => `${EXPLORER}/address/${a}`,
};

// The viewer's locale throughout, so amounts and dates agree on separators.
const usdcFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** Base units (6 decimals) → "1,234.50". formatUnits keeps it exact; only display rounding is Intl's. */
export function usdc(baseUnits: string | bigint): string {
  return usdcFormat.format(Number(formatUnits(BigInt(baseUnits), 6)));
}

export const short = (hex: string, chars = 4) => `${hex.slice(0, 2 + chars)}…${hex.slice(-chars)}`;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
export const dateTime = (iso: string) => timeFormat.format(new Date(iso));

export type Tone = "neutral" | "info" | "warn" | "pos" | "neg";

const DENY_REASONS = {
  deny_limit: "Over limit",
  deny_recipient: "Recipient not allowed",
  deny_revoked: "Mandate revoked",
} as const;

/** One label for where a decision stands, combining the policy verdict and the payment. */
export function decisionStatus(d: Decision): { label: string; tone: Tone; detail?: string } {
  if (d.verdict !== "allow" && d.verdict !== "review") {
    return { label: "Denied", tone: "neg", detail: DENY_REASONS[d.verdict] };
  }
  if (d.deniedAt) return { label: "Rejected", tone: "neg", detail: "By reviewer" };
  if (d.verdict === "review" && !d.approvedAt) return { label: "Needs review", tone: "warn" };
  switch (d.paymentStatus) {
    case "submitted":
      return { label: "Submitted", tone: "info", detail: "Awaiting confirmations" };
    case "confirmed":
      return { label: "Confirmed", tone: "pos" };
    case "failed":
      return { label: "Failed", tone: "neg", detail: d.paymentError ?? undefined };
    default:
      return { label: "Approved", tone: "neutral" };
  }
}
