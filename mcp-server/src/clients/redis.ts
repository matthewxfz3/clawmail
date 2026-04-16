// ---------------------------------------------------------------------------
// Redis client — distributed caching and rate limiting
// Uses redis package (npm install redis) when REDIS_URL is configured
// ---------------------------------------------------------------------------

import { config } from "../config.js";

let redisClient: any = null;
let redisReady = false;

/**
 * Initialize Redis client if REDIS_URL is configured.
 * Returns true if Redis is available, false otherwise.
 */
async function ensureRedis(): Promise<boolean> {
  if (!config.redis.url) return false;
  if (redisReady) return true;

  try {
    // Lazy import redis module (optional dependency)
    let createClient;
    try {
      const redis = await import("redis");
      createClient = redis.createClient;
    } catch {
      console.warn("[redis] module not available - install with: npm install redis");
      return false;
    }

    if (!redisClient) {
      redisClient = createClient({ url: config.redis.url });
      redisClient.on("error", (err: any) => console.error("[redis] error:", err));
      await redisClient.connect();
      redisReady = true;
      console.log("[redis] connected to", config.redis.url);
    }
    return true;
  } catch (err) {
    console.warn("[redis] failed to initialize:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Get a value from Redis (returns null if not found or Redis unavailable).
 */
export async function redisGet(key: string): Promise<string | null> {
  if (!(await ensureRedis())) return null;
  try {
    return await redisClient.get(key);
  } catch (err) {
    console.warn("[redis] get failed for", key, ":", err);
    return null;
  }
}

/**
 * Set a value in Redis with optional TTL (in seconds).
 */
export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  if (!(await ensureRedis())) return;
  try {
    if (ttlSeconds) {
      await redisClient.setEx(key, ttlSeconds, value);
    } else {
      await redisClient.set(key, value);
    }
  } catch (err) {
    console.warn("[redis] set failed for", key, ":", err);
  }
}

/**
 * Delete a key from Redis.
 */
export async function redisDelete(key: string): Promise<void> {
  if (!(await ensureRedis())) return;
  try {
    await redisClient.del(key);
  } catch (err) {
    console.warn("[redis] delete failed for", key, ":", err);
  }
}

/**
 * Increment a counter in Redis (used for rate limiting).
 * Returns the new value.
 */
export async function redisIncr(key: string, ttlSeconds?: number): Promise<number> {
  if (!(await ensureRedis())) return 1; // Fallback: assume within limit
  try {
    const newVal = await redisClient.incr(key);
    if (ttlSeconds && newVal === 1) {
      // Set expiry only on first increment (when new key created)
      await redisClient.expire(key, ttlSeconds);
    }
    return newVal;
  } catch (err) {
    console.warn("[redis] incr failed for", key, ":", err);
    return 1; // Fallback
  }
}

/**
 * Get the TTL of a key in Redis (returns -1 if no expiry, -2 if not found).
 */
export async function redisTTL(key: string): Promise<number> {
  if (!(await ensureRedis())) return -2;
  try {
    return await redisClient.ttl(key);
  } catch (err) {
    console.warn("[redis] ttl failed for", key, ":", err);
    return -2;
  }
}

/**
 * Check if Redis is currently available.
 */
export async function redisAvailable(): Promise<boolean> {
  return await ensureRedis();
}

/**
 * Check and update rate limit counter (used for distributed rate limiting).
 * Returns true if the request is allowed, false if limit exceeded.
 * Uses a simple counter with TTL instead of timestamp sliding window.
 */
export async function checkRateLimitRedis(
  key: string,
  maxPerWindow: number,
  windowSeconds: number,
): Promise<boolean> {
  if (!(await ensureRedis())) return true; // Fallback: allow if Redis unavailable
  try {
    const newVal = await redisIncr(key, windowSeconds);
    return newVal <= maxPerWindow;
  } catch (err) {
    console.warn("[redis] rate limit check failed for", key, ":", err);
    return true; // Fallback: allow on error
  }
}

/**
 * Close the Redis connection (for graceful shutdown).
 */
export async function redisClose(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
      redisReady = false;
      console.log("[redis] connection closed");
    } catch (err) {
      console.warn("[redis] close failed:", err);
    }
  }
}
