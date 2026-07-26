// VozIA Fase 3 (2026-07-03) — service-account auth tests:
//   - requireAuth: tv mismatch → 401 Token revoked; allowlist enforced for
//     service accounts; humans without tv claim completely unaffected.
//   - issueServiceToken: clamps expiry, rejects non-service / inactive targets.
//   - clampServiceTokenExpiresIn matrix.
process.env.JWT_SECRET = 'test-secret-for-service-auth-tests-0123456789';

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { requireAuth, requireCapability } from '../../middleware/auth.js';
import {
  authService,
  clampServiceTokenExpiresIn,
  SERVICE_TOKEN_DEFAULT_EXPIRES_IN,
  SERVICE_TOKEN_MAX_EXPIRES_IN
} from './auth.service.js';

const SECRET = process.env.JWT_SECRET;

function makeReq({ token, method = 'GET', url = '/api/auth/me' }) {
  return {
    headers: { authorization: `Bearer ${token}` },
    method,
    originalUrl: url,
    url
  };
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function runRequireAuth({ sessionUser, claims = {}, method, url }) {
  const original = authService.getSessionUser;
  authService.getSessionUser = async () => sessionUser;
  try {
    const token = jwt.sign({ sub: sessionUser?.id || 'u1', ...claims }, SECRET, { expiresIn: '5m' });
    const req = makeReq({ token, method, url });
    const res = makeRes();
    let nextCalled = false;
    await requireAuth(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
  } finally {
    authService.getSessionUser = original;
  }
}

const SERVICE_USER = { id: 'svc1', role: 'AGENT', tenantId: 't1', isServiceAccount: true, tokenVersion: 1 };
const HUMAN_USER = { id: 'hum1', role: 'ADMIN', tenantId: 't1' };

test('service token with matching tv + allowed endpoint passes', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: SERVICE_USER,
    claims: { svc: true, tv: 1 },
    method: 'GET',
    url: '/api/auth/me'
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('tv mismatch → 401 Token revoked (revocation bumps tokenVersion)', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: SERVICE_USER,
    claims: { svc: true, tv: 0 },
    method: 'GET',
    url: '/api/auth/me'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Token revoked' });
});

test('service token without tv claim → 401 (fail closed)', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: SERVICE_USER,
    claims: {},
    method: 'GET',
    url: '/api/auth/me'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('service account on non-allowlisted endpoint → 403', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: SERVICE_USER,
    claims: { svc: true, tv: 1 },
    method: 'POST',
    url: '/api/rental-agreements/abc/payments/manual'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Endpoint not available for service accounts' });
});

test('service account allowlist check strips the query string', async () => {
  const { nextCalled } = await runRequireAuth({
    sessionUser: SERVICE_USER,
    claims: { svc: true, tv: 1 },
    method: 'GET',
    url: '/api/customers?q=perez&page=1'
  });
  assert.equal(nextCalled, true);
});

test('human token without tv claim passes any endpoint (unchanged behavior)', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: HUMAN_USER,
    claims: {},
    method: 'POST',
    url: '/api/rental-agreements/abc/payments/manual'
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

// ---------------------------------------------------------------------------
// issueServiceToken / revokeServiceTokens (injectable prisma)
// ---------------------------------------------------------------------------

function fakeUserDb(rows) {
  return {
    user: {
      async findUnique({ where }) {
        const row = rows.find((r) => r.id === where.id) || null;
        return row ? { ...row } : null;
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        if (data?.tokenVersion?.increment) row.tokenVersion = (row.tokenVersion || 0) + data.tokenVersion.increment;
        return { tokenVersion: row.tokenVersion };
      }
    }
  };
}

const SVC_ROW = { id: 'svc1', email: 'vozia@ride.test', role: 'AGENT', tenantId: 't1', isActive: true, isServiceAccount: true, tokenVersion: 3 };

test('issueServiceToken mints a token with svc + tv claims and default 90d expiry', async () => {
  const out = await authService.issueServiceToken({ userId: 'svc1' }, { prisma: fakeUserDb([{ ...SVC_ROW }]) });
  assert.equal(out.expiresIn, SERVICE_TOKEN_DEFAULT_EXPIRES_IN);
  const decoded = jwt.verify(out.token, SECRET);
  assert.equal(decoded.sub, 'svc1');
  assert.equal(decoded.svc, true);
  assert.equal(decoded.tv, 3);
  assert.equal(decoded.role, 'AGENT');
  // 90d expiry, within 60s tolerance
  assert.ok(Math.abs((decoded.exp - decoded.iat) - 90 * 24 * 60 * 60) < 60);
});

test('issueServiceToken clamps expiry above 365d', async () => {
  const out = await authService.issueServiceToken(
    { userId: 'svc1', expiresIn: '999d' },
    { prisma: fakeUserDb([{ ...SVC_ROW }]) }
  );
  assert.equal(out.expiresIn, SERVICE_TOKEN_MAX_EXPIRES_IN);
  const decoded = jwt.verify(out.token, SECRET);
  assert.ok(Math.abs((decoded.exp - decoded.iat) - 365 * 24 * 60 * 60) < 60);
});

test('issueServiceToken rejects a non-service target', async () => {
  await assert.rejects(
    authService.issueServiceToken({ userId: 'hum1' }, { prisma: fakeUserDb([{ ...SVC_ROW, id: 'hum1', isServiceAccount: false }]) }),
    /not a service account/i
  );
});

test('issueServiceToken rejects an unknown target', async () => {
  await assert.rejects(
    authService.issueServiceToken({ userId: 'nope' }, { prisma: fakeUserDb([]) }),
    /not a service account/i
  );
});

test('issueServiceToken rejects an inactive service account', async () => {
  await assert.rejects(
    authService.issueServiceToken({ userId: 'svc1' }, { prisma: fakeUserDb([{ ...SVC_ROW, isActive: false }]) }),
    /not active/i
  );
});

test('revokeServiceTokens increments tokenVersion; rejects non-service target', async () => {
  const rows = [{ ...SVC_ROW }];
  const out = await authService.revokeServiceTokens('svc1', { prisma: fakeUserDb(rows) });
  assert.deepEqual(out, { ok: true, userId: 'svc1', tokenVersion: 4 });
  await assert.rejects(
    authService.revokeServiceTokens('hum1', { prisma: fakeUserDb([{ id: 'hum1', isServiceAccount: false }]) }),
    /not a service account/i
  );
});

// ---------------------------------------------------------------------------
// clampServiceTokenExpiresIn matrix
// ---------------------------------------------------------------------------

test('clamp: default when absent/blank', () => {
  assert.equal(clampServiceTokenExpiresIn(undefined), '90d');
  assert.equal(clampServiceTokenExpiresIn(null), '90d');
  assert.equal(clampServiceTokenExpiresIn('  '), '90d');
});

test('clamp: values at or under 365d pass through', () => {
  assert.equal(clampServiceTokenExpiresIn('30d'), '30d');
  assert.equal(clampServiceTokenExpiresIn('12h'), '12h');
  assert.equal(clampServiceTokenExpiresIn('365d'), '365d');
  assert.equal(clampServiceTokenExpiresIn('3600'), '3600s'); // bare digits = seconds
});

test('clamp: values over 365d clamp to 365d', () => {
  assert.equal(clampServiceTokenExpiresIn('366d'), '365d');
  assert.equal(clampServiceTokenExpiresIn('8761h'), '365d');
});

test('clamp: invalid values throw', () => {
  assert.throws(() => clampServiceTokenExpiresIn('soon'), /Invalid expiresIn/);
  assert.throws(() => clampServiceTokenExpiresIn('-5d'), /Invalid expiresIn/);
  assert.throws(() => clampServiceTokenExpiresIn('0d'), /Invalid expiresIn/);
  assert.throws(() => clampServiceTokenExpiresIn('1w'), /Invalid expiresIn/);
});

// ── FULL-CHAIN E2E: VozIA refund (Hector, 2026-07-25) ───────────────────────
//
// Everything above tests requireAuth in isolation. The refund route is guarded
// by TWO middlewares in series, and the interesting failures live in the seam:
//
//   requireAuth  → service-account allowlist   (WHICH PATHS)
//   requireCapability('paymentActions')        (WHICH PRINCIPALS)
//
// These drive a REAL JWT through the REAL requireAuth and then the REAL
// capability gate, in the exact order main.js/the router mount them, so the
// assertions describe what a live request actually does.
//
// The state that matters operationally: the instant this diff deploys, the
// service account passes layer 1 and fails layer 2. It starts working only
// after the deploy step
//   node scripts/grant-payment-actions.mjs --apply <svc-account-email>
// which flips moduleAccess.paymentActions to true on the hydrated session.

const REFUND_URL = '/api/rental-agreements/cmck11111111111111111111/payments/pay1/refund';

/** requireAuth, then requireCapability — returns where the chain stopped. */
async function runChain({ sessionUser, claims = {}, method = 'POST', url = REFUND_URL }) {
  const { req, res, nextCalled } = await runRequireAuth({ sessionUser, claims, method, url });
  if (!nextCalled) return { stoppedAt: 'requireAuth', status: res.statusCode, body: res.body };

  const capRes = makeRes();
  let reached = false;
  requireCapability('paymentActions')(req, capRes, () => { reached = true; });
  if (!reached) return { stoppedAt: 'requireCapability', status: capRes.statusCode, body: capRes.body };
  return { stoppedAt: null, status: null, reachedHandler: true };
}

/** The VozIA account as it exists TODAY: AGENT role, no paymentActions. */
const SVC_UNGRANTED = {
  ...SERVICE_USER,
  moduleAccess: { reservations: true, customers: true, paymentActions: false }
};
/** The same account AFTER grant-payment-actions.mjs --apply. */
const SVC_GRANTED = {
  ...SERVICE_USER,
  moduleAccess: { reservations: true, customers: true, paymentActions: true }
};
/** A DIFFERENT service account that was never granted anything. */
const SVC_OTHER = {
  id: 'svc2',
  role: 'AGENT',
  tenantId: 't1',
  isServiceAccount: true,
  tokenVersion: 1,
  moduleAccess: { reservations: true, paymentActions: false }
};

test('E2E: refund path clears the ALLOWLIST (layer 1) for a service account', async () => {
  // Proves the restored entry is live: the chain gets past requireAuth and only
  // then hits the capability gate. Before the entry was restored this stopped at
  // requireAuth with "Endpoint not available for service accounts".
  const out = await runChain({ sessionUser: SVC_UNGRANTED, claims: { svc: true, tv: 1 } });
  assert.notEqual(out.stoppedAt, 'requireAuth', 'the allowlist must admit the refund path');
});

test('E2E: ungranted service account is stopped by the CAPABILITY gate (layer 2)', async () => {
  const out = await runChain({ sessionUser: SVC_UNGRANTED, claims: { svc: true, tv: 1 } });
  assert.equal(out.stoppedAt, 'requireCapability');
  assert.equal(out.status, 403);
  assert.match(out.body.error, /Payment Actions is turned off/);
});

test('E2E: GRANTED service account reaches the refund handler', async () => {
  // The end state Hector chose. Both layers pass; the route's own VozIA guards
  // (author+ticketId, voziaMaxRefundAmount ceiling) and paymentIdempotency then
  // apply inside the handler.
  const out = await runChain({ sessionUser: SVC_GRANTED, claims: { svc: true, tv: 1 } });
  assert.equal(out.stoppedAt, null, `chain stopped at ${out.stoppedAt} (${out.status})`);
  assert.equal(out.reachedHandler, true);
});

test('E2E: the grant does NOT widen the path surface — other money routes still 403 at layer 1', async () => {
  // Containment. Holding paymentActions clears layer 2 everywhere, so layer 1 is
  // what keeps a granted service account off the other 19 gated routes. Each of
  // these must stop at requireAuth, never reaching the capability gate.
  for (const url of [
    '/api/rental-agreements/abc123/payments/charge-card-on-file',
    '/api/rental-agreements/abc123/security-deposit/capture',
    '/api/rental-agreements/abc123/security-deposit/release',
    '/api/rental-agreements/abc123/customer/card-on-file',
    '/api/reservations/abc123/payments/pay1/refund',
    '/api/reservations/abc123/payments/pay1/delete',
    '/api/reservations/abc123/agreement/spin/charge-card-on-file',
    '/api/issue-center/incidents/abc123/charge-card-on-file'
  ]) {
    const out = await runChain({ sessionUser: SVC_GRANTED, claims: { svc: true, tv: 1 }, url });
    assert.equal(out.stoppedAt, 'requireAuth', `${url} must be refused by the allowlist`);
    assert.equal(out.status, 403);
    assert.deepEqual(out.body, { error: 'Endpoint not available for service accounts' });
  }
});

test('E2E: a DIFFERENT service account gains nothing from the grant', async () => {
  // Per-ACCOUNT containment — the reason the grant is data (one AppSetting row
  // keyed to one user id) rather than an isServiceAccount exemption in
  // requireCapability. svc2 shares the same allowlist, so it clears layer 1 on
  // the refund path, and is stopped dead at layer 2.
  const out = await runChain({ sessionUser: SVC_OTHER, claims: { svc: true, tv: 1 } });
  assert.equal(out.stoppedAt, 'requireCapability');
  assert.equal(out.status, 403);
});

test('E2E: a granted service account still cannot use a REVOKED token', async () => {
  // The grant is orthogonal to revocation — bumping tokenVersion still kills it
  // at layer 0, before either gate.
  const out = await runChain({ sessionUser: SVC_GRANTED, claims: { svc: true, tv: 0 } });
  assert.equal(out.stoppedAt, 'requireAuth');
  assert.equal(out.status, 401);
  assert.deepEqual(out.body, { error: 'Token revoked' });
});
