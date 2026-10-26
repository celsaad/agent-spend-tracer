import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJson } from "../src/verdict/json.js";
import { remoteKeySet, staticKeySet } from "../src/verdict/keys.js";
import { MemoryReplayStore } from "../src/verdict/replay.js";
import { loadVectors, runVector } from "../src/verdict/vectors.js";
import { verifyForSettlement } from "../src/verdict/verify.js";

const file = loadVectors(fileURLToPath(new URL("./fixtures/saifuro/verdict-test-vectors.json", import.meta.url)));

describe("Saifuro verdict test vectors", () => {
  it("has all 138 vectors (24 accept, 114 reject)", () => {
    expect(file.vectors).toHaveLength(138);
    expect(file.vectors.filter((v) => v.expected.valid)).toHaveLength(24);
  });

  it.each(file.vectors.map((v) => [v.id, v] as const))("%s", async (_, vector) => {
    const result = await runVector(vector, file);
    expect({ valid: result.valid, step: result.step, refetched: result.refetched }).toEqual({
      valid: vector.expected.valid,
      step: vector.expected.step,
      refetched: false,
    });
  });
});

describe("verifyForSettlement", () => {
  const appendixA = file.vectors.find((v) => v.id === "appendix-a")!;
  const config = { issuers: { "https://issuer.example": staticKeySet(file.keySets.issuer!) }, audience: null };
  const opts = (replayStore: MemoryReplayStore) => ({
    payment: appendixA.payment!,
    agreedMandates: appendixA.agreedMandates!,
    testingOnly: false,
    now: appendixA.now,
    replayStore,
  });

  it("accepts a verdict once and rejects the same token as a replay", async () => {
    const store = new MemoryReplayStore();
    expect((await verifyForSettlement(appendixA.token, config, opts(store))).valid).toBe(true);
    expect(await verifyForSettlement(appendixA.token, config, opts(store))).toMatchObject({ valid: false, step: 12 });
  });

  it("does not record the nonce when a later step fails", async () => {
    const store = new MemoryReplayStore();
    const wrongPayment = { ...opts(store), payment: { ...appendixA.payment!, amount: "341" } };
    expect(await verifyForSettlement(appendixA.token, config, wrongPayment)).toMatchObject({ valid: false, step: 9 });
    expect((await verifyForSettlement(appendixA.token, config, opts(store))).valid).toBe(true);
  });

  it("rejects when the replay store is unreachable", async () => {
    const broken = { claim: () => Promise.reject(new Error("down")) } as unknown as MemoryReplayStore;
    expect(await verifyForSettlement(appendixA.token, config, opts(broken))).toMatchObject({ valid: false, step: 12 });
  });
});

describe("parseJson", () => {
  it.each([
    ['{"a":1,"a":2}', "duplicate"],
    ['{"r":{"x":"a","x":"b"}}', "duplicate"],
    ["[[[[[1]]]]]", "nesting"],
    ['{"a":01}', "expected }"], // leading zero: 0 is read, then 1 is not a valid continuation
  ])("rejects %s", (text, message) => {
    expect(() => parseJson(text, 4)).toThrow(message);
  });

  it("keeps numbers as written", () => {
    expect(parseJson('{"amount":8589934592.000001}', 4)).toEqual({ amount: { raw: "8589934592.000001" } });
  });
});

describe("remoteKeySet", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses redirects and rate-limits refetches for unknown kids", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      return new Response(JSON.stringify(file.keySets.issuer));
    });
    vi.stubGlobal("fetch", fetchMock);
    const keys = remoteKeySet("https://issuer.example/.well-known/jwks.json", { unknownKidIntervalMs: 30_000 });

    await keys.current();
    await keys.current(); // cached
    expect(await keys.refetch()).not.toBeNull();
    expect(await keys.refetch()).toBeNull(); // within 30s of the last unknown-kid refetch
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("only fetches over HTTPS", () => {
    expect(() => remoteKeySet("http://issuer.example/jwks.json")).toThrow("HTTPS");
  });
});
