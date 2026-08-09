import test from 'node:test';
import assert from 'node:assert/strict';

import { createTenantRateLimit, TIER_LIMITS } from './tenant-rate-limit.js';

/**
 * Minimal Redis shim: backs INCR + EXPIRE with a Map. Optional `fail` flag
 * makes both methods throw, to exercise graceful degradation.
 */
function makeRedisShim({ fail = false } = {}) {
  const store = new Map();
  return {
    store,
    async incr(key) {
      if (fail) throw new Error('shim INCR failure');
      const next = (store.get(key) || 0) + 1;
      store.set(key, next);
      return next;
    },
    async expire(key, _ttl) {
      if (fail) throw new Error('shim EXPIRE failure');
      return store.has(key) ? 1 : 0;
    },
  };
}

function makeRes() {
  const headers = {};
  let statusCode = 200;
  let bodyJson = null;
  return {
    headers,
    get statusCode() { return statusCode; },
    get bodyJson() { return bodyJson; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status(code) { statusCode = code; return this; },
    json(payload) { bodyJson = payload; return this; },
  };
}

function makeReq({ tenantId = 't1', role = 'OPS', tenant = null } = {}) {
  return {
    user: tenantId == null
      ? null
      : { tenantId, role, tenant },
    originalUrl: '/api/foo',
  };
}

// Fixed time so the bucket key is deterministic across all tests.
const FIXED_NOW = 1_700_000_000_000;
const fixedClock = () => FIXED_NOW;

test('below limit calls next() and sets rate-limit headers', async () => {
  const redis = makeRedisShim();
  const mw = createTenantRateLimit({
    getRedis: async () => redis,
    now: fixedClock,
    prisma: { tenant: { findUnique: async () => ({ tier: 'STANDARD' }) } },
  });
  const req = makeReq({ tenantId: 'tenant-a' });
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-tenant-rate-limit-limit'], String(TIER_LIMITS.STANDARD));
  assert.equal(res.headers['x-tenant-rate-limit-remaining'], String(TIER_LIMITS.STANDARD - 1));
  assert.ok(res.headers['x-tenant-rate-limit-reset']);
});

test('at limit returns 429 with tier/limit/resetAt', async () => {
  const redis = makeRedisShim();
  // Pre-fill counter to exactly the limit so the next INCR pushes us over.
  const epochSeconds = Math.floor(FIXED_NOW / 1000);
  const bucket = Math.floor(epochSeconds / 60);
  redis.store.set(`rate:tenant:tenant-b:${bucket}`, TIER_LIMITS.STANDARD);

  const mw = createTenantRateLimit({
    getRedis: async () => redis,
    now: fixedClock,
    prisma: { tenant: { findUnique: async () => ({ tier: 'STANDARD' }) } },
  });
  const req = makeReq({ tenantId: 'tenant-b' });
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.bodyJson.error, 'Tenant rate limit exceeded');
  assert.equal(res.bodyJson.tier, 'STANDARD');
  assert.equal(res.bodyJson.limit, TIER_LIMITS.STANDARD);
  assert.ok(res.bodyJson.resetAt);
});

test('missing tenantId skips the limiter', async () => {
  const redis = makeRedisShim();
  const mw = createTenantRateLimit({
    getRedis: async () => redis,
    now: fixedClock,
    prisma: { tenant: { findUnique: async () => null } },
  });
  // No req.user at all.
  const req = { user: null };
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.headers['x-tenant-rate-limit-limit'], undefined);
  // And nothing was written to redis.
  assert.equal(redis.store.size, 0);
});

test('SUPER_ADMIN bypasses the limiter', async () => {
  const redis = makeRedisShim();
  const mw = createTenantRateLimit({
    getRedis: async () => redis,
    now: fixedClock,
    prisma: { tenant: { findUnique: async () => ({ tier: 'STANDARD' }) } },
  });
  const req = makeReq({ tenantId: 'tenant-c', role: 'SUPER_ADMIN' });
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.headers['x-tenant-rate-limit-limit'], undefined);
  assert.equal(redis.store.size, 0);
});

test('redis incr failure allows the request (graceful degradation)', async () => {
  const redis = makeRedisShim({ fail: true });
  const mw = createTenantRateLimit({
    getRedis: async () => redis,
    now: fixedClock,
    prisma: { tenant: { findUnique: async () => ({ tier: 'STANDARD' }) } },
  });
  const req = makeReq({ tenantId: 'tenant-d' });
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

// Regression for the 2026-06-20 incident: a managed-Redis maintenance left the
// ioredis client reconnecting, so `incr` HUNG (never resolved/rejected) instead
// of erroring. The middleware must race it against the op timeout and fail OPEN
// quickly, not stall the request path.
test('redis incr that HANGS fails open within the timeout (zombie connection)', async () => {
  const hangingRedis = {
    async incr() { return new Promise(() => {}); },   // never settles
    async expire() { return new Promise(() => {}); },
  };
  const mw = createTenantRateLimit({
    getRedis: async () => hangingRedis,
    now: fixedClock,
    prisma: { tenant: { findUnique: async () => ({ tier: 'STANDARD' }) } },
  });
  const req = makeReq({ tenantId: 'tenant-hang' });
  const res = makeRes();
  let nextCalled = false;
  const t0 = Date.now();
  await mw(req, res, () => { nextCalled = true; });
  const elapsed = Date.now() - t0;
  assert.equal(nextCalled, true);        // request allowed (fail-open)
  assert.equal(res.statusCode, 200);     // not blocked, not stalled
  assert.ok(elapsed < 1000, `should fail open quickly, took ${elapsed}ms`);
});

test('redis unavailable (null client) allows the request', async () => {
  const mw = createTenantRateLimit({
    getRedis: async () => null,
    now: fixedClock,
    prisma: { tenant: { findUnique: async () => ({ tier: 'STANDARD' }) } },
  });
  const req = makeReq({ tenantId: 'tenant-e' });
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-tenant-rate-limit-limit'], undefined);
});

test('per-tenant override beats tier default', async () => {
  const redis = makeRedisShim();
  // Override of 2 means the 3rd request in the window should 429,
  // regardless of the STANDARD tier limit (5000).
  const mw = createTenantRateLimit({
    getRedis: async () => redis,
    now: fixedClock,
    prisma: { tenant: { findUnique: async () => ({ tier: 'STANDARD' }) } },
  });
  const tenant = { tier: 'STANDARD', rateLimitOverride: 2 };

  // 1st call: count=1, allowed
  let res = makeRes();
  let n = 0;
  await mw(makeReq({ tenantId: 'tenant-f', tenant }), res, () => { n++; });
  assert.equal(n, 1);
  assert.equal(res.headers['x-tenant-rate-limit-limit'], '2');
  assert.equal(res.headers['x-tenant-rate-limit-remaining'], '1');

  // 2nd call: count=2, still allowed (at the limit, not over)
  res = makeRes();
  await mw(makeReq({ tenantId: 'tenant-f', tenant }), res, () => { n++; });
  assert.equal(n, 2);
  assert.equal(res.headers['x-tenant-rate-limit-remaining'], '0');

  // 3rd call: count=3, over - 429
  res = makeRes();
  await mw(makeReq({ tenantId: 'tenant-f', tenant }), res, () => { n++; });
  assert.equal(n, 2);             // next() NOT called
  assert.equal(res.statusCode, 429);
  assert.equal(res.bodyJson.limit, 2);
});

test('PREMIUM tier uses the PREMIUM limit', async () => {
  const redis = makeRedisShim();
  const mw = createTenantRateLimit({
    getRedis: async () => redis,
    now: fixedClock,
    prisma: { tenant: { findUnique: async () => ({ tier: 'PREMIUM' }) } },
  });
  const req = makeReq({ tenantId: 'tenant-g', tenant: { tier: 'PREMIUM' } });
  const res = makeRes();
  await mw(req, res, () => {});
  assert.equal(res.headers['x-tenant-rate-limit-limit'], String(TIER_LIMITS.PREMIUM));
});
