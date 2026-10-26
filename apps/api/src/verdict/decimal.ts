/**
 * Exact decimal handling for verdict amounts (draft-dias-agent-payment-verdicts-00, Sections
 * 4.6 and 6 step 9). Amounts can carry 21 significant digits, more than binary64 holds, so they
 * are compared as (integer, scale) pairs and never as floating-point numbers.
 */

/** value = digits × 10^-scale */
interface Decimal {
  digits: bigint;
  scale: number;
}

// The form the issuer writes: under 10^15, at most six fractional digits, no exponent.
const ISSUER_FORM = /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/;
const PLAIN_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const JSON_NUMBER = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE][+-]?[0-9]+)?$/;

/**
 * The sign of a JSON number literal, read from its digits alone. "1e400000" is positive and
 * "0e999999" is zero without either being expanded, which is how step 6 can compare an amount
 * with zero before step 9 has rejected its form.
 */
export function signOf(raw: string): -1 | 0 | 1 {
  const m = JSON_NUMBER.exec(raw);
  if (!m) throw new Error(`not a JSON number: ${raw}`);
  const mantissaIsZero = /^0*$/.test(m[2]! + (m[3] ?? ""));
  if (mantissaIsZero) return 0;
  return m[1] === "-" ? -1 : 1;
}

/** Whether a token's amount literal is in the issuer's form (step 9's SHOULD). */
export const isIssuerForm = (raw: string) => ISSUER_FORM.test(raw);

/** Parses a plain non-negative decimal string, as the issuer writes and payment records hold. */
export function parseDecimal(text: string): Decimal {
  if (!PLAIN_DECIMAL.test(text)) throw new Error(`not a plain decimal: ${JSON.stringify(text)}`);
  const [whole, fraction = ""] = text.split(".");
  return { digits: BigInt(whole! + fraction), scale: fraction.length };
}

/** Equal by decimal value: 340 equals 340.00, and 340 does not equal 340.5. */
export function decimalEquals(a: Decimal, b: Decimal): boolean {
  const scale = Math.max(a.scale, b.scale);
  return a.digits * 10n ** BigInt(scale - a.scale) === b.digits * 10n ** BigInt(scale - b.scale);
}
