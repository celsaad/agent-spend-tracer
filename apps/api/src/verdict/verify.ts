/**
 * Verifies signed authorization verdicts as draft-dias-agent-payment-verdicts-00 Section 6
 * describes, for Saifuro (https://docs.saifuro.com/reference/verify-a-verdict) or any issuer of
 * the same format.
 *
 * jose verifies the ES256 signature (step 5). Everything a JWT library leaves to the relying
 * party is done here: strict segment and JSON parsing, rejecting sandbox- kids, key-set checks,
 * token structure, decimal-safe amount comparison, exact currency and recipient matching, and
 * replay protection. Steps run in the draft's order and each rejection names its step.
 */
import { flattenedVerify, importJWK, type JWK } from "jose";
import { decimalEquals, isIssuerForm, parseDecimal, signOf } from "./decimal.js";
import { isObject, JsonNumber, parseJson, type JsonObject, type JsonValue } from "./json.js";
import type { KeySetProvider } from "./keys.js";
import type { ReplayStore } from "./replay.js";

export type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export type VerifyResult = { valid: true; verdict: VerifiedVerdict } | { valid: false; step: Step; reason: string };

export interface VerifiedVerdict {
  kid: string;
  iss: string;
  jti: string;
  iat: number;
  exp: number;
  verdict: string;
  mandate?: string;
  supersedes?: string;
  policyVersion: string;
  nonce: string;
  request: {
    agent: string;
    /** The amount exactly as written in the token. */
    amount: string;
    currency?: string;
    recipient: string;
    category: string;
  };
  /** The full verified payload, numbers as JsonNumber. */
  payload: JsonObject;
}

export interface VerifierConfig {
  /** Accepted issuer identifiers, each with its own key set. Keys are never shared across issuers. */
  issuers: Record<string, KeySetProvider>;
  /** Clock skew allowance L, at most 60 seconds (step 7). */
  clockSkewSeconds?: number;
  /** Your own identifier for the aud rule of step 6, or null if you have none. */
  audience?: string | null;
  /** Bound on the token length before decoding (step 1). */
  maxTokenLength?: number;
  /** Bound on JSON nesting before the signature is verified (step 1); at least 4. */
  maxJsonDepth?: number;
}

export interface SettleOptions {
  /** Your payment record, already in the unit agreed with the operator and the issuer's currency form. */
  payment: { amount: string; currency: string; recipient: string };
  /** Mandate ids the operator whose funds this payment draws on agreed with you (step 8). */
  agreedMandates: readonly string[];
  /** True only for a verifier that never protects real payments (step 3). */
  testingOnly: boolean;
  replayStore: ReplayStore;
  /** Unix seconds. Only tests pin this. */
  now?: number;
}

export interface RecordOptions {
  /** When the verdict was received, Unix seconds, or null if that wasn't recorded (step 7). */
  receivedAt: number | null;
  /** Whether the checking party separates test verdicts (step 3). */
  distinguishTest: boolean;
}

class Rejected extends Error {
  constructor(
    readonly step: Step,
    message: string,
  ) {
    super(message);
  }
}
const reject = (step: Step, reason: string): never => {
  throw new Rejected(step, reason);
};

const DEFAULT_SKEW = 60;
// "Verdicts that the deployed implementation issues are shorter than 11,000 characters"; stored
// verdicts from before 2026-10-09 09:12 UTC can be up to about 94,000 (Section 6.2).
const SETTLE_MAX_LENGTH = 11_000;
const RECORD_MAX_LENGTH = 100_000;
const SIGNED_CURRENCY_SINCE = Date.UTC(2026, 9, 9, 9, 12) / 1000;
const DEFAULT_DEPTH = 8;

// P-256 (SEC 2): field prime, curve coefficient b (a = -3), and group order n.
const P256 = {
  p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
  b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
  n: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
};

const toBigInt = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);

// ---------------------------------------------------------------------------------------------
// Step 1: Parse

const SEGMENT = /^[A-Za-z0-9_-]*$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeSegment(segment: string, name: string): Uint8Array {
  // Node's base64url decoder accepts padding, whitespace and the standard alphabet, so the
  // segment is checked before it is decoded.
  if (!SEGMENT.test(segment)) reject(1, `${name}: characters outside unpadded base64url`);
  if (segment.length % 4 === 1) reject(1, `${name}: length is 1 modulo 4`);
  return new Uint8Array(Buffer.from(segment, "base64url"));
}

function parseObject(bytes: Uint8Array, name: string, maxDepth: number): JsonObject {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return reject(1, `${name}: invalid UTF-8`);
  }
  let value: JsonValue;
  try {
    value = parseJson(text, maxDepth);
  } catch (err) {
    return reject(1, `${name}: ${(err as Error).message}`);
  }
  if (!isObject(value)) reject(1, `${name}: not a JSON object`);
  return value as JsonObject;
}

function parse(token: string, maxLength: number, maxDepth: number) {
  if (token.length > maxLength) reject(1, `token longer than ${maxLength} characters`);
  const segments = token.split(".");
  if (segments.length !== 3) reject(1, `expected 3 segments, got ${segments.length}`);
  const [h, p, s] = segments as [string, string, string];
  return {
    segments: { header: h, payload: p, signature: s },
    header: parseObject(decodeSegment(h, "header"), "header", maxDepth),
    payload: parseObject(decodeSegment(p, "payload"), "payload", maxDepth),
    signature: decodeSegment(s, "signature"),
  };
}

// ---------------------------------------------------------------------------------------------
// Step 2: Header

function checkHeader(header: JsonObject): string {
  if (header.alg !== "ES256") reject(2, `alg must be exactly "ES256"`);
  if ("crit" in header) reject(2, "crit is not allowed");
  for (const param of ["jku", "jwk", "x5u", "x5c"]) {
    // Keys never come from the token; carrying one is a reason to reject (a SHOULD).
    if (param in header) reject(2, `${param} is not allowed`);
  }
  if (typeof header.kid !== "string" || header.kid === "") reject(2, "kid must be a non-empty string");
  return header.kid as string;
}

// ---------------------------------------------------------------------------------------------
// Step 4: Issuer and key

async function findKey(
  payload: JsonObject,
  kid: string,
  issuers: Record<string, KeySetProvider>,
  allowRefetch: boolean,
): Promise<{ iss: string; jwk: JWK }> {
  const iss = payload.iss;
  if (typeof iss !== "string") return reject(4, "iss missing or not a string");
  // Exact, case-sensitive match against configuration; hasOwn so "__proto__" etc. can't match.
  if (!Object.hasOwn(issuers, iss)) return reject(4, `issuer ${JSON.stringify(iss)} is not accepted`);
  const provider = issuers[iss]!;

  // Look only in this issuer's set, never the union of all sets.
  let matches = (await provider.current()).keys.filter((k) => k.kid === kid);
  if (matches.length === 0 && allowRefetch) {
    const refetched = await provider.refetch();
    if (!refetched) return reject(4, `kid ${JSON.stringify(kid)} unknown and refetch is rate-limited`);
    matches = refetched.keys.filter((k) => k.kid === kid);
  }
  if (matches.length === 0) return reject(4, `kid ${JSON.stringify(kid)} not in ${iss}'s key set`);
  if (matches.length > 1) return reject(4, `kid ${JSON.stringify(kid)} appears ${matches.length} times in the key set`);

  const jwk = matches[0]!;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") reject(4, "key is not an EC P-256 key");
  if (jwk.alg !== undefined && jwk.alg !== "ES256") reject(4, `key alg is ${jwk.alg}, not ES256`);
  if (jwk.use !== undefined && jwk.use !== "sig") reject(4, `key use is ${jwk.use}, not sig`);
  return { iss, jwk };
}

// ---------------------------------------------------------------------------------------------
// Step 5: Signature

function coordinate(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !SEGMENT.test(value)) return reject(5, `key ${name} is not base64url`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32) return reject(5, `key ${name} is not 32 bytes`);
  return toBigInt(bytes);
}

/** y² = x³ - 3x + b (mod p): the key must be a point on P-256 (Section 3.4 of RFC 8725). */
function assertOnCurve(jwk: JWK) {
  const { p, b } = P256;
  const x = coordinate(jwk.x, "x");
  const y = coordinate(jwk.y, "y");
  if (x >= p || y >= p) reject(5, "key coordinate out of range");
  const mod = (v: bigint) => ((v % p) + p) % p;
  if (mod(y * y) !== mod(x * x * x - 3n * x + b)) reject(5, "key is not a point on P-256");
}

async function checkSignature(segments: { header: string; payload: string; signature: string }, signature: Uint8Array, jwk: JWK) {
  // Exactly 64 bytes of R || S. A DER signature, or one with a leading zero byte dropped, fails
  // here instead of being "repaired".
  if (signature.length !== 64) reject(5, `signature is ${signature.length} bytes, not 64`);
  const r = toBigInt(signature.subarray(0, 32));
  const s = toBigInt(signature.subarray(32));
  // R and S in [1, n-1]: an all-zero signature verified any message in CVE-2022-21449. High S is
  // accepted; the issuer doesn't normalize S.
  if (r < 1n || r >= P256.n || s < 1n || s >= P256.n) reject(5, "R or S outside [1, n-1]");
  assertOnCurve(jwk);

  try {
    // importJWK builds a public key from x and y only, so nothing else in the JWK is trusted.
    // flattenedVerify checks the signature over exactly the header and payload segments we
    // parsed, and `algorithms` pins ES256 from our configuration rather than the token.
    const key = await importJWK({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, "ES256");
    await flattenedVerify(
      { protected: segments.header, payload: segments.payload, signature: segments.signature },
      key,
      { algorithms: ["ES256"] },
    );
  } catch (err) {
    reject(5, `signature invalid: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Step 6: Token kind and structure

const nonEmptyString = (v: JsonValue | undefined): v is string => typeof v === "string" && v !== "";

/** A JSON number whose value is an integer (Section 4.2), as a safe JS integer. */
function integerValue(v: JsonValue | undefined): number | undefined {
  if (!(v instanceof JsonNumber)) return undefined;
  const m = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(v.raw)!;
  const exponent = Number(m[4] ?? 0);
  if (Math.abs(exponent) > 30) return undefined;
  const fraction = m[3] ?? "";
  let digits = BigInt(m[2]! + fraction);
  let scale = fraction.length - exponent;
  for (; scale < 0; scale++) digits *= 10n;
  if (digits % 10n ** BigInt(scale) !== 0n) return undefined;
  const value = Number(digits / 10n ** BigInt(scale)) * (m[1] === "-" ? -1 : 1);
  return Number.isSafeInteger(value) ? value : undefined;
}

function checkStructure(payload: JsonObject, audience: string | null, currencyRequired: boolean) {
  if ("type" in payload) reject(6, "has a type claim: an event token, not a verdict");
  const { jti, iat, exp, verdict, mandate, supersedes, policy_version, nonce, request, aud, nbf } = payload;
  if (!nonEmptyString(jti)) return reject(6, "jti must be a non-empty string");
  if (jti.startsWith("evt_")) reject(6, "jti begins evt_: an event token, not a verdict");

  const iatValue = integerValue(iat);
  const expValue = integerValue(exp);
  if (iatValue === undefined) return reject(6, "iat must be an integer");
  if (expValue === undefined) return reject(6, "exp must be an integer");
  if (expValue <= iatValue) reject(6, "exp must be greater than iat");

  if (!nonEmptyString(verdict)) return reject(6, "verdict must be a non-empty string");
  if (!nonEmptyString(policy_version)) return reject(6, "policy_version must be a non-empty string");
  if (!nonEmptyString(nonce)) return reject(6, "nonce must be a non-empty string");

  if (!isObject(request)) return reject(6, "request must be an object");
  const { agent, amount, currency, recipient, category } = request;
  if (!nonEmptyString(agent)) return reject(6, "request.agent must be a non-empty string");
  if (currencyRequired || currency !== undefined) {
    if (!nonEmptyString(currency)) return reject(6, "request.currency must be a non-empty string");
  }
  if (!nonEmptyString(recipient)) return reject(6, "request.recipient must be a non-empty string");
  if (!nonEmptyString(category)) return reject(6, "request.category must be a non-empty string");
  if (!(amount instanceof JsonNumber)) return reject(6, "request.amount must be a number");
  // Compared with zero from its digits, without converting (1e400000 must not be expanded).
  if (signOf(amount.raw) <= 0) reject(6, "request.amount must be greater than zero");

  if (mandate !== undefined && !nonEmptyString(mandate)) reject(6, "mandate must be a non-empty string");
  if (supersedes !== undefined && !nonEmptyString(supersedes)) reject(6, "supersedes must be a non-empty string");
  if (verdict === "allow" && mandate === undefined) reject(6, "an allow must name a mandate");
  if (supersedes !== undefined && verdict !== "allow") reject(6, "supersedes is only allowed on an allow");

  if (aud !== undefined) {
    const values = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : reject(6, "aud must be a string or array");
    if (audience == null) reject(6, "token has aud but this verifier has no identifier");
    if (!values.includes(audience!)) reject(6, "aud does not name this verifier");
  }
  if (nbf !== undefined && !(nbf instanceof JsonNumber)) reject(6, "nbf must be a number");

  return {
    jti,
    iat: iatValue,
    exp: expValue,
    verdict,
    mandate: mandate as string | undefined,
    supersedes: supersedes as string | undefined,
    policyVersion: policy_version,
    nonce,
    nbf: nbf instanceof JsonNumber ? Number(nbf.raw) : undefined,
    request: { agent, amount: amount.raw, currency: currency as string | undefined, recipient, category },
  };
}

// ---------------------------------------------------------------------------------------------
// Step 7: Time

function checkTime(at: number, skew: number, claims: { iat: number; exp: number; nbf?: number }) {
  if (at >= claims.exp + skew) reject(7, "expired");
  if (claims.iat > at + skew) reject(7, "iat is in the future beyond the skew allowance");
  if (claims.nbf !== undefined && at + skew < claims.nbf) reject(7, "not yet valid (nbf)");
}

// ---------------------------------------------------------------------------------------------
// Steps 1-7, shared by settlement and record checks

interface CommonOptions {
  maxTokenLength: number;
  applyEnvironmentCheck: boolean;
  allowRefetch: boolean;
  currencyRequired: (iat: number) => boolean;
  checkTimeAt: number | null;
}

async function verifyCommon(token: string, config: VerifierConfig, opts: CommonOptions): Promise<VerifiedVerdict> {
  const skew = Math.min(config.clockSkewSeconds ?? DEFAULT_SKEW, 60);
  const maxDepth = Math.max(config.maxJsonDepth ?? DEFAULT_DEPTH, 4);

  const parsed = parse(token, opts.maxTokenLength, maxDepth); // 1
  const kid = checkHeader(parsed.header); // 2
  if (opts.applyEnvironmentCheck && kid.startsWith("sandbox-")) {
    reject(3, "sandbox- key: a test verdict, never a production approval"); // 3
  }
  const { iss, jwk } = await findKey(parsed.payload, kid, config.issuers, opts.allowRefetch); // 4
  await checkSignature(parsed.segments, parsed.signature, jwk); // 5

  // From here every value comes from the payload bytes whose signature step 5 verified.
  const iat = integerValue(parsed.payload.iat);
  const claims = checkStructure(parsed.payload, config.audience ?? null, opts.currencyRequired(iat ?? 0)); // 6
  if (opts.checkTimeAt !== null) checkTime(opts.checkTimeAt, skew, claims); // 7

  const { nbf: _nbf, ...rest } = claims;
  return { kid, iss, ...rest, payload: parsed.payload };
}

async function run(fn: () => Promise<VerifiedVerdict>): Promise<VerifyResult> {
  try {
    return { valid: true, verdict: await fn() };
  } catch (err) {
    if (err instanceof Rejected) return { valid: false, step: err.step, reason: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * Checks a verdict before settling a payment on it: all twelve steps of Section 6. On success
 * the verdict's nonce (and supersedes, if any) has been recorded; a second call with the same
 * token is a replay.
 */
export function verifyForSettlement(token: string, config: VerifierConfig, opts: SettleOptions): Promise<VerifyResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = Math.min(config.clockSkewSeconds ?? DEFAULT_SKEW, 60);

  return run(async () => {
    const v = await verifyCommon(token, config, {
      maxTokenLength: config.maxTokenLength ?? SETTLE_MAX_LENGTH,
      applyEnvironmentCheck: !opts.testingOnly,
      allowRefetch: true,
      currencyRequired: () => true,
      checkTimeAt: now,
    });

    // 8: only an allow, and only under a mandate this operator agreed with us.
    if (v.verdict !== "allow") reject(8, `verdict is ${JSON.stringify(v.verdict)}, not "allow"`);
    if (!opts.agreedMandates.includes(v.mandate!)) reject(8, `mandate ${v.mandate} was not agreed with the operator`);

    // 9: decimal value, from the literal in the verified payload. Reject forms the issuer never
    // writes (exponent, >15 integer digits, >6 decimals) before converting anything.
    if (!isIssuerForm(v.request.amount)) reject(9, `amount ${v.request.amount} is not in the issuer's form`);
    const decimal = (text: string, what: string) => {
      try {
        return parseDecimal(text);
      } catch {
        return reject(9, `${what} is not a plain decimal`);
      }
    };
    const paymentAmount = decimal(opts.payment.amount, "payment record amount");
    if (!decimalEquals(decimal(v.request.amount, "amount"), paymentAmount)) {
      reject(9, `amount ${v.request.amount} does not equal the payment's ${opts.payment.amount}`);
    }

    // 10: exact and case-sensitive.
    if (v.request.currency !== opts.payment.currency) reject(10, "currency does not match the payment");

    // 11: code point for code point; no normalization, case folding or trimming.
    if (v.request.recipient !== opts.payment.recipient) reject(11, "recipient does not match the payment");

    // 12: the (iss, nonce) pair, and (iss, supersedes) per Section 10.12, checked and recorded
    // in one atomic operation, only now that every other step has passed.
    const accepted = await opts.replayStore
      .claim(
        [
          { kind: "nonce", iss: v.iss, value: v.nonce, keepUntil: v.exp + skew },
          ...(v.supersedes
            ? // review expiry (24h) + verdict lifetime and skew (360s) in the deployed implementation
              [{ kind: "supersedes" as const, iss: v.iss, value: v.supersedes, keepUntil: v.exp + 86_400 + 360 }]
            : []),
        ],
        now,
      )
      .catch(() => reject(12, "replay store unavailable"));
    if (!accepted) reject(12, "replay: this verdict (or its superseded review) was already accepted");
    return v;
  });
}

/**
 * Checks a stored verdict as a record (Section 6.2), e.g. for an audit of a refusal: steps 1, 2,
 * 4, 5 and 6, step 3 if test verdicts are separated, and step 7 against the receipt time if one
 * was recorded. Never refetches keys: `config.issuers` must hold the stored copies.
 */
export function verifyRecord(token: string, config: VerifierConfig, opts: RecordOptions): Promise<VerifyResult> {
  return run(() =>
    verifyCommon(token, config, {
      maxTokenLength: config.maxTokenLength ?? RECORD_MAX_LENGTH,
      applyEnvironmentCheck: opts.distinguishTest,
      allowRefetch: false,
      // verdicts issued before signed currency may lack it
      currencyRequired: (iat) => iat >= SIGNED_CURRENCY_SINCE,
      checkTimeAt: opts.receivedAt,
    }),
  );
}
