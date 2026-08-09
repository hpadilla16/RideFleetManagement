/**
 * Per-tenant rate limiter (PR-2).
 *
 * Layer model:
 *   1. Per-IP guard (in-memory) lives in `public-endpoint-guards.js` and
 *      protects unauthenticated routes from brute-force / abuse.
 *   2. THIS module is the per-tenant layer. It runs AFTER `requireAuth` so
 *      `req.user.tenantId` is populated, and applies a fixed-window
 *      counter in Redis keyed by `rate:tenant:<tenantId>:<minute-bucket>`.
 *
 * Algorithm: fixed 60s window.
 *   - Key: `rate:tenant:<tenantId>:<floor(epoch_seconds / 60)>`
 *   - INCR the counter, set EXPIRE 65s on first hit (the +5s slack lets
 *     clients read the resetAt header without races).
 *   - If counter > limit -> 429 with limit/remaining/reset headers.
 *
 * Tiers (Conservative - Option 1, Hector-approved 2026-05-19):
 *   STANDARD:    5,000 rpm   - small operators
 *   PREMIUM:    15,000 rpm   - mid-market multi-location
 *   ENTERPRISE: 50,000 rpm   - large fleets w/ many concurrent workers
 *
 * Per-tenant override:
 *   If `req.user.tenant?.rateLimitOverride` is present and > 0, it wins
 *   over the tier default. No Prisma migration today - this is a future
 *   hook so we can bump a single tenant without a deploy.
 *
 * Resilience:
 *   - Redis unreachable / errors -> log a warning and ALLOW the request.
 *     We do NOT want a Redis hiccup to take production down.
 *   - SUPER_ADMIN bypasses entirely (internal tooling).
 *   - Missing tenantId (public / guest) bypasses - those routes are
 *     covered by the per-IP guard.
 *
 * Tuning:
 *   Edit TIER_LIMITS below, or push a tenant-level override into
 *   `req.user.tenant.rateLimitOverride` (Tenant model field - add the
 *   migration when needed).
 */

import logger from '../lib/logger.js';
// Prisma is imported lazily inside getPrisma() so this module can be unit-tested
// without spinning up the Prisma client (which requires platform-matching
// query-engine binaries).
import { cache } from '../lib/cache.js';
import { tenantKey } from '../lib/cache/tenantKey.js';

const TIER_LIMITS = {
  STANDARD: 5000,
  PREMIUM: 15000,
  ENTERPRISE: 50000,
};

const DEFAULT_TIER = 'STANDARD';
const WINDOW_SECONDS = 60;
const KEY_TTL_SECONDS = 65; // 60s window + 5s slack
const TENANT_TIER_CACHE_TTL_MS = 60 * 1000; // 1 min - tier changes are rare
const REDIS_URL = process.env.REDIS_URL || '';

// Hard timeout for Redis ops on the request path. A managed-Redis maintenance/
// failover (DigitalOcean fleet-cache-prod, 2026-06-20) left the singleton
// ioredis client reconnecting in a loop; `incr` then HUNG rather than rejecting
// — it only rejects on a hard error, not on a slow/flapping connection. Result:
// every non-SUPER_ADMIN request stalled inside this middleware until the socket
// finally gave up, i.e. a site-wide stall for regular users (super-admin is
// bypassed above, which is why the outage looked selective). We now race every
// Redis op against a short timeout and fail OPEN (allow the request), exactly as
// we already do on an explicit Redis error. Tunable via env for ops.
const REDIS_OP_TIMEOUT_MS = Number(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS) || 75;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label || 'redis op'} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let redisClient = null;
let redisLoading = null;
let redisDisabled = false;

let prismaClient = null;
async function getPrisma() {
  if (prismaClient) return prismaClient;
  const mod = await import('../lib/prisma.js');
  prismaClient = mod.prisma;
  return prismaClient;
}

/**
 * Lazy-load ioredis. Same pattern as backend/src/lib/queue/index.js so we
 * don't pay the import cost on processes that never hit an authed route.
 *
 * Returns null on any failure - callers MUST treat null as "skip rate limit
 * check, allow the request".
 */
async function getRedis() {
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
        logger.warn('[tenant-rate-limit] redis connection error', { message: err.message });
      });
      redisClient = client;
      return client;
    } catch (err) {
      logger.warn('[tenant-rate-limit] failed to load ioredis - rate limiting disabled', {
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

/**
 * Resolve the tenant's tier + override. Cached for 1 minute via the local
 * cache module - tier changes are admin-driven and rare.
 */
async function getTenantLimits(req, resolvePrisma) {
  const preloaded = req.user?.tenant;
  if (preloaded && (preloaded.tier || preloaded.rateLimitOverride)) {
    return {
      tier: preloaded.tier || DEFAULT_TIER,
      override: Number(preloaded.rateLimitOverride) || 0,
    };
  }
  const tenantId = req.user?.tenantId;
  if (!tenantId) return { tier: DEFAULT_TIER, override: 0 };
  const cacheKey = tenantKey(tenantId, 'tenant-rate-limit', 'tier');
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const prismaCli = await resolvePrisma();
    const row = await prismaCli.tenant.findUnique({
      where: { id: tenantId },
      select: { tier: true },
    });
    const result = {
      tier: row?.tier || DEFAULT_TIER,
      override: 0,
    };
    cache.set(cacheKey, result, TENANT_TIER_CACHE_TTL_MS);
    return result;
  } catch (err) {
    logger.warn('[tenant-rate-limit] failed to load tenant tier - defaulting to STANDARD', {
      tenantId,
      message: err.message,
    });
    return { tier: DEFAULT_TIER, override: 0 };
  }
}

function limitForTier(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS[DEFAULT_TIER];
}

/**
 * Build the rate-limit middleware. Accepts a `deps` object so the test
 * shim can inject a Map-backed Redis stand-in.
 *
 * deps:
 *   - getRedis: async () => RedisClient | null
 *   - now:      () => epoch ms (for deterministic tests)
 *   - prisma:   prisma client (used only if tenant tier isn't preloaded)
 */
export function createTenantRateLimit(deps = {}) {
  const _getRedis = deps.getRedis || getRedis;
  const _now = deps.now || (() => Date.now());
  // Lazy prisma resolver - test deps short-circuit; prod resolves the
  // real client only when we actually need to look up a tenant tier.
  const _resolvePrisma = deps.prisma
    ? async () => deps.prisma
    : getPrisma;

  return async function tenantRateLimit(req, res, next) {
    try {
      // Bypass: SUPER_ADMIN (internal tooling, ops, debugging)
      if (req.user?.role === 'SUPER_ADMIN') return next();

      // Bypass: no tenant context (public / guest routes - already covered
      // by per-IP guard in public-endpoint-guards.js).
      const tenantId = req.user?.tenantId;
      if (!tenantId) return next();

      const client = await _getRedis();
      if (!client) {
        // Redis unavailable - graceful degradation.
        return next();
      }

      const { tier, override } = await getTenantLimits(req, _resolvePrisma);
      const limit = override > 0 ? override : limitForTier(tier);

      const nowMs = _now();
      const epochSeconds = Math.floor(nowMs / 1000);
      const bucket = Math.floor(epochSeconds / WINDOW_SECONDS);
      const key = `rate:tenant:${tenantId}:${bucket}`;
      const resetAtSeconds = (bucket + 1) * WINDOW_SECONDS;
      const resetAt = new Date(resetAtSeconds * 1000).toISOString();

      let count;
      try {
        count = await withTimeout(client.incr(key), REDIS_OP_TIMEOUT_MS, 'rate-limit incr');
        if (count === 1) {
          await withTimeout(client.expire(key, KEY_TTL_SECONDS), REDIS_OP_TIMEOUT_MS, 'rate-limit expire');
        }
      } catch (err) {
        // Fail OPEN on either a hard Redis error OR a timeout (slow/zombie
        // connection). A rate-limit hiccup must never take production down.
        logger.warn('[tenant-rate-limit] redis incr failed/slow - allowing request', {
          tenantId,
          message: err.message,
        });
        return next();
      }

      const remaining = Math.max(0, limit - count);
      res.setHeader('x-tenant-rate-limit-limit', String(limit));
      res.setHeader('x-tenant-rate-limit-remaining', String(remaining));
      res.setHeader('x-tenant-rate-limit-reset', resetAt);

      if (count > limit) {
        logger.warn('[tenant-rate-limit] limit exceeded', {
          tenantId,
          tier,
          limit,
          count,
          path: req.originalUrl || req.url,
        });
        return res.status(429).json({
          error: 'Tenant rate limit exceeded',
          tier,
          limit,
          resetAt,
        });
      }

      return next();
    } catch (err) {
      // Last-resort safety net - never break the request path.
      logger.warn('[tenant-rate-limit] unexpected error - allowing request', {
        message: err.message,
        stack: err.stack,
      });
      return next();
    }
  };
}

// Default export: a middleware bound to the real Redis client / Prisma.
export const tenantRateLimit = createTenantRateLimit();

// Re-export TIER_LIMITS so admin dashboards / tests can introspect.
export { TIER_LIMITS };
