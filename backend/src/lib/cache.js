/**
 * In-memory TTL cache with optional Redis pub/sub for cross-worker invalidation.
 *
 * Reads + writes stay LOCAL and SYNCHRONOUS — zero new latency on the hot
 * path. Redis is used only as a fan-out mechanism for `del` / `invalidate` /
 * `clear` events between workers (and across instances). Each worker
 * subscribes to a single channel; on a remote event, the worker applies the
 * same operation to its own in-memory store.
 *
 * Why pub/sub-only (no L2 read-through):
 *   1. Phase 1 + 2 caches are read-hot, write-rare. Sub-millisecond Map.get
 *      is the right thing on the request path.
 *   2. The actual cross-worker problem is stale data after a write — a
 *      worker that didn't run the write still has the old value in its
 *      local Map until TTL expires. Pub/sub fixes exactly that.
 *   3. No breaking change to the cache API (still sync); no change to call
 *      sites; rollout is "set REDIS_URL".
 *
 * Failure mode:
 *   If REDIS_URL is unset, behavior is identical to the previous in-memory-only
 *   implementation. If Redis is configured but unreachable, the local cache
 *   continues to work; remote invalidations simply don't propagate (logged
 *   once on connect failure). The request path never blocks on Redis.
 *
 * Caveats:
 *   - `set` is NOT broadcast. If worker A sets `key` to V1 while worker B
 *     has V0 cached, B keeps serving V0 until its TTL expires (or someone
 *     publishes a del/invalidate for that key). This is intentional — both
 *     V0 and V1 are valid prisma reads at different points; the only
 *     correctness-critical event is "this data is stale" (i.e. invalidation).
 *   - There's a brief race window: between the local `del` and the remote
 *     subscriber processing the event, sibling workers may serve stale
 *     reads. Acceptable trade-off for a TTL-bounded cache.
 */

import { randomUUID } from 'node:crypto';

const store = new Map();
// Tracks in-flight promises for getOrSet coalescing — see the long comment
// on getOrSet() for the rationale. Keyed by cache key, value is the pending
// promise. Always cleared on settlement so we never leave stuck entries.
const inflight = new Map();

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 500;

const PROCESS_ID = randomUUID();
const REDIS_URL = process.env.REDIS_URL || '';
const INVALIDATION_CHANNEL = process.env.REDIS_INVALIDATION_CHANNEL || 'fleet:cache-invalidate';

let redisPub = null;
let redisSub = null;
let redisReady = false;
let redisInitPromise = null;
// When the initial bootstrap fails (DNS / auth / network blip), record when
// so we can throttle retries without spamming connect attempts on every
// publish call. After REDIS_INIT_RETRY_MS, the next publish triggers a
// fresh bootstrap attempt.
let redisInitFailedAt = 0;
const REDIS_INIT_RETRY_MS = 30 * 1000;

// Init Redis lazily on first cache use that wants to publish. Tests and
// dev workflows that don't set REDIS_URL never touch the import; CI without
// Redis stays green.
async function ensureRedis() {
  if (!REDIS_URL) return false;
  if (redisInitPromise) return redisInitPromise;
  // Throttle retries after a recent failure — avoids hot-looping reconnect
  // attempts on every publish() if Redis is misconfigured or unreachable.
  if (redisInitFailedAt && Date.now() - redisInitFailedAt < REDIS_INIT_RETRY_MS) {
    return false;
  }
  redisInitPromise = (async () => {
    try {
      const mod = await import('redis');
      const { createClient } = mod;
      redisPub = createClient({ url: REDIS_URL });
      redisSub = redisPub.duplicate();
      redisPub.on('error', (err) => {
        // Avoid log spam — Redis client retries internally.
        if (redisReady) console.warn('[cache] redis pub error', err?.message);
      });
      redisSub.on('error', (err) => {
        if (redisReady) console.warn('[cache] redis sub error', err?.message);
      });
      await redisPub.connect();
      await redisSub.connect();
      await redisSub.subscribe(INVALIDATION_CHANNEL, handleRemoteEvent);
      redisReady = true;
      redisInitFailedAt = 0;
      const safeUrl = REDIS_URL.replace(/:[^:@/]*@/, ':***@');
      console.log(`[cache] redis pub/sub ready (channel=${INVALIDATION_CHANNEL}, url=${safeUrl})`);
      return true;
    } catch (err) {
      console.warn('[cache] redis init failed; running with local-only invalidation (will retry):', err?.message);
      redisReady = false;
      // CRITICAL: reset state so the next call retries the full bootstrap.
      // Without this, the settled-failed promise is reused forever and
      // pub/sub stays dead even after Redis becomes healthy.
      redisInitPromise = null;
      redisInitFailedAt = Date.now();
      // Best-effort: tear down any half-initialized clients so the retry
      // starts from a clean slate.
      try { if (redisPub) await redisPub.quit().catch(() => {}); } catch {}
      try { if (redisSub) await redisSub.quit().catch(() => {}); } catch {}
      redisPub = null;
      redisSub = null;
      return false;
    }
  })();
  return redisInitPromise;
}

function handleRemoteEvent(message) {
  let evt;
  try {
    evt = JSON.parse(message);
  } catch {
    return;
  }
  // Skip our own publishes — we already applied them locally.
  if (!evt || evt.from === PROCESS_ID) return;
  if (evt.type === 'del' && typeof evt.key === 'string') {
    store.delete(evt.key);
  } else if (evt.type === 'invalidate' && typeof evt.prefix === 'string') {
    for (const key of store.keys()) {
      if (key.startsWith(evt.prefix)) store.delete(key);
    }
  } else if (evt.type === 'clear') {
    store.clear();
  }
}

function publish(event) {
  if (!REDIS_URL) return;
  // Kick off Redis init on first publish; don't block the request path.
  ensureRedis().then(() => {
    if (!redisReady || !redisPub) return;
    redisPub
      .publish(INVALIDATION_CHANNEL, JSON.stringify({ ...event, from: PROCESS_ID }))
      .catch((err) => {
        // Best-effort. Local invalidation already happened.
        if (redisReady) console.warn('[cache] redis publish failed', err?.message);
      });
  });
}

if (parseInt(process.env.CLUSTER_WORKERS || '1', 10) > 1 && !REDIS_URL) {
  console.warn(
    '[cache] Running clustered with in-memory cache only — cache state is NOT shared across workers. ' +
    'Writes in one worker take up to TTL seconds to be visible in others. ' +
    'Set REDIS_URL to enable Redis pub/sub for cross-worker invalidation.'
  );
}

// Eagerly start the Redis connection at module import when REDIS_URL is set
// so the subscriber is ready by the time the first invalidation fires.
// Failures here are logged but never thrown.
if (REDIS_URL) ensureRedis();

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
   * Set a value with TTL (default 5 min). NOT broadcast — see file header.
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
   * Delete a specific key. Broadcast to other workers via Redis pub/sub
   * when REDIS_URL is configured.
   */
  del(key) {
    store.delete(key);
    publish({ type: 'del', key });
  },

  /**
   * Delete all keys matching a prefix. Broadcast to other workers.
   */
  invalidate(prefix) {
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) store.delete(key);
    }
    publish({ type: 'invalidate', prefix });
  },

  /**
   * Clear all cache. Broadcast to other workers.
   */
  clear() {
    store.clear();
    publish({ type: 'clear' });
  },

  /**
   * Get or set — fetch from cache, or run fn() and cache the result.
   *
   * Coalesces concurrent misses on the same key. Without this guard, N VUs
   * hitting an expired/empty key each fire their own fn() in parallel, then
   * race to overwrite each other's cache.set. The 50-VU prod load test on
   * 2026-05-02 surfaced exactly this: with a 15s TTL, every cycle-boundary
   * spawned 50 simultaneous DB queries, so p50 stayed pinned at the
   * uncached fn() latency (~1.2s) and the throughput barely moved (47 ->
   * 53 rps). The thundering herd ate the cache savings.
   *
   * With coalescing, only the first miss runs fn(); subsequent callers
   * with the same key during the in-flight window await the same promise.
   * The inflight entry is cleared on settlement (success or failure) so a
   * thrown fn() doesn't leave a poison promise stuck in the map.
   */
  async getOrSet(key, fn, ttlMs = DEFAULT_TTL_MS) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const value = await fn();
        cache.set(key, value, ttlMs);
        return value;
      } finally {
        // Always clear the inflight slot, even on rejection. Otherwise a
        // failed fn() would deadlock every subsequent caller for that key
        // forever.
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  },

  /**
   * Stats for monitoring. Includes Redis pub/sub readiness when configured.
   */
  stats() {
    cleanup();
    return {
      size: store.size,
      maxEntries: MAX_ENTRIES,
      redis: REDIS_URL
        ? { configured: true, ready: redisReady, channel: INVALIDATION_CHANNEL }
        : { configured: false, ready: false }
    };
  },

  /**
   * Test-only: shut down the Redis clients cleanly. Lets node --test exit
   * without dangling sockets when REDIS_URL is set during a test run.
   */
  async _shutdownForTests() {
    try { if (redisPub) await redisPub.quit(); } catch {}
    try { if (redisSub) await redisSub.quit(); } catch {}
    redisReady = false;
    redisInitPromise = null;
    redisInitFailedAt = 0;
    redisPub = null;
    redisSub = null;
  }
};
