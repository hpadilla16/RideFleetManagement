// VozIA Fase 3 (2026-07-03) — service-account auth tests:
//   - requireAuth: tv mismatch → 401 Token revoked; allowlist enforced for
//     service accounts; humans without tv claim completely unaffected.
//   - issueServiceToken: clamps expiry, rejects non-service / inactive targets.
//   - clampServiceTokenExpiresIn matrix.
process.env.JWT_SECRET = 'test-secret-for-service-auth-tests-0123456789';

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../../middleware/auth.js';
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
