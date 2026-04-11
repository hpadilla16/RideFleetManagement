/**
 * Simple in-memory TTL cache.
 * Suitable for single-instance deployments.
 * For multi-instance, replace with Redis.
 */

const store = new Map();

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 500;

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
