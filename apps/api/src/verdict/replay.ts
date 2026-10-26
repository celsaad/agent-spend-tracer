/** A value that may be accepted only once per issuer (step 12; Section 10.12). */
export interface ReplayKey {
  kind: "nonce" | "supersedes";
  iss: string;
  value: string;
  /** Unix seconds until which the key must be kept. */
  keepUntil: number;
}

/**
 * The store of accepted verdicts. Every verifier instance that could accept the same token must
 * share it, and a verifier that can't reach it must reject (step 12).
 */
export interface ReplayStore {
  /**
   * In one atomic operation: if none of `keys` has been recorded, record them all and return
   * true; otherwise record nothing and return false.
   */
  claim(keys: ReplayKey[], now: number): Promise<boolean>;
}

/**
 * An in-process store. Correct only when a single process is the only place verdicts are
 * accepted; with several instances, back ReplayStore with a shared database instead.
 */
export class MemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, number>();

  constructor(seed: Omit<ReplayKey, "keepUntil">[] = []) {
    for (const key of seed) this.entries.set(MemoryReplayStore.id(key), Infinity);
  }

  private static id(key: Pick<ReplayKey, "kind" | "iss" | "value">) {
    return JSON.stringify([key.kind, key.iss, key.value]);
  }

  async claim(keys: ReplayKey[], now: number): Promise<boolean> {
    // Synchronous from here on, so nothing can interleave between the check and the write.
    for (const [id, keepUntil] of this.entries) if (keepUntil < now) this.entries.delete(id);
    if (keys.some((key) => this.entries.has(MemoryReplayStore.id(key)))) return false;
    for (const key of keys) this.entries.set(MemoryReplayStore.id(key), key.keepUntil);
    return true;
  }
}
