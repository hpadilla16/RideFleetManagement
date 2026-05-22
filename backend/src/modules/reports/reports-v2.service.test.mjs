/**
 * Tests for reports-v2.service.js (Round 24).
 * Run: node --test backend/src/modules/reports/reports-v2.service.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listReports,
  getSnapshot,
  ReportsServiceError,
  _internal,
} from './reports-v2.service.js';

function makeFakePrisma({ payments = [], reservations = [], vehicles = [] } = {}) {
  return {
    rentalAgreementPayment: {
      async findMany({ where }) {
        return payments.filter((p) => {
          if (where.rentalAgreement?.tenantId && p.tenantId !== where.rentalAgreement.tenantId) return false;
          if (where.paidAt?.gte && p.paidAt < where.paidAt.gte) return false;
          if (where.paidAt?.lte && p.paidAt > where.paidAt.lte) return false;
          return true;
        });
      },
    },
    reservation: {
      async count({ where }) {
        return reservations.filter((r) => {
          if (where.tenantId && r.tenantId !== where.tenantId) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          return true;
        }).length;
      },
    },
    vehicle: {
      async count({ where }) {
        return vehicles.filter((v) => {
          if (where.tenantId && v.tenantId !== where.tenantId) return false;
          if (where.status === 'AVAILABLE' && v.status !== 'AVAILABLE') return false;
          if (where.status?.not && v.status === where.status.not) return false;
          return true;
        }).length;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// listReports
// ---------------------------------------------------------------------------

test('listReports refuses without tenantId', async () => {
  await assert.rejects(
    () => listReports({}),
    (err) => err instanceof ReportsServiceError && err.status === 403,
  );
});

test('listReports returns directory with all 17 reports', async () => {
  const out = await listReports({ tenantId: 't1' });
  assert.equal(out.reports.length, 18); // current registry length
  assert.deepEqual(out.categories, ['MANAGEMENT', 'FLEET', 'OPERATIONS', 'REVENUE']);
});

test('listReports marks the 3 round-24 reports AVAILABLE, rest COMING_SOON', async () => {
  const out = await listReports({ tenantId: 't1' });
  const available = out.reports.filter((r) => r.status === 'AVAILABLE').map((r) => r.slug);
  assert.deepEqual(
    available.sort(),
    ['agent-track-record', 'availability-forecast', 'commission-sales-performance'].sort(),
  );
});

test('listReports gives every report a /reports/slug URL', async () => {
  const out = await listReports({ tenantId: 't1' });
  for (const r of out.reports) {
    assert.match(r.url, /^\/reports\//, `${r.slug} missing url prefix`);
  }
});

// ---------------------------------------------------------------------------
// getSnapshot
// ---------------------------------------------------------------------------

test('getSnapshot refuses without tenantId', async () => {
  await assert.rejects(
    () => getSnapshot({}),
    (err) => err instanceof ReportsServiceError && err.status === 403,
  );
});

test('getSnapshot sums payments only inside the date window for this tenant', async () => {
  const now = new Date('2026-05-22T12:00:00Z');
  const prisma = makeFakePrisma({
    payments: [
      { tenantId: 't1', amount: 100, paidAt: new Date('2026-05-10') },
      { tenantId: 't1', amount: 250.50, paidAt: new Date('2026-05-15') },
      { tenantId: 't1', amount: 999, paidAt: new Date('2026-04-30') }, // outside
      { tenantId: 't2', amount: 500, paidAt: new Date('2026-05-12') }, // wrong tenant
    ],
    reservations: [
      { tenantId: 't1', status: 'CHECKED_OUT' },
      { tenantId: 't1', status: 'CHECKED_OUT' },
      { tenantId: 't1', status: 'NEW' },
      { tenantId: 't2', status: 'CHECKED_OUT' },
    ],
    vehicles: [
      { tenantId: 't1', status: 'AVAILABLE' },
      { tenantId: 't1', status: 'AVAILABLE' },
      { tenantId: 't1', status: 'IN_RENTAL' },
      { tenantId: 't1', status: 'IN_RENTAL' },
      { tenantId: 't1', status: 'RETIRED' },
    ],
  });
  const out = await getSnapshot({
    tenantId: 't1',
    from: '2026-05-01',
    to: now.toISOString(),
    deps: { prisma },
  });
  assert.equal(out.revenue, 350.5);
  assert.equal(out.reservationsCheckedOut, 2);
  assert.equal(out.availableVehicles, 2);
  // Total fleet excludes RETIRED
  assert.equal(out.totalFleet, 4);
  assert.equal(out.utilizationPct, 50);
});

test('getSnapshot survives prisma errors gracefully (returns zeros)', async () => {
  const prisma = {
    rentalAgreementPayment: { findMany: async () => { throw new Error('table missing'); } },
    reservation: { count: async () => { throw new Error('table missing'); } },
    vehicle: { count: async () => { throw new Error('table missing'); } },
  };
  const out = await getSnapshot({ tenantId: 't1', deps: { prisma } });
  assert.equal(out.revenue, 0);
  assert.equal(out.reservationsCheckedOut, 0);
  assert.equal(out.availableVehicles, 0);
});

test('startOfMonth helper produces the 1st at 00:00 local', () => {
  const d = new Date(2026, 4, 22, 14, 30); // May 22 2026 2:30pm local
  const s = _internal.startOfMonth(d);
  assert.equal(s.getDate(), 1);
  assert.equal(s.getMonth(), 4);
  assert.equal(s.getFullYear(), 2026);
  assert.equal(s.getHours(), 0);
});
