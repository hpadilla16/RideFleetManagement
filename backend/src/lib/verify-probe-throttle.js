/**
 * Verify-probe throttle for GET /api/reservations/smart-lookup (S30 residual).
 *
 * The smart-lookup privacy gate masks non-exact candidates until the caller
 * proves a datum (full last name or exact pickup date). Innovation flagged the
 * residual: a SCRIPTED caller on the service account can brute-force the gate
 * — the default 31-day window at the matcher's ±1-day pickup tolerance means
 * ~10 verifyPickupDate probes cover the space and unmask a candidate matched
 * by name alone.
 *
 * This module is a cheap per-principal counter over FAILED verification
 * attempts (verify params present AND >=1 candidate stayed masked):
 *   - Redis fixed window, same shape as tenant-rate-limit.js:
 *     `rate:verify-probe:<tenantId>:<principal>:<10-min bucket>`.
 *   - After FAILED_VERIFY_LIMIT failures in the window, further verify-param
 *     lookups from that principal get 429 until the bucket rolls.
 *   - Lookups WITHOUT verify params, exact-code lookups, and successful
 *     verifications are never counted or blocked — humans browsing by name
 *     are unaffected; only the probing pattern pays.
 *
 * Resilience (lesson beta.211): every Redis op races a hard timeout and fails
 * OPEN — a slow/zombie Redis must never take smart-lookup down. The cluster
 * runs multiple workers per container, so the counter MUST be shared (Redis),
 * not per-process memory: ~10 probes spread over 4 workers would never trip a
 * local counter.
 *
 * Deliberately does NOT import from tenant-rate-limit.js, so a ship script can
 * stage this workstream without dragging that shared middleware's pending
 * (separate-workstream) changes into the commit. It DOES import
 * isVerifiablePickupDate from reservation-smart-match.js — the two files always
 * ship together, and the alternative was a second copy of the date rule, which
 * is exactly how the throttle and the verifier drifted apart in the first
 * place (2026-08-06).
 */

import logger from './logger.js';
import { withTimeout } from './with-timeout.js';
import { isVerifiablePickupDate } from './reservation-smart-match.js';

/**
 * Did this verify attempt fail? ONE definition, in one place, because the two
 * plausible-looking predicates leave opposite holes and the difference is not
 * visible at the call site.
 *
 * Charge whenever ANY candidate stayed masked — including when another one in
 * the same response verified. That case is not a success, it is the cheapest
 * attack this gate has: a caller who pins one token to a surname they already
 * own and spends the other on a guess. Their own row verifies, the stranger's
 * stays masked, and a "did anything verify?" predicate waves it through for
 * free (QA B2, 2026-08-06 — measured; the guess space is small because the
 * masked stub already discloses the first name and last initial).
 *
 * NOT charged: zero candidates. Tempting, since a verify-carrying code sweep
 * looks like probing — but the same sweep WITHOUT verify params skips this
 * throttle entirely and still returns masked stubs, so charging closes no
 * channel. It does cost: VozIA is a single service account, so the bucket is
 * tenant-wide, and a mistranscribed code (Chloe's most common failure by far)
 * returns zero candidates. Five of those in ten minutes would 429 every honest
 * guest in the tenant — an outage triggered by the exact defect this whole
 * change exists to fix (QA M-B).
 *
 * NOT charged either: an attempt where the datum supplied COULD NOT have
 * verified anything. Since a name-selected candidate ignores the surname (the
 * string that found it cannot prove it), "name search + the caller's real
 * surname" is deterministically unwinnable — and charging it means the honest
 * guest answering the question Chloe just asked burns a slot every time, with
 * the whole voice channel sharing one bucket. Ten of those and the tenant 429s,
 * including the code happy path this work exists to fix (QA, 2026-08-06).
 * There is nothing to rate-limit: a structurally impossible verification
 * returns no information, so the charge buys availability loss and no defense.
 */
export function isFailedVerifyProbe(candidates, verify = {}) {
  if (!Array.isArray(candidates)) return false;
  const rows = candidates.filter(Boolean);
  // A pickup date can prove any candidate; a surname only one the name search
  // did not select.
  // isVerifiablePickupDate, NOT truthiness: a date the verifier will discard
  // ("08/06/2026", "ayer", " ") could never have proved anything, and charging
  // for it also defeats the surname carve-out right below.
  const couldVerify =
    isVerifiablePickupDate(verify.pickupDate) ||
    (Boolean(verify.lastName) && rows.some((c) => c.matchType !== 'name'));
  return couldVerify && rows.some((c) => c.verified === false);
}

const REDIS_URL = process.env.REDIS_URL || '';

// Max FAILED verify attempts per (tenant, principal) per window before 429.
export const FAILED_VERIFY_LIMIT = 10;
// Fixed window: 10 minutes.
export const WINDOW_SECONDS = 600;
// Hard timeout per Redis op on the request path (beta.211 lesson).
const REDIS_OP_TIMEOUT_MS = 75;

let redisClient = null;
let redisLoading = null;
let redisDisabled = false;

/**
 * Lazy-load ioredis (same pattern as tenant-rate-limit.js / queue/index.js).
 * Returns null on any failure — callers MUST treat null as "throttle off".
 */
async function getRedis() {
  if (redisClient) return redisClient;
  if (redisDisabled || !REDIS_URL) return null;
  if (redisLoading) return redisLoading;
  redisLoading = (async () => {
    try {
      const IORedis = await import('ioredis').then((m) => m.default || m);
      const client = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        lazyConnect: false,
      });
      client.on('error', (err) => {
        logger.warn('[verify-probe-throttle] redis connection error', { message: err.message });
      });
      redisClient = client;
      return client;
    } catch (err) {
      logger.warn('[verify-probe-throttle] failed to load ioredis - throttle disabled', {
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
 * Build a throttle instance. `deps` lets tests inject a Map-backed Redis shim
 * and a fixed clock (same contract as createTenantRateLimit):
 *   - getRedis:      async () => RedisClient | null
 *   - now:           () => epoch ms
 *   - limit:         failed attempts allowed per window
 *   - windowSeconds: fixed-window size
 *   - opTimeoutMs:   per-op Redis timeout
 */
export function createVerifyProbeThrottle(deps = {}) {
  const _getRedis = deps.getRedis || getRedis;
  const _now = deps.now || (() => Date.now());
  const limit = deps.limit ?? FAILED_VERIFY_LIMIT;
  const windowSeconds = deps.windowSeconds ?? WINDOW_SECONDS;
  const opTimeoutMs = deps.opTimeoutMs ?? REDIS_OP_TIMEOUT_MS;
  const keyTtlSeconds = windowSeconds + 60; // slack so a blocked caller can read the reset

  function bucketFor(tenantId, principalId, nowMs) {
    const epochSeconds = Math.floor(nowMs / 1000);
    const bucket = Math.floor(epochSeconds / windowSeconds);
    return {
      key: `rate:verify-probe:${tenantId}:${principalId}:${bucket}`,
      resetAtSeconds: (bucket + 1) * windowSeconds,
    };
  }

  return {
    /**
     * Pre-flight check. Returns { blocked, retryAfterSeconds? }.
     * Fail-open: Redis missing/slow/erroring => { blocked: false }.
     */
    async isBlocked({ tenantId, principalId }) {
      try {
        const client = await _getRedis();
        if (!client) return { blocked: false };
        const nowMs = _now();
        const { key, resetAtSeconds } = bucketFor(tenantId, principalId, nowMs);
        const raw = await withTimeout(client.get(key), opTimeoutMs, 'verify-probe get');
        const count = Number(raw) || 0;
        if (count < limit) return { blocked: false };
        return {
          blocked: true,
          retryAfterSeconds: Math.max(1, resetAtSeconds - Math.floor(nowMs / 1000)),
        };
      } catch (err) {
        logger.warn('[verify-probe-throttle] check failed/slow - allowing request', {
          message: err.message,
        });
        return { blocked: false };
      }
    },

    /**
     * Count one failed verification attempt. Never throws (fail-open).
     */
    async recordFailure({ tenantId, principalId }) {
      try {
        const client = await _getRedis();
        if (!client) return;
        const { key } = bucketFor(tenantId, principalId, _now());
        const count = await withTimeout(client.incr(key), opTimeoutMs, 'verify-probe incr');
        if (count === 1) {
          await withTimeout(client.expire(key, keyTtlSeconds), opTimeoutMs, 'verify-probe expire');
        }
        if (count === limit) {
          // Once per window per principal: the NEXT verify-param lookup 429s.
          logger.warn('[verify-probe-throttle] failed-verify limit reached', {
            tenantId,
            principalId,
            count,
            windowSeconds,
          });
        }
      } catch (err) {
        logger.warn('[verify-probe-throttle] record failed/slow - dropping count', {
          message: err.message,
        });
      }
    },
  };
}

// Default instance bound to the real Redis client.
export const verifyProbeThrottle = createVerifyProbeThrottle();
