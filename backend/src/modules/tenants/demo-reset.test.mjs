/**
 * Demo reset — guards and delete order.
 *
 * This deletes data, so the tests care about REFUSING more than about
 * succeeding: the only tenant it may ever touch is one the database itself
 * flags as the demo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKING_CHILDREN, TENANT_SCOPED_CLEARS, RESET_CONFIRMATION,
  assertResettable, assertConfirmed, summarize,
} from './demo-reset.js';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
const { demoResetService } = await import('./demo-reset.service.js');

// ── guards ──────────────────────────────────────────────────────────────────

test('refuses a tenant that is not flagged as the demo', () => {
  for (const isDemo of [false, null, undefined, 'true', 1]) {
    assert.throws(
      () => assertResettable({ id: 't1', name: 'International Rental Corp', isDemo }),
      (e) => e.status === 403 && /not the demo tenant/.test(e.message),
      `isDemo=${JSON.stringify(isDemo)} must not pass — only exactly true`,
    );
  }
});

test('a real tenant name appears in the refusal so the mistake is obvious', () => {
  assert.throws(
    () => assertResettable({ id: 't1', name: 'Corpusa', isDemo: false }),
    (e) => e.message.includes('Corpusa'),
  );
});

test('missing tenant is a 404, not a silent no-op', () => {
  assert.throws(() => assertResettable(null), (e) => e.status === 404);
});

test('the demo tenant passes', () => {
  const t = { id: 'demo', name: 'Demo', isDemo: true };
  assert.equal(assertResettable(t), t);
});

test('confirmation phrase is required, case-insensitive, trimmed', () => {
  assert.doesNotThrow(() => assertConfirmed(RESET_CONFIRMATION));
  assert.doesNotThrow(() => assertConfirmed('  reset demo  '));
  for (const bad of ['', null, 'RESET', 'yes', 'DELETE DEMO']) {
    assert.throws(() => assertConfirmed(bad), (e) => e.status === 400);
  }
});

// ── the service, against a fake db ───────────────────────────────────────────

function fakeDb({ tenant, reservationIds = ['r1', 'r2'] }) {
  const calls = [];
  const model = (name) => ({
    deleteMany: async ({ where }) => { calls.push([name, where]); return { count: 1 }; },
  });
  const tx = new Proxy({
    reservation: {
      findMany: async () => reservationIds.map((id) => ({ id })),
      deleteMany: async ({ where }) => { calls.push(['reservation', where]); return { count: reservationIds.length }; },
    },
    vehicle: {
      updateMany: async ({ where, data }) => { calls.push(['vehicle.updateMany', where, data]); return { count: 3 }; },
    },
  }, {
    get(target, prop) { return prop in target ? target[prop] : model(String(prop)); },
  });
  return {
    calls,
    db: {
      tenant: { findUnique: async () => tenant },
      $transaction: async (fn) => fn(tx),
    },
  };
}

const SILENT = { warn: () => {}, info: () => {} };

test('a non-demo tenant is refused BEFORE anything is deleted', async () => {
  const { db, calls } = fakeDb({ tenant: { id: 't1', name: 'Corpusa', isDemo: false } });
  await assert.rejects(
    () => demoResetService.reset('t1', RESET_CONFIRMATION, {}, { prisma: db, logger: SILENT }),
    (e) => e.status === 403,
  );
  assert.deepEqual(calls, [], 'nothing may be deleted on a refused reset');
});

test('a wrong confirmation is refused before the tenant is even loaded', async () => {
  let loaded = false;
  const db = { tenant: { findUnique: async () => { loaded = true; return null; } }, $transaction: async () => ({}) };
  await assert.rejects(
    () => demoResetService.reset('demo', 'nope', {}, { prisma: db, logger: SILENT }),
    (e) => e.status === 400,
  );
  assert.equal(loaded, false);
});

test('blockers are cleared before reservations, then vehicles are freed', async () => {
  const { db, calls } = fakeDb({ tenant: { id: 'demo', name: 'Demo', isDemo: true } });
  const out = await demoResetService.reset('demo', RESET_CONFIRMATION, { userId: 'u1' }, { prisma: db, logger: SILENT });

  const order = calls.map((c) => c[0]);
  for (const blocker of BLOCKING_CHILDREN) {
    assert.ok(order.includes(blocker), `${blocker} must be cleared`);
    assert.ok(order.indexOf(blocker) < order.indexOf('reservation'), `${blocker} must go BEFORE reservations`);
  }
  for (const t of TENANT_SCOPED_CLEARS) {
    assert.ok(order.indexOf(t) > order.indexOf('reservation'), `${t} is tenant-scoped, cleared after`);
  }
  assert.equal(order[order.length - 1], 'vehicle.updateMany');

  // Vehicles: only the states a rental cycle produces.
  const veh = calls.find((c) => c[0] === 'vehicle.updateMany');
  assert.deepEqual(veh[1].status, { in: ['RESERVED', 'ON_RENT'] });
  assert.equal(veh[2].status, 'AVAILABLE');

  assert.equal(out.ok, true);
  assert.equal(out.counts.reservation, 2);
  assert.match(out.summary, /reservation/);
});

test('every delete is scoped — never a bare deleteMany', async () => {
  const { db, calls } = fakeDb({ tenant: { id: 'demo', name: 'Demo', isDemo: true } });
  await demoResetService.reset('demo', RESET_CONFIRMATION, {}, { prisma: db, logger: SILENT });
  for (const [name, where] of calls) {
    assert.ok(where && Object.keys(where).length > 0, `${name} ran without a WHERE — that would cross tenants`);
    const scoped = 'tenantId' in where || 'reservationId' in where;
    assert.ok(scoped, `${name} must be scoped by tenantId or reservationId, got ${JSON.stringify(where)}`);
  }
});

test('a clean demo reports honestly instead of pretending to work', () => {
  assert.match(summarize({}), /already clean/);
});
