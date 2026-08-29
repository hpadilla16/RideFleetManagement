// Wave 1 (2026-08-23) — human logout + token-version revocation (item 1.2).
//
// Two load-bearing guarantees this suite pins:
//   (A) requireAuth's HUMAN tv check revokes a stale human token, but NEVER
//       touches the three exempt short-lived token classes (pending-2FA,
//       practice, guest) — a bug there 401s a user mid-2FA-login or breaks the
//       guest/practice flows.
//   (B) MISSING-TV-MEANS-0: a legacy human token (no tv claim) still passes
//       while the user's DB tokenVersion is the default 0, so deploying this
//       change does NOT mass-log-out existing sessions.
//
// requireAuth is driven directly with a mocked getSessionUser + real JWTs, the
// exact harness style of service-auth.test.mjs.
process.env.JWT_SECRET = 'test-secret-for-logout-revocation-tests-0123456789';

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../../middleware/auth.js';
import { authService } from './auth.service.js';

const SECRET = process.env.JWT_SECRET;

function makeReq({ token, method = 'GET', url = '/api/reservations' }) {
  return { headers: { authorization: `Bearer ${token}` }, method, originalUrl: url, url };
}
function makeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

// Drive requireAuth with a hydrated session + raw JWT claims.
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

const HUMAN = (over = {}) => ({ id: 'hum1', role: 'ADMIN', tenantId: 't1', isServiceAccount: false, tokenVersion: 0, ...over });

// ── (A/B) requireAuth human tv branch ──────────────────────────────────────

test('human token with matching tv passes', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: HUMAN({ tokenVersion: 2 }),
    claims: { tv: 2 },
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('LOAD-BEARING: after a logout bump, the old human token → 401 Token revoked', async () => {
  // Token was minted at tv=2; logout() bumped the DB row to tv=3.
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: HUMAN({ tokenVersion: 3 }),
    claims: { tv: 2 },
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Token revoked' });
});

test('LOAD-BEARING (missing-tv-means-0): legacy human token with NO tv passes when tokenVersion is 0', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: HUMAN({ tokenVersion: 0 }),
    claims: {}, // pre-deploy token carries no tv
  });
  assert.equal(nextCalled, true, 'no deploy-time mass logout');
  assert.equal(res.statusCode, null);
});

test('legacy human token with NO tv is REVOKED once tokenVersion has moved past 0', async () => {
  // A user who has since logged out: DB tokenVersion is 1, the ancient no-tv
  // token reads as tv=0 → mismatch → revoked. (Correct: they DID log out.)
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: HUMAN({ tokenVersion: 1 }),
    claims: {},
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Token revoked' });
});

test('LOAD-BEARING exemption: a pending-2FA (mfa) token is NEVER hit by the tv branch', async () => {
  // Even with a wildly stale tv, the mfa token must not be revoked here — it is
  // governed by the TWO_FACTOR_PENDING allowlist. On an allowlisted path it
  // proceeds; on a non-allowlisted path it is stopped by the 2FA gate (403),
  // NOT the tv branch (401 'Token revoked').
  const allow = await runRequireAuth({
    sessionUser: HUMAN({ tokenVersion: 9 }),
    claims: { mfa: 'VERIFY', tv: 0 },
    method: 'POST', url: '/api/auth/2fa/verify-login',
  });
  assert.equal(allow.nextCalled, true, 'mfa token reaches its allowlisted endpoint');
  assert.equal(allow.res.statusCode, null);

  const blocked = await runRequireAuth({
    sessionUser: HUMAN({ tokenVersion: 9 }),
    claims: { mfa: 'VERIFY', tv: 0 },
    method: 'GET', url: '/api/reservations',
  });
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.res.statusCode, 403, 'stopped by the 2FA gate, not the tv branch');
  assert.equal(blocked.res.body.code, 'TWO_FACTOR_REQUIRED');
});

test('LOAD-BEARING exemption: a practice (prac) token is exempt from the tv branch', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: HUMAN({ role: 'AGENT', tokenVersion: 5 }),
    claims: { prac: true, tv: 0 },
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('LOAD-BEARING exemption: a guest (role=GUEST) token is exempt from the tv branch', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: HUMAN({ role: 'GUEST', tokenVersion: 7 }),
    claims: { tv: 0 },
    url: '/api/public-booking/redeem',
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('mustChangePassword user is still boxed (tv passes, password gate applies)', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: HUMAN({ tokenVersion: 0, mustChangePassword: true }),
    claims: { tv: 0 },
    method: 'GET', url: '/api/reservations',
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'PASSWORD_CHANGE_REQUIRED');
});

test('a service account is unaffected by the human branch (its own tv gate governs it)', async () => {
  // svc token with matching tv on an allowlisted path passes; the human branch
  // must not double-judge it.
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: { id: 'svc1', role: 'AGENT', tenantId: 't1', isServiceAccount: true, tokenVersion: 1 },
    claims: { svc: true, tv: 1 },
    method: 'GET', url: '/api/auth/me',
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

// ── signToken carries tv for humans + impersonation ─────────────────────────

test('issueTokenForUser stamps the human tokenVersion into the tv claim', async () => {
  const token = authService.issueTokenForUser({ id: 'hum1', email: 'a@b.c', role: 'ADMIN', tenantId: 't1', tokenVersion: 4 });
  const decoded = jwt.verify(token, SECRET);
  assert.equal(decoded.tv, 4);
  assert.equal(decoded.svc, undefined, 'humans get tv but not svc');
});

test('a human row with no tokenVersion mints tv=0 (default)', async () => {
  const token = authService.issueTokenForUser({ id: 'hum2', email: 'a@b.c', role: 'AGENT', tenantId: 't1' });
  assert.equal(jwt.verify(token, SECRET).tv, 0);
});

test('impersonation token carries the TARGET row tokenVersion (natural, no special-casing)', async () => {
  const token = authService.issueImpersonationToken(
    { id: 'target1', email: 't@b.c', role: 'ADMIN', tenantId: 't1', tokenVersion: 6 },
    { impersonatedBy: 'super1' },
  );
  const decoded = jwt.verify(token, SECRET);
  assert.equal(decoded.tv, 6);
  assert.equal(decoded.imp, 'super1');
});

// ── authService.logout bump (injected prisma) ───────────────────────────────

function fakeUserDb(rows) {
  return {
    user: {
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        if (data?.tokenVersion?.increment) row.tokenVersion = (row.tokenVersion || 0) + data.tokenVersion.increment;
        return { ...row };
      },
    },
  };
}

test('logout() increments the user tokenVersion and returns { ok: true }', async () => {
  const rows = [{ id: 'hum1', tokenVersion: 2 }];
  const out = await authService.logout('hum1', { prisma: fakeUserDb(rows) });
  assert.deepEqual(out, { ok: true });
  assert.equal(rows[0].tokenVersion, 3, 'every outstanding token is now stale');
});

test('logout() rejects a missing userId (never bumps a blank id)', async () => {
  await assert.rejects(authService.logout('', { prisma: fakeUserDb([]) }), /Missing userId/);
});
