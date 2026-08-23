// Wave 3 — administrative audit trail (2026-08-24).
//
// Proves the two LOAD-BEARING properties and the wiring contract:
//   1. recordAudit is BEST-EFFORT — a failed audit write never changes a
//      caller's outcome (unit + at the real login call site).
//   2. The `imp` claim is byte-compatible — a normal login token is unchanged;
//      `imp` appears only when impersonatedBy is passed.
// Plus: metadata PII is redacted before persist; impersonation produces an
// IMPERSONATION_START row with the super-admin as actor; a customer read under
// an impersonation token carries BOTH actorUserId and impersonatedByUserId;
// list endpoints are NOT audited while a single-record read is; a failed login
// is audited FAILURE with no password in metadata.
import '../../lib/_two-factor-test-env.mjs'; // MUST be first — sets env before prisma.js constructs

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { prisma } from '../../lib/prisma.js';
import {
  recordAudit,
  auditFromReq,
  AUDIT_ACTIONS,
  AUDIT_OUTCOME,
} from './audit.service.js';
import { authService } from '../auth/auth.service.js';
import { tenantsService } from '../tenants/tenants.service.js';
import { customersRouter } from '../customers/customers.routes.js';
import { customersService } from '../customers/customers.service.js';
import { authRouter } from '../auth/auth.routes.js';
import { requireAuth } from '../../middleware/auth.js';

const SECRET = process.env.JWT_SECRET;

// ── helpers ────────────────────────────────────────────────────────────────
const flush = () => new Promise((r) => setImmediate(r));

function makeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.on = () => res; // requestLogger attaches to 'finish'; noop here
  return res;
}

// Grab the FINAL handler registered for method+path on an express Router,
// skipping the leading middlewares (rate-limit, auth) in the route's stack.
function lastHandler(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path} on router`);
  const handlers = layer.route.stack.filter((s) => !s.method || s.method === method);
  return handlers[handlers.length - 1].handle;
}

// Swap prisma.adminAuditLog.create for the duration of `fn`, restoring after.
async function withAuditCreate(impl, fn) {
  const original = prisma.adminAuditLog.create;
  prisma.adminAuditLog.create = impl;
  try {
    return await fn();
  } finally {
    prisma.adminAuditLog.create = original;
  }
}

// ── 1. recordAudit best-effort + happy path ─────────────────────────────────

test('recordAudit writes exactly one row on the happy path', async () => {
  const rows = [];
  const fakePrisma = { adminAuditLog: { create: async ({ data }) => { rows.push(data); return data; } } };
  await recordAudit(
    { action: AUDIT_ACTIONS.LOGIN, actorUserId: 'u1', tenantId: 't1', outcome: AUDIT_OUTCOME.SUCCESS },
    { prisma: fakePrisma },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'LOGIN');
  assert.equal(rows[0].actorUserId, 'u1');
  assert.equal(rows[0].outcome, 'SUCCESS');
});

test('recordAudit SWALLOWS a create rejection and still resolves', async () => {
  const throwingPrisma = { adminAuditLog: { create: async () => { throw new Error('db is down'); } } };
  const errors = [];
  const fakeLogger = { error: (...a) => errors.push(a) };
  // Must resolve (not reject) even though the underlying insert throws.
  await assert.doesNotReject(
    recordAudit({ action: AUDIT_ACTIONS.LOGIN }, { prisma: throwingPrisma, logger: fakeLogger }),
  );
  assert.equal(errors.length, 1, 'the swallowed failure is logged');
});

test('recordAudit redacts PII/secret metadata before persist', async () => {
  let captured = null;
  const fakePrisma = { adminAuditLog: { create: async ({ data }) => { captured = data; return data; } } };
  await recordAudit(
    { action: AUDIT_ACTIONS.CHANGE_PASSWORD, metadata: { password: 'hunter2', email: 'a@b.com', note: 'keep-me' } },
    { prisma: fakePrisma },
  );
  assert.equal(captured.metadata.password, '[redacted]');
  assert.equal(captured.metadata.email, '[redacted]');
  assert.equal(captured.metadata.note, 'keep-me', 'non-PII keys pass through');
});

// ── 2. Byte-compatible impersonation token ──────────────────────────────────

test('issueImpersonationToken sets `imp` ONLY when impersonatedBy is passed', () => {
  const user = { id: 'u9', email: 'u9@t.com', role: 'ADMIN', tenantId: 't1' };

  const withImp = jwt.verify(authService.issueImpersonationToken(user, { impersonatedBy: 'super-1' }), SECRET);
  assert.equal(withImp.imp, 'super-1');

  const withoutImp = jwt.verify(authService.issueImpersonationToken(user, {}), SECRET);
  assert.ok(!('imp' in withoutImp), 'no imp claim when impersonatedBy absent');
});

test('a normal login token is byte-compatible (no imp; same claim set)', () => {
  const user = { id: 'u9', email: 'u9@t.com', role: 'ADMIN', tenantId: 't1' };
  const normal = jwt.verify(authService.issueTokenForUser(user), SECRET);
  const impAbsent = jwt.verify(authService.issueImpersonationToken(user, {}), SECRET);

  assert.ok(!('imp' in normal), 'normal login token carries no imp claim');
  // Same claim SET as a plain token (iat/exp are wall-clock and excluded).
  const strip = (p) => { const { iat, exp, ...rest } = p; return rest; };
  assert.deepEqual(strip(impAbsent), strip(normal));
});

// ── impersonation integration ───────────────────────────────────────────────

test('impersonate → IMPERSONATION_START row with the super-admin as actor', async () => {
  const target = { id: 'tenant-admin-7', email: 'admin@acme.com', fullName: 'A', role: 'ADMIN', tenantId: 'tenant-acme' };
  const actor = { id: 'super-1', email: 'root@ride', role: 'SUPER_ADMIN' };

  const originalFind = prisma.user.findFirst;
  prisma.user.findFirst = async () => target;
  const rows = [];
  try {
    await withAuditCreate(async ({ data }) => { rows.push(data); return data; }, async () => {
      const out = await tenantsService.impersonateTenantAdmin('tenant-acme', 'tenant-admin-7', { actor });
      // Minted token carries the imp claim naming the super-admin.
      assert.equal(jwt.verify(out.token, SECRET).imp, 'super-1');
    });
  } finally {
    prisma.user.findFirst = originalFind;
  }

  const start = rows.find((r) => r.action === AUDIT_ACTIONS.IMPERSONATION_START);
  assert.ok(start, 'an IMPERSONATION_START row was written');
  assert.equal(start.actorUserId, 'super-1', 'actor is the super-admin');
  assert.equal(start.outcome, 'SUCCESS');
  assert.equal(start.targetId, 'tenant-admin-7', 'target is the impersonated user');
  assert.equal(start.tenantId, 'tenant-acme', 'tenant is the target tenant');
});

test('customer read UNDER an impersonation token → CUSTOMER_RECORD_READ with BOTH ids', async () => {
  const target = { id: 'tenant-admin-7', email: 'admin@acme.com', role: 'ADMIN', tenantId: 'tenant-acme' };
  // A real impersonation token, hydrated through requireAuth exactly like prod.
  const token = authService.issueImpersonationToken(target, { impersonatedBy: 'super-1' });

  const originalGetSession = authService.getSessionUser;
  authService.getSessionUser = async () => ({
    id: 'tenant-admin-7', email: 'admin@acme.com', role: 'ADMIN', tenantId: 'tenant-acme',
    isActive: true, isServiceAccount: false, mustChangePassword: false,
  });
  const originalGetById = customersService.getById;
  customersService.getById = async () => ({ id: 'cust-42', firstName: 'J' });

  const rows = [];
  try {
    const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/api/customers/cust-42', url: '/api/customers/cust-42', params: { id: 'cust-42' }, query: {} };
    const res = makeRes();
    let nextErr = 'not-called';
    await requireAuth(req, res, (e) => { nextErr = e; });
    assert.equal(nextErr, undefined, 'requireAuth passed');
    assert.equal(req.user.imp, 'super-1', 'token imp claim surfaced on req.user.imp');

    await withAuditCreate(async ({ data }) => { rows.push(data); return data; }, async () => {
      const handler = lastHandler(customersRouter, 'get', '/:id');
      await handler(req, res);
      await flush(); // audit is fire-and-forget
    });
  } finally {
    authService.getSessionUser = originalGetSession;
    customersService.getById = originalGetById;
  }

  const read = rows.find((r) => r.action === AUDIT_ACTIONS.CUSTOMER_RECORD_READ);
  assert.ok(read, 'a CUSTOMER_RECORD_READ row was written');
  assert.equal(read.actorUserId, 'tenant-admin-7', 'actor is the impersonated user');
  assert.equal(read.impersonatedByUserId, 'super-1', 'the super-admin behind the session is recorded');
  assert.equal(read.targetId, 'cust-42');
});

// ── noise check ─────────────────────────────────────────────────────────────

test('GET list is NOT audited; GET /:id is audited exactly once', async () => {
  const originalList = customersService.list;
  const originalGetById = customersService.getById;
  customersService.list = async () => [{ id: 'a' }, { id: 'b' }];
  customersService.getById = async () => ({ id: 'cust-42' });

  const baseReq = { user: { id: 'admin-1', email: 'a@t', role: 'ADMIN', tenantId: 't1' }, headers: {}, query: {} };
  const rows = [];
  try {
    await withAuditCreate(async ({ data }) => { rows.push(data); return data; }, async () => {
      // list endpoint
      const listHandler = lastHandler(customersRouter, 'get', '/');
      await listHandler({ ...baseReq }, makeRes());
      await flush();
      assert.equal(rows.length, 0, 'the collection endpoint writes NO audit row');

      // single-record endpoint
      const byIdHandler = lastHandler(customersRouter, 'get', '/:id');
      await byIdHandler({ ...baseReq, params: { id: 'cust-42' } }, makeRes());
      await flush();
      assert.equal(rows.length, 1, 'the single-record endpoint writes exactly one row');
      assert.equal(rows[0].action, AUDIT_ACTIONS.CUSTOMER_RECORD_READ);
    });
  } finally {
    customersService.list = originalList;
    customersService.getById = originalGetById;
  }
});

// ── login: FAILURE audited (no password) + best-effort at the real call site ─

test('login FAILURE is audited with outcome FAILURE and NO password in metadata', async () => {
  const originalLogin = authService.login;
  authService.login = async () => { throw new Error('Invalid credentials'); };
  const rows = [];
  try {
    await withAuditCreate(async ({ data }) => { rows.push(data); return data; }, async () => {
      const handler = lastHandler(authRouter, 'post', '/login');
      const res = makeRes();
      await handler({ body: { email: 'Bad@User.com', password: 'sekret' }, headers: {} }, res);
      await flush();
      assert.equal(res.statusCode, 401);
    });
  } finally {
    authService.login = originalLogin;
  }
  const fail = rows.find((r) => r.action === AUDIT_ACTIONS.LOGIN && r.outcome === AUDIT_OUTCOME.FAILURE);
  assert.ok(fail, 'a LOGIN/FAILURE row was written');
  assert.equal(fail.actorUserId, null, 'actor is unknown on a failed login');
  const metaStr = JSON.stringify(fail.metadata || {});
  assert.ok(!/sekret/.test(metaStr), 'the attempted password is NEVER stored');
  assert.equal(fail.metadata.attemptedEmail, 'bad@user.com', 'the attempted email is recorded (normalized)');
});

test('BEST-EFFORT at the real call site: login STILL succeeds when the audit write throws', async () => {
  const originalLogin = authService.login;
  const result = { token: 'jwt-token', user: { id: 'u1', email: 'u1@t', role: 'ADMIN', tenantId: 't1' } };
  authService.login = async () => result;
  try {
    await withAuditCreate(async () => { throw new Error('audit table gone'); }, async () => {
      const handler = lastHandler(authRouter, 'post', '/login');
      const res = makeRes();
      await handler({ body: { email: 'u1@t', password: 'pw' }, headers: {} }, res);
      await flush();
      // The login response is the normal success payload — the audit failure
      // was swallowed and never touched the request outcome.
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, result);
    });
  } finally {
    authService.login = originalLogin;
  }
});
