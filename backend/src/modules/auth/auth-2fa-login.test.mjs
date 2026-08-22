// Staff 2FA login flow (2026-08-22). Covers EVERY login branch via the pure
// decision helper (including the no-policy passthrough and the kill-switch),
// the pending-token allowlist in requireAuth (verify allowed / other route
// 403), that /refresh refuses a pending token, and that an admin reset
// re-forces enrollment. The middleware tests reuse the mocked-getSessionUser
// harness from password-gate.test.mjs.
import '../../lib/_two-factor-test-env.mjs'; // MUST be first — sets env before prisma.js constructs

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../../middleware/auth.js';
import { authService, loginTwoFactorOutcome } from './auth.service.js';
import { twoFactorService } from './two-factor.service.js';
import { normalizePolicy, requiresTwoFactor } from '../../lib/two-factor-policy.js';

const SECRET = process.env.JWT_SECRET;

// ── Login decision: all branches ──────────────────────────────────────────

test('no policy + kill-switch off ⇒ FULL (login is UNCHANGED)', () => {
  const user = { id: 'u1', role: 'AGENT', tenantId: 't1', twoFactorEnabled: false };
  const policy = normalizePolicy(null); // absent policy
  assert.equal(loginTwoFactorOutcome({ user, policy, killed: false }), 'FULL');
});

test('kill-switch forces FULL even for an already-enrolled user', () => {
  const enrolled = { id: 'u1', role: 'ADMIN', tenantId: 't1', twoFactorEnabled: true };
  assert.equal(loginTwoFactorOutcome({ user: enrolled, policy: null, killed: true }), 'FULL');
});

test('enrolled user ⇒ VERIFY (independent of policy)', () => {
  const enrolled = { id: 'u1', role: 'AGENT', tenantId: 't1', twoFactorEnabled: true };
  assert.equal(loginTwoFactorOutcome({ user: enrolled, policy: normalizePolicy(null), killed: false }), 'VERIFY');
});

test('required role, not enrolled ⇒ ENROLL', () => {
  const user = { id: 'u1', role: 'ADMIN', tenantId: 't1', twoFactorEnabled: false };
  const policy = { enabled: true, requiredRoles: ['ADMIN'], graceUntil: null };
  assert.equal(loginTwoFactorOutcome({ user, policy, killed: false }), 'ENROLL');
});

test('policy enabled but role NOT required ⇒ FULL', () => {
  const user = { id: 'u1', role: 'AGENT', tenantId: 't1', twoFactorEnabled: false };
  const policy = { enabled: true, requiredRoles: ['ADMIN'], graceUntil: null };
  assert.equal(loginTwoFactorOutcome({ user, policy, killed: false }), 'FULL');
});

// ── Pending-token allowlist in requireAuth ────────────────────────────────

function makeReq({ token, method = 'GET', url = '/api/auth/me' }) {
  return { headers: { authorization: `Bearer ${token}` }, method, originalUrl: url, url };
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

const ENROLLED_USER = { id: 'u1', role: 'ADMIN', tenantId: 't1', twoFactorEnabled: true };

test('pending token reaches POST /api/auth/2fa/verify-login', async () => {
  const { nextCalled, res } = await runRequireAuth({
    sessionUser: ENROLLED_USER, claims: { mfa: 'VERIFY' }, method: 'POST', url: '/api/auth/2fa/verify-login'
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('pending token reaches the enroll endpoints and /me', async () => {
  for (const [method, url] of [
    ['POST', '/api/auth/2fa/enroll/start'],
    ['POST', '/api/auth/2fa/enroll/verify'],
    ['GET', '/api/auth/me']
  ]) {
    const { nextCalled } = await runRequireAuth({ sessionUser: ENROLLED_USER, claims: { mfa: 'VERIFY' }, method, url });
    assert.equal(nextCalled, true, `${method} ${url}`);
  }
});

test('pending token is 403 TWO_FACTOR_REQUIRED on a business route', async () => {
  const { nextCalled, res } = await runRequireAuth({
    sessionUser: ENROLLED_USER, claims: { mfa: 'VERIFY' }, method: 'GET', url: '/api/reservations'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'TWO_FACTOR_REQUIRED');
});

test('pending token is refused at POST /api/auth/refresh (not on the allowlist)', async () => {
  const { nextCalled, res } = await runRequireAuth({
    sessionUser: ENROLLED_USER, claims: { mfa: 'VERIFY' }, method: 'POST', url: '/api/auth/refresh'
  });
  assert.equal(nextCalled, false, 'refresh never runs for a pending token');
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'TWO_FACTOR_REQUIRED');
});

test('a NORMAL (non-mfa) token is completely unaffected by the 2FA gate', async () => {
  const { nextCalled, res } = await runRequireAuth({
    sessionUser: { id: 'u2', role: 'AGENT', tenantId: 't1' }, method: 'GET', url: '/api/reservations'
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

// ── Admin reset re-forces enrollment ──────────────────────────────────────

test('admin reset disables 2FA so the next login re-enters ENROLL when required', async () => {
  // Fake prisma just for the disable step (twoFactorService.disableFor).
  const user = { id: 'u1', role: 'ADMIN', tenantId: 't1', twoFactorEnabled: true, twoFactorSecret: 'x', twoFactorEnrolledAt: new Date() };
  const users = new Map([[user.id, { ...user }]]);
  let codes = [{ id: 'bc1', userId: 'u1', usedAt: null }];
  const db = {
    user: {
      async update({ where, data }) { Object.assign(users.get(where.id), data); return users.get(where.id); }
    },
    twoFactorBackupCode: {
      async deleteMany({ where }) { codes = codes.filter((c) => c.userId !== where.userId); return { count: 0 }; }
    }
  };

  await twoFactorService.disableFor('u1', { prisma: db });
  const after = users.get('u1');
  assert.equal(after.twoFactorEnabled, false, '2FA cleared');
  assert.equal(after.twoFactorSecret, null);
  assert.equal(codes.length, 0, 'backup codes cleared');

  // With the policy still requiring ADMIN, the reset user's next login is ENROLL.
  const policy = { enabled: true, requiredRoles: ['ADMIN'], graceUntil: null };
  assert.equal(requiresTwoFactor(after, policy), true);
  assert.equal(loginTwoFactorOutcome({ user: after, policy, killed: false }), 'ENROLL');
});
