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
  function matchReservation(r, where) {
    if (where.tenantId && r.tenantId !== where.tenantId) return false;
    if (typeof where.status === 'string' && r.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(r.status)) return false;
    if (where.pickupAt?.gte && new Date(r.pickupAt) < where.pickupAt.gte) return false;
    if (where.pickupAt?.lt && new Date(r.pickupAt) >= where.pickupAt.lt) return false;
    if (where.pickupAt?.lte && new Date(r.pickupAt) > where.pickupAt.lte) return false;
    if (where.returnAt?.gt && new Date(r.returnAt) <= where.returnAt.gt) return false;
    if (where.vehicleId?.not !== undefined && r.vehicleId == null) return false;
    return true;
  }

  return {
    rentalAgreementPayment: {
      async findMany({ where }) {
        return payments.filter((p) => {
          if (where.rentalAgreement?.tenantId && p.tenantId !== where.rentalAgreement.tenantId) return false;
          if (where.paidAt?.gte && p.paidAt < where.paidAt.gte) return false;
          if (where.paidAt?.lt && p.paidAt >= where.paidAt.lt) return false;
          if (where.paidAt?.lte && p.paidAt > where.paidAt.lte) return false;
          return true;
        });
      },
    },
    reservation: {
      async count({ where }) {
        return reservations.filter((r) => matchReservation(r, where)).length;
      },
      async findMany({ where, select }) {
        return reservations.filter((r) => matchReservation(r, where)).map((r) => {
          if (!select) return r;
          const out = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
          return out;
        });
      },
    },
    vehicle: {
      async count({ where }) {
        return vehicles.filter((v) => {
          if (where.tenantId && v.tenantId !== where.tenantId) return false;
          if (where.status?.not && v.status === where.status.not) return false;
          if (typeof where.status === 'string' && v.status !== where.status) return false;
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

test('listReports returns directory with the current registry length', async () => {
  const out = await listReports({ tenantId: 't1' });
  // Includes 2 coming-soon slugs (damage, chargeback) on top of the 16
  // AVAILABLE reports.
  assert.equal(out.reports.length, 18);
  assert.deepEqual(out.categories, ['MANAGEMENT', 'FLEET', 'OPERATIONS', 'REVENUE']);
});

test('listReports marks the AVAILABLE reports correctly (rest COMING_SOON)', async () => {
  const out = await listReports({ tenantId: 't1' });
  const available = out.reports.filter((r) => r.status === 'AVAILABLE').map((r) => r.slug);
  assert.deepEqual(
    available.sort(),
    [
      'agent-track-record',
      'availability',
      'availability-forecast',
      'commission-sales-performance',
      'fleet-status',
      'payments-by-day',
      'pre-paid-reservations',
      'rental-status',
      'reservations-by-day',
      'sales',
      'taxes',
      'toll-per-location',
      'toll-per-vehicle',
      'unpaid-balance',
      'utilization',
    ].sort(),
  );
});

test('listReports omits the deprecated `url` field (frontend builds URLs from slug)', async () => {
  const out = await listReports({ tenantId: 't1' });
  for (const r of out.reports) {
    assert.equal(r.url, undefined, `${r.slug} should not return a url field`);
    assert.ok(r.slug, `${r.slug} should have a slug`);
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

test('getSnapshot — revenue, reservations checked out, and available count', async () => {
  // "now" mid-month so we have a defined window
  const now = new Date('2026-05-22T16:00:00Z');
  const prisma = makeFakePrisma({
    payments: [
      { tenantId: 't1', amount: 100, paidAt: new Date('2026-05-10T15:00:00Z') },
      { tenantId: 't1', amount: 250.50, paidAt: new Date('2026-05-15T18:00:00Z') },
      { tenantId: 't1', amount: 999, paidAt: new Date('2026-04-30T10:00:00Z') }, // outside
      { tenantId: 't2', amount: 500, paidAt: new Date('2026-05-12T10:00:00Z') }, // wrong tenant
    ],
    reservations: [
      // Picked up in window — count
      { tenantId: 't1', status: 'CHECKED_OUT',         pickupAt: new Date('2026-05-10T14:00:00Z'), returnAt: new Date('2026-05-30T14:00:00Z'), vehicleId: 'v1' },
      { tenantId: 't1', status: 'CHECKED_IN_UNPAID',   pickupAt: new Date('2026-05-05T14:00:00Z'), returnAt: new Date('2026-05-15T14:00:00Z'), vehicleId: 'v2' },
      // Picked up but later returned (still picked up in window) — count
      { tenantId: 't1', status: 'CHECKED_IN',          pickupAt: new Date('2026-05-03T14:00:00Z'), returnAt: new Date('2026-05-08T14:00:00Z'), vehicleId: 'v3' },
      // NEW / not yet checked out — don't count
      { tenantId: 't1', status: 'NEW',                 pickupAt: new Date('2026-05-25T14:00:00Z'), returnAt: new Date('2026-05-28T14:00:00Z'), vehicleId: 'v4' },
      // Other tenant — don't count
      { tenantId: 't2', status: 'CHECKED_OUT',         pickupAt: new Date('2026-05-12T14:00:00Z'), returnAt: new Date('2026-05-22T14:00:00Z'), vehicleId: 'vX' },
    ],
    vehicles: [
      { tenantId: 't1', status: 'AVAILABLE' },
      { tenantId: 't1', status: 'AVAILABLE' },
      { tenantId: 't1', status: 'ON_RENT' },
      { tenantId: 't1', status: 'ON_RENT' },
      { tenantId: 't1', status: 'OUT_OF_SERVICE' }, // retired/totaled — excluded
    ],
  });
  const out = await getSnapshot({
    tenantId: 't1',
    from: '2026-05-01',
    to: '2026-05-22',
    deps: { prisma, now, tenantTz: 'America/Puerto_Rico' },
  });
  assert.equal(out.revenue, 350.5);
  // Three reservations picked up in window (CHECKED_OUT + CHECKED_IN_UNPAID + CHECKED_IN)
  assert.equal(out.reservationsCheckedOut, 3);
  // totalFleet excludes OUT_OF_SERVICE → 4 vehicles
  assert.equal(out.totalFleet, 4);
  // Active reservations covering "now" (2026-05-22): v1 (out 5/10→5/30)
  // and v2 has returnAt 5/15 < now → not active. v3 returnAt 5/8 < now →
  // not active. So 1 vehicle currently rented.
  assert.equal(out.currentlyRented, 1);
  assert.equal(out.availableVehicles, 3);
  assert.equal(out.utilizationPct, 25);
});

test('getSnapshot survives prisma errors gracefully (returns zeros)', async () => {
  const prisma = {
    rentalAgreementPayment: { findMany: async () => { throw new Error('table missing'); } },
    reservation: {
      count: async () => { throw new Error('table missing'); },
      findMany: async () => { throw new Error('table missing'); },
    },
    vehicle: { count: async () => { throw new Error('table missing'); } },
  };
  const out = await getSnapshot({ tenantId: 't1', deps: { prisma, tenantTz: 'America/Puerto_Rico' } });
  assert.equal(out.revenue, 0);
  assert.equal(out.reservationsCheckedOut, 0);
  assert.equal(out.availableVehicles, 0);
  assert.equal(out.totalFleet, 0);
});
