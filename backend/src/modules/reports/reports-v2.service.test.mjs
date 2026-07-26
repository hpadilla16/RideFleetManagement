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

function makeFakePrisma({ payments = [], reservations = [], vehicles = [], vehicleBlocks = [], maintenanceJobs = [] } = {}) {
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
          if (typeof where.status === 'string' && p.status !== where.status) return false;
          if (where.method?.notIn && where.method.notIn.includes(p.method)) return false;
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
          if (where.status?.notIn && where.status.notIn.includes(v.status)) return false;
          if (typeof where.status === 'string' && v.status !== where.status) return false;
          return true;
        }).length;
      },
    },
    vehicleAvailabilityBlock: {
      async findMany({ where }) {
        return vehicleBlocks.filter((b) => {
          if (where.tenantId && b.tenantId !== where.tenantId) return false;
          if (where.releasedAt === null && b.releasedAt != null) return false;
          if (where.blockType?.in && !where.blockType.in.includes(b.blockType)) return false;
          return true;
        });
      },
    },
    maintenanceJob: {
      async findMany({ where }) {
        return maintenanceJobs.filter((j) => {
          if (where.vehicle?.tenantId && j.tenantId !== where.vehicle.tenantId) return false;
          if (where.status?.in && !where.status.in.includes(j.status)) return false;
          return true;
        });
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
  // 17 AVAILABLE + 3 coming-soon slugs (upcoming-vehicle-sales, damage,
  // chargeback). 2026-07-25: +1 — 'commission' (Commission Payouts)
  // resurrected for the LAX #5 approve workflow + review tiers.
  assert.equal(out.reports.length, 20);
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
      'commission',
      'commission-sales-performance',
      'fleet-status',
      'fleet-value',
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
      { tenantId: 't1', amount: 100, method: 'CARD', status: 'PAID', paidAt: new Date('2026-05-10T15:00:00Z') },
      { tenantId: 't1', amount: 250.50, method: 'CASH', status: 'PAID', paidAt: new Date('2026-05-15T18:00:00Z') },
      { tenantId: 't1', amount: 999, method: 'CARD', status: 'PAID', paidAt: new Date('2026-04-30T10:00:00Z') }, // outside
      { tenantId: 't2', amount: 500, method: 'CARD', status: 'PAID', paidAt: new Date('2026-05-12T10:00:00Z') }, // wrong tenant
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
      { tenantId: 't1', id: 'veh-A', status: 'AVAILABLE' },
      { tenantId: 't1', id: 'veh-B', status: 'AVAILABLE' },
      { tenantId: 't1', id: 'veh-C', status: 'ON_RENT' },
      { tenantId: 't1', id: 'veh-D', status: 'ON_RENT' },
      { tenantId: 't1', id: 'veh-E', status: 'OUT_OF_SERVICE' }, // retired/totaled — excluded
    ],
    vehicleBlocks: [
      // One vehicle blocked for maintenance — should drop out of available.
      { tenantId: 't1', vehicleId: 'veh-B', blockType: 'MAINTENANCE_HOLD', releasedAt: null },
    ],
    maintenanceJobs: [],
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
  // v1 (CHECKED_OUT, returnAt 5/30) is within 14d grace from now (5/22) → counts.
  // v2/v3 returned (CHECKED_IN_UNPAID/CHECKED_IN) → don't count.
  assert.equal(out.currentlyRented, 1);
  assert.equal(out.blockedForMaintenance, 1);
  // available = totalFleet (4) − currentlyRented (1) − blocked (1) = 2
  assert.equal(out.availableVehicles, 2);
});

test('getSnapshot revenue counts COLLECTED money only — deposit auth-holds and non-PAID excluded', async () => {
  // Regression for the 2026-07-13 bug: International showed $336k "Revenue in
  // period" when real collected was $47.5k — the raw sum included every
  // security-deposit AUTH_HOLD (never captured) and a VOID payment.
  const now = new Date('2026-05-22T16:00:00Z');
  const prisma = makeFakePrisma({
    payments: [
      { tenantId: 't1', amount: 300,    method: 'CARD',      status: 'PAID',     paidAt: new Date('2026-05-10T15:00:00Z') },
      { tenantId: 't1', amount: 38.87,  method: 'CASH',      status: 'PAID',     paidAt: new Date('2026-05-11T15:00:00Z') },
      // Deposit authorization holds — funds never captured, NOT revenue.
      { tenantId: 't1', amount: 250,    method: 'AUTH_HOLD', status: 'PAID',     paidAt: new Date('2026-05-10T15:05:00Z') },
      { tenantId: 't1', amount: 250000, method: 'AUTH_HOLD', status: 'PAID',     paidAt: new Date('2026-05-12T15:00:00Z') }, // the fat-finger
      // Non-PAID statuses — not collected money.
      { tenantId: 't1', amount: 646.69, method: 'OTHER',     status: 'VOID',     paidAt: new Date('2026-05-13T15:00:00Z') },
      { tenantId: 't1', amount: 75,     method: 'CARD',      status: 'REFUNDED', paidAt: new Date('2026-05-14T15:00:00Z') },
      { tenantId: 't1', amount: 50,     method: 'CARD',      status: 'PENDING',  paidAt: new Date('2026-05-15T15:00:00Z') },
    ],
  });
  const out = await getSnapshot({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-22',
    deps: { prisma, now, tenantTz: 'America/Puerto_Rico' },
  });
  assert.equal(out.revenue, 338.87);
  assert.equal(out.revenueCents, 33887);
});

test('getSnapshot survives prisma errors gracefully (returns zeros)', async () => {
  const prisma = {
    rentalAgreementPayment: { findMany: async () => { throw new Error('table missing'); } },
    reservation: {
      count: async () => { throw new Error('table missing'); },
      findMany: async () => { throw new Error('table missing'); },
    },
    vehicle: { count: async () => { throw new Error('table missing'); } },
    vehicleAvailabilityBlock: { findMany: async () => { throw new Error('table missing'); } },
    maintenanceJob: { findMany: async () => { throw new Error('table missing'); } },
  };
  const out = await getSnapshot({ tenantId: 't1', deps: { prisma, tenantTz: 'America/Puerto_Rico' } });
  assert.equal(out.revenue, 0);
  assert.equal(out.reservationsCheckedOut, 0);
  assert.equal(out.availableVehicles, 0);
  assert.equal(out.totalFleet, 0);
  assert.equal(out.blockedForMaintenance, 0);
});
