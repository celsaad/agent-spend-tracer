/**
 * Runs the published verdict test vectors (https://docs.saifuro.com/reference/verdict-test-vectors)
 * through the verifier, configured as the vectors page says: the vector's issuers and key sets,
 * the clock pinned to `now` with a 60-second skew, and the vector's payment, mandates, stores and
 * settings.
 */
import { readFileSync } from "node:fs";
import { staticKeySet, type KeySet, type KeySetProvider } from "./keys.js";
import { MemoryReplayStore } from "./replay.js";
import { verifyForSettlement, verifyRecord, type Step, type VerifierConfig } from "./verify.js";

interface Vector {
  id: string;
  description: string;
  token: string;
  issuers: Record<string, string>;
  now: number;
  mode: "settle" | "record";
  audience: string | null;
  expected: { valid: boolean; step: Step | null; note?: string };
  // settle
  payment?: { amount: string; currency: string; recipient: string };
  agreedMandates?: string[];
  seenNonces?: [string, string][];
  seenSupersedes?: [string, string][];
  testingOnly?: boolean;
  // record
  receivedAt?: number | null;
  distinguishTest?: boolean;
  refetchWouldReturn?: string;
}

export interface VectorFile {
  vectors: Vector[];
  keySets: Record<string, KeySet>;
}

export interface VectorResult {
  id: string;
  mode: Vector["mode"];
  expected: Vector["expected"];
  valid: boolean;
  step: Step | null;
  reason?: string;
  /** valid matches expected.valid: the pass criterion ("valid MUST match"). */
  pass: boolean;
  /** step also matches expected.step ("step should"). */
  stepMatches: boolean;
  /** A record check refetched keys, which Section 6.2 forbids. */
  refetched: boolean;
}

export function loadVectors(path: string): VectorFile {
  return JSON.parse(readFileSync(path, "utf8")) as VectorFile;
}

export async function runVector(v: Vector, file: VectorFile): Promise<VectorResult> {
  let refetched = false;
  const issuers: Record<string, KeySetProvider> = {};
  for (const [iss, setName] of Object.entries(v.issuers)) {
    issuers[iss] = staticKeySet(file.keySets[setName]!, () => {
      refetched = true;
      // Settle mode: "a kid that is not in the set stays absent after your one refetch".
      // Record mode: what a forbidden refetch would have returned.
      return file.keySets[v.refetchWouldReturn ?? setName]!;
    });
  }
  const config: VerifierConfig = { issuers, clockSkewSeconds: 60, audience: v.audience, maxJsonDepth: 8 };

  const result =
    v.mode === "settle"
      ? await verifyForSettlement(v.token, config, {
          payment: v.payment!,
          agreedMandates: v.agreedMandates!,
          testingOnly: v.testingOnly!,
          now: v.now,
          replayStore: new MemoryReplayStore([
            ...v.seenNonces!.map(([iss, value]) => ({ kind: "nonce" as const, iss, value })),
            ...v.seenSupersedes!.map(([iss, value]) => ({ kind: "supersedes" as const, iss, value })),
          ]),
        })
      : await verifyRecord(v.token, config, { receivedAt: v.receivedAt ?? null, distinguishTest: v.distinguishTest! });

  const step = result.valid ? null : result.step;
  const reason = result.valid ? undefined : result.reason;
  const recordRefetch = v.mode === "record" && refetched;
  return {
    id: v.id,
    mode: v.mode,
    expected: v.expected,
    valid: result.valid,
    step,
    reason,
    pass: result.valid === v.expected.valid && !recordRefetch,
    stepMatches: step === v.expected.step,
    refetched: recordRefetch,
  };
}

export async function runAll(file: VectorFile): Promise<VectorResult[]> {
  const results: VectorResult[] = [];
  for (const v of file.vectors) results.push(await runVector(v, file));
  return results;
}
