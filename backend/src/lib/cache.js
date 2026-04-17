/**
 * In-memory TTL cache.
 *
 * IMPORTANT — multi-worker deployments:
 * This process is run clustered (see cluster.js / CLUSTER_WORKERS env var).
 * Each worker has its OWN cache Map — they do not share state.
 * Writes invalidated in one worker remain cached in siblings until TTL expires.
 * For writes that must be globally consistent (permissions, module access,
 * auth sessions), prefer short TTLs and tolerate up to TTL seconds of staleness,
 * or swap this module out for a Redis-backed implementation.
 *
 * Callers should pass explicit short TTLs (≤60s) for anything that must be
 * globally consistent; longer TTLs are fine for tenant config / session data
 * that tolerates brief staleness.
 */

const store = new Map();

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 500;

if (parseInt(process.env.CLUSTER_WORKERS || '1', 10) > 1 && !process.env.REDIS_URL) {
  console.warn(
    '[cache] Running clustered with in-memory cache only — cache state is NOT shared across workers. ' +
    'Writes in one worker take up to TTL seconds to be visible in others. ' +
    'Set REDIS_URL and swap cache.js for a Redis driver when this becomes a problem.'
  );
}

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  // Evict oldest if over limit
  if (store.size > MAX_ENTRIES) {
    const entries = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = entries.slice(0, store.size - MAX_ENTRIES);
    for (const [key] of toRemove) store.delete(key);
  }
}

export const cache = {
  /**
   * Get a cached value. Returns undefined if expired or not found.
   */
  get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  },

  /**
   * Set a value with TTL (default 5 min).
   */
  set(key, value, ttlMs = DEFAULT_TTL_MS) {
    cleanup();
    store.set(key, {
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    });
  },

  /**
   * Delete a specific key.
   */
  del(key) {
    store.delete(key);
  },

  /**
   * Delete all keys matching a prefix.
   */
  invalidate(prefix) {
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  },

  /**
   * Clear all cache.
   */
  clear() {
    store.clear();
  },

  /**
   * Get or set — fetch from cache, or run fn() and cache the result.
   */
  async getOrSet(key, fn, ttlMs = DEFAULT_TTL_MS) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    cache.set(key, value, ttlMs);
    return value;
  },

  /**
   * Stats for monitoring.
   */
  stats() {
    cleanup();
    return { size: store.size, maxEntries: MAX_ENTRIES };
  },
};
