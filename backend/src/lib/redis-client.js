/**
 * Shared request-path Redis loader.
 *
 * WHY THIS EXISTS (Wave 1, 2026-08-23): the lazy ioredis loader below had been
 * copy-pasted into middleware/tenant-rate-limit.js AND now the per-IP public
 * guard (middleware/public-endpoint-guards.js) needs the SAME cross-worker
 * client to share a login-rate-limit bucket across workers. lib/with-timeout.js
 * already warns that the timeout helper drifted from being copied twice; the
 * getRedis loader is the next copy that would drift, so both rate limiters now
 * import it from here. (verify-probe-throttle.js and shuttle-tracker.service.js
 * keep their own copies for now — folding those in is a wider change than this
 * wave should carry; tracked as debt.)
 *
 * Returns null on any failure — callers MUST treat null as "Redis unavailable,
 * fail OPEN" (allow the request / fall back to the in-process limiter). A Redis
 * hiccup must never take production down (see the with-timeout.js incident
 * header for the outage this rule comes from).
 */
import logger from './logger.js';

const REDIS_URL = process.env.REDIS_URL || '';

// Hard timeout for Redis ops on the request path. A managed-Redis maintenance/
// failover can leave the singleton ioredis client reconnecting in a loop, where
// `incr` HANGS rather than rejecting; racing every op against this short
// deadline and failing OPEN is what keeps a Redis flap from stalling requests.
// Same env knob + default the tenant limiter has always used, preserved so its
// behavior is byte-identical after the extraction.
export const REDIS_OP_TIMEOUT_MS = Number(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS) || 75;

let redisClient = null;
let redisLoading = null;
let redisDisabled = false;

/**
 * Lazy-load ioredis. Same pattern as backend/src/lib/queue/index.js so we
 * don't pay the import cost on processes that never hit a rate-limited route.
 *
 * Returns null on any failure — callers MUST treat null as "skip Redis, fall
 * back / allow the request".
 */
export async function getRedis() {
  if (redisClient) return redisClient;
  if (redisDisabled || !REDIS_URL) return null;
  if (redisLoading) return redisLoading;
  redisLoading = (async () => {
    try {
      const IORedis = await import('ioredis').then((m) => m.default || m);
      const client = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: 1,    // fail fast on the request path
        enableReadyCheck: false,
        lazyConnect: false,
      });
      client.on('error', (err) => {
        logger.warn('[redis-client] redis connection error', { message: err.message });
      });
      redisClient = client;
      return client;
    } catch (err) {
      logger.warn('[redis-client] failed to load ioredis - Redis-backed limiters disabled', {
        message: err.message,
      });
      redisDisabled = true;
      return null;
    } finally {
      redisLoading = null;
    }
  })();
  return redisLoading;
}

export default getRedis;
