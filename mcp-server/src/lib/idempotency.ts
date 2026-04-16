// ---------------------------------------------------------------------------
// Idempotency key store — Redis-backed when available, in-memory fallback
//
// Agents frequently retry failed requests. For send operations this causes
// duplicate emails. Callers pass an idempotency_key; the first call stores
// the result and subsequent calls with the same key return the cached result
// instead of re-executing the operation.
//
// TTL: 24 hours (matching typical email send retry windows).
// Uses Redis when REDIS_URL is configured; falls back to in-memory storage.
// ---------------------------------------------------------------------------

import { redisGet, redisSet, redisAvailable } from "../clients/redis.js";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TTL_SECONDS = 24 * 60 * 60; // Redis TTL in seconds

interface Entry {
  result: unknown;
  createdAt: number;
}

// Fallback in-memory store (used when Redis is unavailable)
const localStore = new Map<string, Entry>();

// Prune expired entries every hour to avoid unbounded memory growth.
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, entry] of localStore) {
    if (entry.createdAt < cutoff) localStore.delete(key);
  }
}, 60 * 60 * 1000).unref();

/**
 * Check if we already have a cached result for this key.
 * Returns the cached result, or `undefined` if not present / expired.
 */
export async function idempotencyCheck(key: string): Promise<unknown | undefined> {
  // Try Redis first if available
  if (await redisAvailable()) {
    try {
      const cached = await redisGet(key);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      console.warn("[idempotency] Redis read failed, falling back to local:", err);
    }
  }

  // Fallback to in-memory store
  const entry = localStore.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > TTL_MS) {
    localStore.delete(key);
    return undefined;
  }
  return entry.result;
}

/**
 * Store the result for a given idempotency key.
 * Should be called after a successful operation.
 */
export async function idempotencySet(key: string, result: unknown): Promise<void> {
  // Try Redis first if available
  if (await redisAvailable()) {
    try {
      await redisSet(key, JSON.stringify(result), TTL_SECONDS);
      return;
    } catch (err) {
      console.warn("[idempotency] Redis write failed, falling back to local:", err);
    }
  }

  // Fallback to in-memory store
  localStore.set(key, { result, createdAt: Date.now() });
}
