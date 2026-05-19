import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard
} from '../../middleware/public-endpoint-guards.js';

/**
 * Smoke test for the per-IP rate-limit guards mounted on customer-portal
 * public token routes (see customer-portal.routes.js, security audit §H1).
 *
 * The router itself depends on Stripe + prisma at import-time which is too
 * heavy for a unit test, so we exercise the guard middleware directly with
 * the exact scope labels + limits used in the router. This locks the
 * behavior the audit's H1 fix promised:
 *   - below limit: next() called, x-public-rate-limit-* headers set
 *   - over limit:  429 with error body, no next()
 */

function makeRes() {
  const headers = {};
  let statusCode = 200;
  let body = null;
  return {
    headers,
    get statusCode() { return statusCode; },
    get body() { return body; },
    setHeader(k, v) { headers[k.toLowerCase()] = String(v); },
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
}

function makeReq({ ip = '203.0.113.10', token = 'abc' } = {}) {
  return {
    ip,
    socket: { remoteAddress: ip },
    headers: {},
    get(name) { return this.headers[String(name).toLowerCase()]; },
    params: { token },
    publicRequestMeta: null,
  };
}

async function run(mw, req, res) {
  let nextCalled = false;
  await new Promise((resolve) => {
    const next = () => { nextCalled = true; resolve(); };
    const ret = mw(req, res, next);
    if (ret && typeof ret.then === 'function') ret.then(resolve, resolve);
    else resolve();
  });
  return nextCalled;
}

test('portalRead: 200 + rate-limit headers when below limit', async () => {
  // Use a unique scope so this test does not collide with sibling tests
  // that share the module-level rateLimitBuckets Map.
  const guard = createPublicRateLimitGuard({
    name: 'customer-portal-read-smoke-below',
    maxRequests: 5,
    windowMs: 60_000,
  });
  const meta = attachPublicRequestMeta('customer-portal-read-smoke-below');

  for (let i = 1; i <= 3; i += 1) {
    const req = makeReq({ ip: '198.51.100.1' });
    const res = makeRes();
    await run(meta, req, res);
    const passed = await run(guard, req, res);
    assert.equal(passed, true, `request ${i} should be allowed`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-public-rate-limit-limit'], '5');
    assert.equal(res.headers['x-public-rate-limit-window-ms'], '60000');
    assert.equal(res.headers['x-public-rate-limit-remaining'], String(5 - i));
    assert.equal(req.publicRequestMeta?.name, 'customer-portal-read-smoke-below');
  }
});

test('portalRead: 429 once IP exceeds the limit', async () => {
  const guard = createPublicRateLimitGuard({
    name: 'customer-portal-read-smoke-over',
    maxRequests: 3,
    windowMs: 60_000,
  });

  // Fire 3 within-budget requests from the same IP.
  for (let i = 0; i < 3; i += 1) {
    const req = makeReq({ ip: '198.51.100.2' });
    const res = makeRes();
    const passed = await run(guard, req, res);
    assert.equal(passed, true);
    assert.equal(res.statusCode, 200);
  }

  // 4th request from the SAME IP should be rejected with 429 + headers + error body.
  const req = makeReq({ ip: '198.51.100.2' });
  const res = makeRes();
  const passed = await run(guard, req, res);
  assert.equal(passed, false, 'fourth request must NOT call next()');
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['x-public-rate-limit-limit'], '3');
  assert.equal(res.headers['x-public-rate-limit-remaining'], '0');
  assert.match(res.body?.error || '', /customer-portal-read-smoke-over/);
});

test('different IPs have independent buckets', async () => {
  const guard = createPublicRateLimitGuard({
    name: 'customer-portal-read-smoke-iso',
    maxRequests: 1,
    windowMs: 60_000,
  });
  // IP A used up its single slot.
  const reqA = makeReq({ ip: '198.51.100.3' });
  const resA = makeRes();
  assert.equal(await run(guard, reqA, resA), true);
  // IP A next call → 429.
  const reqA2 = makeReq({ ip: '198.51.100.3' });
  const resA2 = makeRes();
  assert.equal(await run(guard, reqA2, resA2), false);
  assert.equal(resA2.statusCode, 429);
  // IP B starts fresh.
  const reqB = makeReq({ ip: '198.51.100.4' });
  const resB = makeRes();
  assert.equal(await run(guard, reqB, resB), true);
  assert.equal(resB.statusCode, 200);
});
