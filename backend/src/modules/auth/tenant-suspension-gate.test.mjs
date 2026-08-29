/**
 * The suspension gate AS IT ACTUALLY RUNS — inside requireAuth, on the real
 * middleware, with a real signed JWT. tenant-suspension.test.mjs proves the
 * decision; this file proves the WIRING, which is where a gate like this
 * actually goes wrong: hydrated in the wrong place, evaluated before the token
 * check, or reading a path that still has its query string on it.
 *
 * Same mocked-getSessionUser harness as password-gate.test.mjs.
 */
process.env.JWT_SECRET = 'test-secret-for-tenant-suspension-gate-0123456789';
// The middleware imports auth.service.js, which constructs a PrismaClient at
// module load. A URL is required for the CONSTRUCTOR to validate; nothing here
// ever connects, because getSessionUser is stubbed on every path. Same line the
// whole billing suite opens with.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';

import test from 'node:test';
import assert from 'node:assert/strict';

// DYNAMIC, and it has to be. A static `import` is hoisted above the env
// assignments above, so prisma.js would construct its client before
// DATABASE_URL existed and the whole file would die at load. The billing suite
// opens exactly this way for exactly this reason.
const jwt = (await import('jsonwebtoken')).default;
const { requireAuth } = await import('../../middleware/auth.js');
const { authService } = await import('./auth.service.js');

const SECRET = process.env.JWT_SECRET;

/**
 * The env is process-wide and the middleware reads it at call time, so every
 * test sets it and puts it back. Restoring rather than deleting matters: a
 * leaked `enforce` would make the NEXT test file in the same `node --test` run
 * fail for a reason that has nothing to do with it.
 */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (async () => {
    try { return await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  })();
}

async function run({ sessionUser, claims = {}, method = 'GET', url = '/api/reports/revenue' }) {
  const original = authService.getSessionUser;
  authService.getSessionUser = async () => sessionUser;
  try {
    const token = jwt.sign({ sub: sessionUser?.id || 'u1', ...claims }, SECRET, { expiresIn: '5m' });
    const req = { headers: { authorization: `Bearer ${token}` }, method, originalUrl: url, url };
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    let nextCalled = false;
    await requireAuth(req, res, () => { nextCalled = true; });
    return { res, req, nextCalled };
  } finally {
    authService.getSessionUser = original;
  }
}

const SUSPENDED = { id: 'u1', role: 'ADMIN', tenantId: 't1', tenantStatus: 'SUSPENDED', mustChangePassword: false };
const ACTIVE = { id: 'u2', role: 'ADMIN', tenantId: 't1', tenantStatus: 'ACTIVE', mustChangePassword: false };
const ENFORCE = { TENANT_SUSPENSION_ENFORCEMENT: 'enforce', TENANT_SUSPENSION_DISABLED: undefined };

// ── Inert by default ───────────────────────────────────────────────────────

test('WITH THE SWITCH OFF, a suspended tenant is not gated at all', () => withEnv(
  { TENANT_SUSPENSION_ENFORCEMENT: undefined, TENANT_SUSPENSION_DISABLED: undefined },
  async () => {
    const { res, nextCalled } = await run({ sessionUser: SUSPENDED });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  },
));

test('log mode lets the request through — it observes, it does not block', () => withEnv(
  { TENANT_SUSPENSION_ENFORCEMENT: 'log', TENANT_SUSPENSION_DISABLED: undefined },
  async () => {
    const { res, nextCalled } = await run({ sessionUser: SUSPENDED });
    assert.equal(nextCalled, true, 'log mode must never block');
    assert.equal(res.statusCode, null);
  },
));

test('the kill-switch halts enforcement with no code change', () => withEnv(
  { TENANT_SUSPENSION_ENFORCEMENT: 'enforce', TENANT_SUSPENSION_DISABLED: 'true' },
  async () => {
    const { nextCalled } = await run({ sessionUser: SUSPENDED });
    assert.equal(nextCalled, true);
  },
));

// ── Enforcing ──────────────────────────────────────────────────────────────

test('an ACTIVE tenant is unaffected on every route while enforcement is on', () => withEnv(ENFORCE, async () => {
  for (const [method, url] of [
    ['GET', '/api/reports/revenue'], ['POST', '/api/reservations'],
    ['GET', '/api/people'], ['PUT', '/api/rates/1'],
  ]) {
    const { res, nextCalled } = await run({ sessionUser: ACTIVE, method, url });
    assert.equal(nextCalled, true, `${method} ${url}`);
    assert.equal(res.statusCode, null);
  }
}));

test('a suspended tenant\'s staff get 403 TENANT_SUSPENDED, not a generic error', () => withEnv(ENFORCE, async () => {
  const { res, nextCalled } = await run({ sessionUser: SUSPENDED });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'TENANT_SUSPENDED');
  assert.match(res.body.error, /Contact Ride/i);
}));

test('they can still reach the billing pages', () => withEnv(ENFORCE, async () => {
  for (const [method, url] of [['GET', '/api/billing/self'], ['POST', '/api/billing/self/payment-link']]) {
    const { nextCalled } = await run({ sessionUser: SUSPENDED, method, url });
    assert.equal(nextCalled, true, `${method} ${url}`);
  }
}));

test('they can still close an open rental and take a return', () => withEnv(ENFORCE, async () => {
  for (const [method, url] of [
    ['GET', '/api/rental-agreements/a1'],
    ['POST', '/api/rental-agreements/a1/inspection'],
    ['POST', '/api/rental-agreements/a1/checkin-close'],
    ['POST', '/api/rental-agreements/a1/close'],
    ['POST', '/api/rental-agreements/a1/payments/manual'],
    ['POST', '/api/rental-agreements/a1/security-deposit/release'],
  ]) {
    const { nextCalled } = await run({ sessionUser: SUSPENDED, method, url });
    assert.equal(nextCalled, true, `${method} ${url}`);
  }
}));

test('SUPER_ADMIN is never locked out — including of the route that restores them', () => withEnv(ENFORCE, async () => {
  const su = { id: 's1', role: 'SUPER_ADMIN', tenantId: 't1', tenantStatus: 'SUSPENDED', mustChangePassword: false };
  const { nextCalled } = await run({ sessionUser: su, method: 'POST', url: '/api/tenants/billing/t1/restore' });
  assert.equal(nextCalled, true);
}));

test('a query string does not defeat the allowlist inside the middleware', () => withEnv(ENFORCE, async () => {
  const { nextCalled } = await run({ sessionUser: SUSPENDED, method: 'GET', url: '/api/billing/self?from=hold' });
  assert.equal(nextCalled, true);
}));

// ── Ordering, which is the part that only an integration test can catch ────

test('a REVOKED token is rejected as revoked, not as suspended', () => withEnv(ENFORCE, async () => {
  // The token-version check must win. If suspension ran first, a user with a
  // dead token on a suspended tenant would be told the wrong thing, and worse,
  // a 403 would replace a 401 the client uses to trigger re-login.
  const { res } = await run({
    sessionUser: { ...SUSPENDED, tokenVersion: 3 },
    claims: { tv: 1 },
  });
  assert.equal(res.statusCode, 401);
}));

test('a temp-password user on a suspended tenant is told about the password first', () => withEnv(ENFORCE, async () => {
  // Both gates apply. The password gate runs first, and its allowlist already
  // contains the way out — which the suspension allowlist also contains, so
  // neither gate can brick the other.
  const { res } = await run({ sessionUser: { ...SUSPENDED, mustChangePassword: true } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'PASSWORD_CHANGE_REQUIRED');

  const out = await run({
    sessionUser: { ...SUSPENDED, mustChangePassword: true },
    method: 'POST',
    url: '/api/auth/change-password',
  });
  assert.equal(out.nextCalled, true, 'the way out of BOTH gates must stay open');
}));

test('a null tenantStatus (a hydration path that did not load the relation) does not lock anyone out',
  () => withEnv(ENFORCE, async () => {
    const { nextCalled } = await run({ sessionUser: { ...SUSPENDED, tenantStatus: null } });
    assert.equal(nextCalled, true);
  }));

test('req.user carries tenantStatus so the frontend can render the hold screen on first paint',
  () => withEnv(ENFORCE, async () => {
    const { req } = await run({ sessionUser: SUSPENDED, method: 'GET', url: '/api/auth/me' });
    assert.equal(req.user.tenantStatus, 'SUSPENDED');
  }));
