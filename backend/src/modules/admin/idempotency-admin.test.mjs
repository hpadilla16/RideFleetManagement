// VozIA Fase 6 re-scope (2026-07-04) — SUPER_ADMIN idempotency-resolve ops endpoint.
// Exercises the resolve handler with an injected fake prisma, plus the
// requireRole('SUPER_ADMIN') mount gate (super-admin passes; others 403).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdempotencyAdminRouter } from './idempotency-admin.routes.js';
import { requireRole } from '../../middleware/auth.js';

// Pull the POST /resolve handler out of the Express router's stack so we can call
// it directly with fake req/res (no HTTP server needed).
function resolveHandler(deps) {
  const router = createIdempotencyAdminRouter(deps);
  const layer = router.stack.find((l) => l.route && l.route.path === '/resolve');
  return layer.route.stack[0].handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const silentLogger = { warn() {}, info() {}, error() {} };

function fakePrisma(count, existing = null) {
  const calls = [];
  return {
    _calls: calls,
    idempotencyKey: {
      async deleteMany({ where }) { calls.push(where); return { count }; },
      async findFirst() { return existing; }
    }
  };
}

async function callHandler(handler, req) {
  const res = fakeRes();
  let nextErr = null;
  await handler(req, res, (e) => { nextErr = e; });
  return { res, nextErr };
}

test('resolve: SUPER_ADMIN frees a STUCK (IN_PROGRESS) key → deleted:1, scoped to IN_PROGRESS', async () => {
  const prisma = fakePrisma(1);
  const handler = resolveHandler({ prisma, logger: silentLogger });
  const { res } = await callHandler(handler, {
    body: { userId: 'svc1', key: 'vozia-ticket-0001' },
    user: { role: 'SUPER_ADMIN', sub: 'admin1' }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, deleted: 1 });
  // Default (no force) scopes the delete to IN_PROGRESS — never a COMPLETED result row.
  assert.deepEqual(prisma._calls[0], { userId: 'svc1', key: 'vozia-ticket-0001', status: 'IN_PROGRESS' });
});

test('resolve: unknown key is idempotent → 200 deleted:0 (no 404 noise)', async () => {
  const prisma = fakePrisma(0, null);
  const handler = resolveHandler({ prisma, logger: silentLogger });
  const { res } = await callHandler(handler, {
    body: { userId: 'svc1', key: 'never-existed-key' },
    user: { role: 'SUPER_ADMIN', sub: 'admin1' }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, deleted: 0 });
});

test('resolve: a COMPLETED key is NOT deleted without force → deleted:0, skipped:completed', async () => {
  const prisma = fakePrisma(0, { status: 'COMPLETED' });
  const handler = resolveHandler({ prisma, logger: silentLogger });
  const { res } = await callHandler(handler, {
    body: { userId: 'svc1', key: 'done-key' },
    user: { role: 'SUPER_ADMIN', sub: 'admin1' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, 0);
  assert.equal(res.body.skipped, 'completed');
});

test('resolve: force:true deletes even a COMPLETED key (unscoped)', async () => {
  const prisma = fakePrisma(1);
  const handler = resolveHandler({ prisma, logger: silentLogger });
  const { res } = await callHandler(handler, {
    body: { userId: 'svc1', key: 'done-key', force: true },
    user: { role: 'SUPER_ADMIN', sub: 'admin1' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, 1);
  assert.deepEqual(prisma._calls[0], { userId: 'svc1', key: 'done-key' });
});

test('resolve: missing userId or key → 400', async () => {
  const handler = resolveHandler({ prisma: fakePrisma(0), logger: silentLogger });
  const a = await callHandler(handler, { body: { key: 'k' }, user: { role: 'SUPER_ADMIN' } });
  assert.equal(a.res.statusCode, 400);
  const b = await callHandler(handler, { body: { userId: 'u' }, user: { role: 'SUPER_ADMIN' } });
  assert.equal(b.res.statusCode, 400);
});

// The 403 gate lives at the mount (requireRole('SUPER_ADMIN')) — verify it here so
// the access contract is regression-covered alongside the handler.
test('mount gate: requireRole(SUPER_ADMIN) allows super-admin, 403s others', () => {
  const mw = requireRole('SUPER_ADMIN');
  const run = (user) => {
    let nextCalled = false;
    const res = fakeRes();
    mw({ user }, res, () => { nextCalled = true; });
    return { nextCalled, res };
  };
  assert.equal(run({ role: 'SUPER_ADMIN' }).nextCalled, true);
  const admin = run({ role: 'ADMIN' });
  assert.equal(admin.nextCalled, false);
  assert.equal(admin.res.statusCode, 403);
  const agent = run({ role: 'AGENT' });
  assert.equal(agent.res.statusCode, 403);
});
