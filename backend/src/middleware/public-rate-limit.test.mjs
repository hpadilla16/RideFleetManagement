// Wave 1 (2026-08-23) — Redis-backed shared per-IP public rate limiter (item
// 1.4). The guard used to keep a per-worker in-process Map, so a brute-forcer
// got `maxRequests` attempts PER WORKER by spreading requests across the
// cluster. It is now backed by a shared Redis fixed-window counter, and FAILS
// OPEN to the retained in-process Map when Redis is null/slow/throwing.
//
// Load-bearing proofs:
//   - two guard instances sharing one Redis counter enforce ONE shared budget;
//   - a throwing Redis falls back to the in-process Map (never 500 / never hang);
//   - RATE_LIMIT_DISABLED=1 stays a hard passthrough;
//   - distinct guard names never share a bucket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicRateLimitGuard } from './public-endpoint-guards.js';

// Map-backed Redis stand-in — INCR + EXPIRE, same shim shape as
// tenant-rate-limit.test.mjs. `fail` makes both throw (Redis-error path).
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
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  return res;
}

function makeReq(ip = '203.0.113.7') {
  return { ip, socket: { remoteAddress: ip } };
}

const FIXED_NOW = 1_700_000_000_000;
const fixedClock = () => FIXED_NOW;

// Fire one request through a guard; return the outcome.
async function hit(guard, ip) {
  const req = makeReq(ip);
  const res = makeRes();
  let nextCalled = false;
  await guard(req, res, () => { nextCalled = true; });
  return { res, nextCalled, status: res.statusCode, headers: res.headers };
}

test('LOAD-BEARING: two guard instances SHARE one Redis counter → single cross-worker budget', async () => {
  const redis = makeRedisShim();
  const opts = { name: 'auth-login-shared', maxRequests: 5, windowMs: 60 * 1000 };
  // Two instances model two workers, each with its OWN guard object but the
  // SAME backing Redis (as in production).
  const workerA = createPublicRateLimitGuard(opts, { getRedis: async () => redis, now: fixedClock });
  const workerB = createPublicRateLimitGuard(opts, { getRedis: async () => redis, now: fixedClock });
  const ip = '198.51.100.9';

  // 3 on A + 2 on B = 5, all allowed (the budget is 5, shared).
  for (let i = 0; i < 3; i++) assert.equal((await hit(workerA, ip)).nextCalled, true);
  for (let i = 0; i < 2; i++) assert.equal((await hit(workerB, ip)).nextCalled, true);

  // The 6th request — regardless of which worker serves it — is over the SHARED
  // limit. A per-worker Map would have allowed 5-per-worker; this proves it does not.
  const sixthOnA = await hit(workerA, ip);
  assert.equal(sixthOnA.nextCalled, false);
  assert.equal(sixthOnA.status, 429);
  assert.match(sixthOnA.res.body.error, /Rate limit exceeded for auth-login-shared/);
});

test('headers carry window-ms / limit / remaining on the Redis path', async () => {
  const redis = makeRedisShim();
  const guard = createPublicRateLimitGuard(
    { name: 'auth-headers', maxRequests: 5, windowMs: 60 * 1000 },
    { getRedis: async () => redis, now: fixedClock },
  );
  const first = await hit(guard, '198.51.100.10');
  assert.equal(first.headers['x-public-rate-limit-window-ms'], '60000');
  assert.equal(first.headers['x-public-rate-limit-limit'], '5');
  assert.equal(first.headers['x-public-rate-limit-remaining'], '4');
  const second = await hit(guard, '198.51.100.10');
  assert.equal(second.headers['x-public-rate-limit-remaining'], '3');
});

test('distinct guard NAMES never share a bucket', async () => {
  const redis = makeRedisShim();
  const ip = '198.51.100.11';
  const login = createPublicRateLimitGuard(
    { name: 'name-login', maxRequests: 2, windowMs: 60 * 1000 },
    { getRedis: async () => redis, now: fixedClock },
  );
  const pin = createPublicRateLimitGuard(
    { name: 'name-pin', maxRequests: 2, windowMs: 60 * 1000 },
    { getRedis: async () => redis, now: fixedClock },
  );
  // Exhaust login (2 ok, 3rd 429); pin from the same IP is untouched.
  assert.equal((await hit(login, ip)).nextCalled, true);
  assert.equal((await hit(login, ip)).nextCalled, true);
  assert.equal((await hit(login, ip)).status, 429);
  assert.equal((await hit(pin, ip)).nextCalled, true, 'a different name has its own budget');
  assert.equal((await hit(pin, ip)).nextCalled, true);
  assert.equal((await hit(pin, ip)).status, 429);
});

test('LOAD-BEARING fail-open: a throwing Redis falls back to the in-process Map (allows, never 500/hangs)', async () => {
  const redis = makeRedisShim({ fail: true }); // incr throws
  const guard = createPublicRateLimitGuard(
    { name: 'failopen-uniq', maxRequests: 3, windowMs: 60 * 1000 },
    { getRedis: async () => redis, now: fixedClock },
  );
  const ip = '198.51.100.12';
  // Requests within the per-worker Map limit are ALLOWED — a Redis outage must
  // never lock everyone out — and each resolves (no hang, no thrown 500).
  const a = await hit(guard, ip);
  assert.equal(a.nextCalled, true, 'fail-open allows the request');
  assert.equal(a.headers['x-public-rate-limit-limit'], '3', 'fallback still sets headers');
  assert.equal((await hit(guard, ip)).nextCalled, true);
  assert.equal((await hit(guard, ip)).nextCalled, true);
  // The fallback STILL enforces a limit (weaker, per-worker) — it is not fully open.
  const over = await hit(guard, ip);
  assert.equal(over.nextCalled, false);
  assert.equal(over.status, 429);
});

test('fail-open when getRedis returns null (no Redis configured) → in-process Map', async () => {
  const guard = createPublicRateLimitGuard(
    { name: 'nullredis-uniq', maxRequests: 2, windowMs: 60 * 1000 },
    { getRedis: async () => null, now: fixedClock },
  );
  const ip = '198.51.100.13';
  assert.equal((await hit(guard, ip)).nextCalled, true);
  assert.equal((await hit(guard, ip)).nextCalled, true);
  assert.equal((await hit(guard, ip)).status, 429);
});

test('RATE_LIMIT_DISABLED=1 is a hard passthrough (no Redis call, no headers)', async () => {
  const prev = process.env.RATE_LIMIT_DISABLED;
  process.env.RATE_LIMIT_DISABLED = '1';
  try {
    let redisTouched = false;
    const guard = createPublicRateLimitGuard(
      { name: 'disabled-uniq', maxRequests: 1, windowMs: 60 * 1000 },
      { getRedis: async () => { redisTouched = true; return makeRedisShim(); }, now: fixedClock },
    );
    const ip = '198.51.100.14';
    // Fire well past the limit — every one passes.
    for (let i = 0; i < 5; i++) {
      const out = await hit(guard, ip);
      assert.equal(out.nextCalled, true);
      assert.equal(out.headers['x-public-rate-limit-limit'], undefined);
    }
    assert.equal(redisTouched, false, 'bypass short-circuits before Redis');
  } finally {
    if (prev === undefined) delete process.env.RATE_LIMIT_DISABLED;
    else process.env.RATE_LIMIT_DISABLED = prev;
  }
});
