import type { JWK } from "jose";

export interface KeySet {
  keys: JWK[];
}

/** Where a verifier gets one issuer's JWK Set. */
export interface KeySetProvider {
  /** The current copy of the set. */
  current(): Promise<KeySet>;
  /**
   * Fetches the set again because a token named a kid that isn't in it (Section 5.4). Returns
   * null when the rate limit doesn't permit a refetch yet.
   */
  refetch(): Promise<KeySet | null>;
}

/** A fixed copy of a key set that is never refetched, e.g. the stored copy for a record check. */
export function staticKeySet(set: KeySet, onRefetch?: () => KeySet | null): KeySetProvider {
  return {
    current: async () => set,
    refetch: async () => onRefetch?.() ?? set,
  };
}

interface RemoteOptions {
  /** How long a fetched set is used before a scheduled refresh. Saifuro serves max-age=300. */
  maxAgeMs?: number;
  /** Minimum interval between refetches triggered by unknown kids (Section 5.4 recommends 30s). */
  unknownKidIntervalMs?: number;
  /** Upper bound on the response body. */
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Fetches a JWK Set from a URL taken from the verifier's own configuration, never from a token
 * (Section 5.2). It doesn't follow redirects, bounds the response, refreshes on max-age, and
 * rate-limits refetches caused by unknown kids so that made-up kids can't hammer the issuer.
 */
export function remoteKeySet(url: string, opts: RemoteOptions = {}): KeySetProvider {
  const { maxAgeMs = 300_000, unknownKidIntervalMs = 30_000, maxBytes = 64 * 1024, timeoutMs = 5_000 } = opts;
  if (!url.startsWith("https://")) throw new Error("JWK Set must be fetched over HTTPS");

  let cached: { set: KeySet; at: number } | undefined;
  let lastUnknownKidRefetch = -Infinity;

  async function fetchSet(): Promise<KeySet> {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`JWK Set fetch failed: ${res.status}`);
    const body = await res.text();
    if (body.length > maxBytes) throw new Error("JWK Set response too large");
    const set = JSON.parse(body) as KeySet;
    if (!Array.isArray(set?.keys)) throw new Error("JWK Set has no keys array");
    cached = { set, at: Date.now() };
    return set;
  }

  return {
    async current() {
      if (cached && Date.now() - cached.at < maxAgeMs) return cached.set;
      try {
        return await fetchSet();
      } catch (err) {
        // Section 5.4 allows using the last good copy for a while; a caller that needs an alert
        // or a staleness bound wraps this provider.
        if (cached) return cached.set;
        throw err;
      }
    },
    async refetch() {
      if (Date.now() - lastUnknownKidRefetch < unknownKidIntervalMs) return null;
      lastUnknownKidRefetch = Date.now();
      return fetchSet();
    },
  };
}
