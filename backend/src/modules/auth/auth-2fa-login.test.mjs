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
import bcrypt from 'bcryptjs';
import { requireAuth } from '../../middleware/auth.js';
import { authService, loginTwoFactorOutcome } from './auth.service.js';
import { twoFactorService } from './two-factor.service.js';
import { normalizePolicy, requiresTwoFactor } from '../../lib/two-factor-policy.js';
import { prisma } from '../../lib/prisma.js';

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

// ── FIX 1 (QA): mustChangePassword + pending-2FA-token must NOT deadlock ─────
// The password gate runs before the 2FA gate; both must let the 2FA second leg
// through so a user who is BOTH mustChangePassword AND holding a pending token
// can complete 2FA first, THEN be forced to change the password. Neither gate
// may be weakened for any OTHER route.

test('deadlock (a): enrolled + mustChangePassword can reach verify-login', async () => {
  const { nextCalled, res } = await runRequireAuth({
    sessionUser: { id: 'u1', role: 'ADMIN', tenantId: 't1', twoFactorEnabled: true, mustChangePassword: true },
    claims: { mfa: 'VERIFY' }, method: 'POST', url: '/api/auth/2fa/verify-login'
  });
  assert.equal(nextCalled, true, 'both gates let verify-login through');
  assert.equal(res.statusCode, null);
});

test('deadlock (b): required-not-enrolled + mustChangePassword can reach the enroll endpoints', async () => {
  for (const url of ['/api/auth/2fa/enroll/start', '/api/auth/2fa/enroll/verify']) {
    const { nextCalled } = await runRequireAuth({
      sessionUser: { id: 'u1', role: 'ADMIN', tenantId: 't1', twoFactorEnabled: false, mustChangePassword: true },
      claims: { mfa: 'ENROLL' }, method: 'POST', url
    });
    assert.equal(nextCalled, true, `enroll reachable while mustChangePassword: ${url}`);
  }
});

test('after 2FA (full token) + mustChangePassword can reach change-password', async () => {
  // A full token has NO mfa claim, so only the password gate applies — and it
  // still forces the change-password step. That is the intended sequencing.
  const { nextCalled } = await runRequireAuth({
    sessionUser: { id: 'u1', role: 'ADMIN', tenantId: 't1', twoFactorEnabled: true, mustChangePassword: true },
    method: 'POST', url: '/api/auth/change-password'
  });
  assert.equal(nextCalled, true);
});

test('mustChangePassword + pending token is still blocked on a business route', async () => {
  const { nextCalled, res } = await runRequireAuth({
    sessionUser: { id: 'u1', role: 'ADMIN', tenantId: 't1', twoFactorEnabled: true, mustChangePassword: true },
    claims: { mfa: 'VERIFY' }, method: 'GET', url: '/api/reservations'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403, 'business route still denied');
});

test('the pending gate is NOT weakened: a pending token still cannot reach change-password', async () => {
  // change-password is on the PASSWORD gate allowlist but NOT the 2FA pending
  // allowlist, so a pending token (no mustChangePassword) is still 403'd there.
  const { nextCalled, res } = await runRequireAuth({
    sessionUser: { id: 'u1', role: 'ADMIN', tenantId: 't1', twoFactorEnabled: true, mustChangePassword: false },
    claims: { mfa: 'VERIFY' }, method: 'POST', url: '/api/auth/change-password'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'TWO_FACTOR_REQUIRED');
});

// ── FIX 2 (QA): a failing policy read must FAIL OPEN, never lock users out ───

test('login FAILS OPEN to a full token when the policy read throws', async () => {
  // Stub the shared prisma singleton: the user resolves (password matches), but
  // the appSetting read (resolveTwoFactorPolicy) THROWS. login() must swallow
  // it and issue the full {token,user} — never a thrown 401.
  const password = 'correct-horse-battery';
  const passwordHash = await bcrypt.hash(password, 4);
  const origUserFind = prisma.user.findUnique;
  const origAppFind = prisma.appSetting.findUnique;
  // SUPER_ADMIN so buildSessionUser's module-access path never touches prisma.
  prisma.user.findUnique = async () => ({
    id: 'ua', email: 'a@b.com', role: 'SUPER_ADMIN', tenantId: 't1',
    isActive: true, passwordHash, twoFactorEnabled: false, hostProfile: null
  });
  prisma.appSetting.findUnique = async () => { throw new Error('settings store unavailable'); };
  try {
    const out = await authService.login({ email: 'a@b.com', password });
    assert.ok(out.token, 'a full token is issued despite the policy read failure');
    assert.ok(out.user, 'the full session user is returned');
    assert.notEqual(out.mfaRequired, true, 'no challenge — password-only full login');
  } finally {
    prisma.user.findUnique = origUserFind;
    prisma.appSetting.findUnique = origAppFind;
  }
});
