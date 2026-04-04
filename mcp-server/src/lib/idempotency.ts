// ---------------------------------------------------------------------------
// Idempotency key store — in-memory with TTL expiry
//
// Agents frequently retry failed requests. For send operations this causes
// duplicate emails. Callers pass an idempotency_key; the first call stores
// the result and subsequent calls with the same key return the cached result
// instead of re-executing the operation.
//
// TTL: 24 hours (matching typical email send retry windows).
// A Redis-backed implementation can replace this module when REDIS_URL is set.
// ---------------------------------------------------------------------------

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface Entry {
  result: unknown;
  createdAt: number;
}

const store = new Map<string, Entry>();

// Prune expired entries every hour to avoid unbounded memory growth.
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, entry] of store) {
    if (entry.createdAt < cutoff) store.delete(key);
  }
}, 60 * 60 * 1000).unref();

/**
 * Check if we already have a cached result for this key.
 * Returns the cached result, or `undefined` if not present / expired.
 */
export function idempotencyCheck(key: string): unknown | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(key);
    return undefined;
  }
  return entry.result;
}

/**
 * Store the result for a given idempotency key.
 * Should be called after a successful operation.
 */
export function idempotencySet(key: string, result: unknown): void {
  store.set(key, { result, createdAt: Date.now() });
}
