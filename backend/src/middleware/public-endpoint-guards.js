import logger from '../lib/logger.js';
// Wave 1 (2026-08-23): the per-IP login limiter is now backed by Redis so a
// brute-forcer cannot get N attempts PER WORKER by having their requests spread
// across the cluster — the fixed-window counter is shared across all workers.
// Redis is loaded through the SAME shared loader as the tenant limiter, and if
// it is unavailable/slow/errors we FALL BACK to the in-process Map below
// (fail-open, never lock everyone out). See lib/redis-client.js.
import { getRedis, REDIS_OP_TIMEOUT_MS } from '../lib/redis-client.js';
import { withTimeout } from '../lib/with-timeout.js';

// Retained for the fail-open fallback path (Redis null/slow/error) and still
// the only store for the idempotency guard.
const rateLimitBuckets = new Map();
const idempotencyBuckets = new Map();

function nowMs() {
  return Date.now();
}

function requestIp(req) {
  // SECURITY (P0): never read X-Forwarded-For directly — its leftmost value is
  // attacker-controlled, so a client could rotate it to dodge the rate limit /
  // forge idempotency keys. With `app.set('trust proxy', 1)` in main.js,
  // Express computes req.ip as the real client IP (rightmost untrusted XFF
  // entry behind our single nginx hop). Without a proxy (local/dev) req.ip is
  // the socket address, so this still works.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function cleanupExpired(map, currentTime) {
  for (const [key, entry] of map.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= currentTime) {
      map.delete(key);
    }
  }
}

export function attachPublicRequestMeta(name = 'public-endpoint') {
  return (req, _res, next) => {
    req.publicRequestMeta = {
      name,
      ip: requestIp(req),
      startedAt: new Date().toISOString()
    };
    next();
  };
}

export function createPublicRateLimitGuard(options = {}, deps = {}) {
  const name = String(options?.name || 'public-endpoint');
  const windowMs = Number.isFinite(options?.windowMs) ? options.windowMs : 60 * 1000;
  const maxRequests = Number.isFinite(options?.maxRequests) ? options.maxRequests : 60;
  // Injectable for tests (Map-backed Redis stand-in + deterministic clock),
  // exactly like createTenantRateLimit. Callers pass only `options`.
  const _getRedis = deps.getRedis || getRedis;
  const _now = deps.now || nowMs;
  // Fixed window in whole seconds (matches the tenant limiter's bucket math so
  // the key scheme reads the same). Guard against a sub-second window rounding
  // to 0, which would make the EXPIRE meaningless.
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));

  function setHeaders(res, count) {
    const remaining = Math.max(0, maxRequests - count);
    res.setHeader('x-public-rate-limit-window-ms', String(windowMs));
    res.setHeader('x-public-rate-limit-limit', String(maxRequests));
    res.setHeader('x-public-rate-limit-remaining', String(remaining));
  }

  function tooMany(res) {
    return res.status(429).json({
      error: `Rate limit exceeded for ${name}. Try again shortly.`
    });
  }

  // In-process fixed window. RETAINED as the fail-open fallback: Redis null,
  // slow, or throwing all land here so a Redis hiccup can never lock everyone
  // out. Per-worker (each worker keeps its own Map) — that is strictly weaker
  // than the shared Redis counter, but weaker-and-up beats fully-open.
  function inProcess(req, res, next) {
    const currentTime = _now();
    cleanupExpired(rateLimitBuckets, currentTime);
    const bucketKey = `${name}:${requestIp(req)}`;
    const existing = rateLimitBuckets.get(bucketKey);
    const bucket = existing && existing.expiresAt > currentTime
      ? existing
      : { count: 0, expiresAt: currentTime + windowMs };
    bucket.count += 1;
    rateLimitBuckets.set(bucketKey, bucket);

    setHeaders(res, bucket.count);
    if (bucket.count > maxRequests) return tooMany(res);
    return next();
  }

  return async (req, res, next) => {
    // CI / test bypass: when RATE_LIMIT_DISABLED=1 the guard becomes a passthrough.
    // Never set this in production — it removes the brute-force protection on auth endpoints.
    if (process.env.RATE_LIMIT_DISABLED === '1') return next();

    let client = null;
    try {
      client = await _getRedis();
    } catch {
      client = null; // getRedis never throws today, but never trust it to.
    }
    // FAIL-OPEN #1: no Redis in this environment → per-worker Map fallback.
    if (!client) return inProcess(req, res, next);

    // Shared fixed window across all workers. Key carries the guard NAME so
    // distinct guards (auth-login vs auth-pin) never share a bucket, the IP so
    // it is per-client, and the bucket index so it rolls over each window.
    const epochSeconds = Math.floor(_now() / 1000);
    const bucket = Math.floor(epochSeconds / windowSeconds);
    const key = `rate:public:${name}:${requestIp(req)}:${bucket}`;

    let count;
    try {
      count = await withTimeout(client.incr(key), REDIS_OP_TIMEOUT_MS, 'public-rate incr');
      if (count === 1) {
        // +5s slack so a client can read the window header without a race, and
        // so the key always outlives its window even under clock skew.
        await withTimeout(client.expire(key, windowSeconds + 5), REDIS_OP_TIMEOUT_MS, 'public-rate expire');
      }
    } catch (err) {
      // FAIL-OPEN #2: hard Redis error OR timeout (slow/zombie connection) →
      // fall back to the in-process limiter. Never 500 / hang the client.
      logger.warn('[public-rate] redis incr failed/slow - falling back to in-process limiter', {
        name,
        message: err?.message,
      });
      return inProcess(req, res, next);
    }

    setHeaders(res, count);
    if (count > maxRequests) return tooMany(res);
    return next();
  };
}

export function createOptionalIdempotencyGuard(options = {}) {
  const name = String(options?.name || 'public-endpoint');
  const windowMs = Number.isFinite(options?.windowMs) ? options.windowMs : 10 * 60 * 1000;

  return (req, res, next) => {
    const headerValue = String(
      req.get('x-idempotency-key')
      || req.get('idempotency-key')
      || ''
    ).trim();
    if (!headerValue) return next();

    const currentTime = nowMs();
    cleanupExpired(idempotencyBuckets, currentTime);
    const bucketKey = `${name}:${requestIp(req)}:${headerValue}`;
    const existing = idempotencyBuckets.get(bucketKey);
    if (existing && existing.expiresAt > currentTime) {
      return res.status(409).json({
        error: `Duplicate idempotency key detected for ${name}.`
      });
    }

    idempotencyBuckets.set(bucketKey, {
      expiresAt: currentTime + windowMs
    });
    next();
  };
}

