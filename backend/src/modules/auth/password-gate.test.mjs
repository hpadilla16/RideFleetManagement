// First-login onboarding (2026-07-25) — the PASSWORD_CHANGE_REQUIRED gate:
//   - a human session with mustChangePassword reaches ONLY the allowlist
//     (change-password, me, refresh) and 403s everywhere else;
//   - humans without the flag are completely unaffected;
//   - service accounts are exempt from THIS gate (their own default-deny
//     allowlist governs them).
// Same mocked-getSessionUser harness as service-auth.test.mjs.
process.env.JWT_SECRET = 'test-secret-for-password-gate-tests-0123456789';

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../../middleware/auth.js';
import { authService } from './auth.service.js';

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
    return { res, nextCalled };
  } finally {
    authService.getSessionUser = original;
  }
}

const TEMP_PASSWORD_USER = { id: 'lax1', role: 'AGENT', tenantId: 't1', mustChangePassword: true };
const NORMAL_USER = { id: 'hum1', role: 'AGENT', tenantId: 't1', mustChangePassword: false };

test('temp-password human is 403d off a business endpoint with a machine code', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: TEMP_PASSWORD_USER, method: 'GET', url: '/api/reservations'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'PASSWORD_CHANGE_REQUIRED');
});

test('the way out is open: POST /api/auth/change-password passes the gate', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: TEMP_PASSWORD_USER, method: 'POST', url: '/api/auth/change-password'
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('session hydration and token refresh stay reachable while gated', async () => {
  for (const [method, url] of [['GET', '/api/auth/me'], ['POST', '/api/auth/refresh']]) {
    const { nextCalled } = await runRequireAuth({ sessionUser: TEMP_PASSWORD_USER, method, url });
    assert.equal(nextCalled, true, `${method} ${url}`);
  }
});

test('query strings do not defeat the allowlist match', async () => {
  const { nextCalled } = await runRequireAuth({
    sessionUser: TEMP_PASSWORD_USER, method: 'POST', url: '/api/auth/change-password?redirect=1'
  });
  assert.equal(nextCalled, true);
});

test('the allowlist is method-exact: GET change-password is NOT a way out', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: TEMP_PASSWORD_USER, method: 'GET', url: '/api/auth/change-password'
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('humans without the flag are completely unaffected', async () => {
  const { res, nextCalled } = await runRequireAuth({
    sessionUser: NORMAL_USER, method: 'GET', url: '/api/reservations'
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('service accounts are exempt from the password gate (their allowlist governs)', async () => {
  const { nextCalled } = await runRequireAuth({
    sessionUser: { id: 'svc1', role: 'AGENT', tenantId: 't1', isServiceAccount: true, tokenVersion: 1, mustChangePassword: true },
    claims: { svc: true, tv: 1 },
    method: 'GET',
    url: '/api/auth/me'
  });
  assert.equal(nextCalled, true);
});
