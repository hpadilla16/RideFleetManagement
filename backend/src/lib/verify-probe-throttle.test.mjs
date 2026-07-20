import test from 'node:test';
import assert from 'node:assert/strict';

import { createVerifyProbeThrottle, FAILED_VERIFY_LIMIT, WINDOW_SECONDS } from './verify-probe-throttle.js';

/**
 * Minimal Redis shim backing GET + INCR + EXPIRE with a Map (same pattern as
 * tenant-rate-limit.test.mjs). `fail` makes every op throw; `hang` makes every
 * op return a never-resolving promise (the beta.211 zombie-connection shape).
 */
function makeRedisShim({ fail = false, hang = false } = {}) {
  const store = new Map();
  const ttls = new Map();
  const guard = () => {
    if (fail) throw new Error('shim failure');
    if (hang) return new Promise(() => {});
    return null;
  };
  return {
    store,
    ttls,
    async get(key) {
      const h = guard(); if (h) return h;
      return store.has(key) ? String(store.get(key)) : null;
    },
    async incr(key) {
      const h = guard(); if (h) return h;
      const next = (store.get(key) || 0) + 1;
      store.set(key, next);
      return next;
    },
    async expire(key, ttl) {
      const h = guard(); if (h) return h;
      ttls.set(key, ttl);
      return store.has(key) ? 1 : 0;
    },
  };
}

const FIXED_NOW = 1_700_000_000_000;
const PRINCIPAL = { tenantId: 'tenant-a', principalId: 'user-1' };

function makeThrottle(redis, overrides = {}) {
  return createVerifyProbeThrottle({
    getRedis: async () => redis,
    now: () => FIXED_NOW,
    ...overrides,
  });
}

test('fresh principal is not blocked', async () => {
  const throttle = makeThrottle(makeRedisShim());
  const gate = await throttle.isBlocked(PRINCIPAL);
  assert.equal(gate.blocked, false);
});

test('stays open below the limit, blocks once the limit is reached', async () => {
  const throttle = makeThrottle(makeRedisShim());
  for (let i = 0; i < FAILED_VERIFY_LIMIT - 1; i++) {
    await throttle.recordFailure(PRINCIPAL);
    const gate = await throttle.isBlocked(PRINCIPAL);
    assert.equal(gate.blocked, false, `blocked too early at failure #${i + 1}`);
  }
  // The Nth failure exhausts the budget: the NEXT lookup is blocked.
  await throttle.recordFailure(PRINCIPAL);
  const gate = await throttle.isBlocked(PRINCIPAL);
  assert.equal(gate.blocked, true);
  assert.ok(gate.retryAfterSeconds >= 1);
  assert.ok(gate.retryAfterSeconds <= WINDOW_SECONDS);
});

test('window rollover resets the counter (fixed window)', async () => {
  const redis = makeRedisShim();
  let nowMs = FIXED_NOW;
  const throttle = createVerifyProbeThrottle({
    getRedis: async () => redis,
    now: () => nowMs,
  });
  for (let i = 0; i < FAILED_VERIFY_LIMIT; i++) await throttle.recordFailure(PRINCIPAL);
  assert.equal((await throttle.isBlocked(PRINCIPAL)).blocked, true);
  // Jump past the current bucket - a new key applies, budget is fresh.
  nowMs += (WINDOW_SECONDS + 1) * 1000;
  assert.equal((await throttle.isBlocked(PRINCIPAL)).blocked, false);
});

test('counters are isolated per (tenant, principal)', async () => {
  const throttle = makeThrottle(makeRedisShim());
  for (let i = 0; i < FAILED_VERIFY_LIMIT; i++) await throttle.recordFailure(PRINCIPAL);
  assert.equal((await throttle.isBlocked(PRINCIPAL)).blocked, true);
  assert.equal((await throttle.isBlocked({ tenantId: 'tenant-a', principalId: 'user-2' })).blocked, false);
  assert.equal((await throttle.isBlocked({ tenantId: 'tenant-b', principalId: 'user-1' })).blocked, false);
});

test('first failure sets a TTL on the window key', async () => {
  const redis = makeRedisShim();
  const throttle = makeThrottle(redis);
  await throttle.recordFailure(PRINCIPAL);
  assert.equal(redis.ttls.size, 1);
  const [ttl] = redis.ttls.values();
  assert.ok(ttl >= WINDOW_SECONDS, 'TTL must outlive the window');
});

test('fail-open: redis errors allow the request and drop the count', async () => {
  const throttle = makeThrottle(makeRedisShim({ fail: true }));
  await assert.doesNotReject(() => throttle.recordFailure(PRINCIPAL));
  const gate = await throttle.isBlocked(PRINCIPAL);
  assert.equal(gate.blocked, false);
});

test('fail-open: a hanging redis (beta.211 shape) times out fast and allows', async () => {
  const throttle = makeThrottle(makeRedisShim({ hang: true }), { opTimeoutMs: 10 });
  const started = Date.now();
  const gate = await throttle.isBlocked(PRINCIPAL);
  await throttle.recordFailure(PRINCIPAL);
  assert.equal(gate.blocked, false);
  assert.ok(Date.now() - started < 1000, 'must not wait on the zombie connection');
});

test('fail-open: no redis client at all disables the throttle', async () => {
  const throttle = createVerifyProbeThrottle({ getRedis: async () => null, now: () => FIXED_NOW });
  await assert.doesNotReject(() => throttle.recordFailure(PRINCIPAL));
  assert.equal((await throttle.isBlocked(PRINCIPAL)).blocked, false);
});
