/**
 * Tests for rental-status.report.js (Round 27).
 * Run: node --test backend/src/modules/reports/rental-status.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _rentalStatusInternal } from './rental-status.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, groupDrillDownHandler, bucketReservations, GROUP_ORDER } = _rentalStatusInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ reservations = [] } = {}) {
  return {
    reservation: {
      async findMany({ where, orderBy }) {
        let rows = reservations.filter((r) => {
          if (where.tenantId && r.tenantId !== where.tenantId) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          if (where.pickupLocationId && r.pickupLocationId !== where.pickupLocationId) return false;
          return true;
        });
        if (Array.isArray(orderBy)) {
          rows = [...rows].sort((a, b) => new Date(a.returnAt) - new Date(b.returnAt));
        }
        return rows;
      },
    },
  };
}

function res({ id, status, pickup, ret, tenantId = 't1', location = null, balance = 0 }) {
  return {
    id, tenantId, status,
    reservationNumber: `R-${id}`,
    pickupAt: new Date(pickup), returnAt: new Date(ret),
    pickupLocationId: location,
    customer: { firstName: 'Test', lastName: id, phone: '555-1234' },
    vehicle: { plate: `PL${id}`, year: 2024, make: 'Toyota', model: 'Camry' },
    vehicleType: { id: 'T1', name: 'Sedan', code: 'SDN' },
    pickupLocation: location ? { id: location, name: `Loc ${location}` } : null,
    rentalAgreement: status === 'CHECKED_IN_UNPAID' || status === 'CHECKED_OUT'
      ? { id: `ag-${id}`, agreementNumber: `A-${id}`, balance }
      : null,
  };
}

// Fixed "now" for deterministic tests. May 23 2026 14:32 UTC.
const NOW = new Date('2026-05-23T14:32:00Z');
const TODAY = new Date('2026-05-23T00:00:00Z');

// ---------------------------------------------------------------------------
// bucketReservations — pure function
// ---------------------------------------------------------------------------

test('bucketReservations: empty input returns empty buckets', () => {
  const out = bucketReservations([], NOW);
  for (const g of GROUP_ORDER) {
    assert.equal(out[g.key].length, 0);
  }
});

test('bucketReservations: CHECKED_OUT splits into OVERDUE / DUE_TODAY / CURRENTLY_OUT by returnAt', () => {
  const out = bucketReservations([
    // Returned in the past — OVERDUE
    res({ id: 'late1', status: 'CHECKED_OUT', pickup: '2026-05-15', ret: '2026-05-20T16:00:00Z' }),
    // Return today (any time on May 23) — DUE_TODAY
    res({ id: 'today1', status: 'CHECKED_OUT', pickup: '2026-05-18', ret: '2026-05-23T17:00:00Z' }),
    // Return future — CURRENTLY_OUT
    res({ id: 'future1', status: 'CHECKED_OUT', pickup: '2026-05-20', ret: '2026-05-30T12:00:00Z' }),
  ], NOW);
  assert.equal(out.OVERDUE.length, 1);
  assert.equal(out.OVERDUE[0].id, 'late1');
  assert.equal(out.DUE_TODAY.length, 1);
  assert.equal(out.DUE_TODAY[0].id, 'today1');
  assert.equal(out.CURRENTLY_OUT.length, 1);
  assert.equal(out.CURRENTLY_OUT[0].id, 'future1');
});

test('bucketReservations: CHECKED_IN_UNPAID lands in UNPAID_AT_CHECKIN regardless of dates', () => {
  const out = bucketReservations([
    res({ id: 'u1', status: 'CHECKED_IN_UNPAID', pickup: '2026-05-10', ret: '2026-05-20T16:00:00Z', balance: 140 }),
  ], NOW);
  assert.equal(out.UNPAID_AT_CHECKIN.length, 1);
  assert.equal(out.UNPAID_AT_CHECKIN[0].id, 'u1');
  // Balance carried through formatRow
  assert.equal(out.UNPAID_AT_CHECKIN[0].balance, 140);
});

test('bucketReservations: NEW/CONFIRMED with pickupAt today → PICKING_UP_TODAY; future pickups dropped', () => {
  const out = bucketReservations([
    res({ id: 'p1', status: 'CONFIRMED', pickup: '2026-05-23T10:00:00Z', ret: '2026-05-25T16:00:00Z' }),
    res({ id: 'p2', status: 'NEW',       pickup: '2026-05-23T15:00:00Z', ret: '2026-05-24T16:00:00Z' }),
    // Future pickup, should be skipped entirely
    res({ id: 'future', status: 'CONFIRMED', pickup: '2026-05-30T10:00:00Z', ret: '2026-06-02T16:00:00Z' }),
  ], NOW);
  assert.equal(out.PICKING_UP_TODAY.length, 2);
  // Future pickup not in any bucket
  for (const g of GROUP_ORDER) {
    assert.ok(!out[g.key].some((r) => r.id === 'future'),
      `future pickup should not appear in ${g.key}`);
  }
});

test('bucketReservations: days-from-return is negative for overdue, positive for currently-out', () => {
  const out = bucketReservations([
    res({ id: 'late', status: 'CHECKED_OUT', pickup: '2026-05-15', ret: '2026-05-20T16:00:00Z' }),
    res({ id: 'soon', status: 'CHECKED_OUT', pickup: '2026-05-20', ret: '2026-05-30T12:00:00Z' }),
  ], NOW);
  // Today = May 23; late returnAt = May 20 → -3 days
  assert.equal(out.OVERDUE[0].daysFromReturn, -3);
  // soon returnAt = May 30 → +7 days
  assert.equal(out.CURRENTLY_OUT[0].daysFromReturn, 7);
});

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

test('computeData rejects without tenantId', async () => {
  await assert.rejects(
    () => computeData({ query: {} }, {}),
    (err) => /tenantId/.test(err.message),
  );
});

test('computeData: callouts roll up to the right totals', async () => {
  const prisma = makePrisma({ reservations: [
    res({ id: 'late1',  status: 'CHECKED_OUT',       pickup: '2026-05-15', ret: '2026-05-20T16:00:00Z' }),
    res({ id: 'late2',  status: 'CHECKED_OUT',       pickup: '2026-05-15', ret: '2026-05-22T16:00:00Z' }),
    res({ id: 'today',  status: 'CHECKED_OUT',       pickup: '2026-05-18', ret: '2026-05-23T17:00:00Z' }),
    res({ id: 'out',    status: 'CHECKED_OUT',       pickup: '2026-05-20', ret: '2026-05-30T12:00:00Z' }),
    res({ id: 'pick1',  status: 'CONFIRMED',         pickup: '2026-05-23T10:00:00Z', ret: '2026-05-25T16:00:00Z' }),
    res({ id: 'unpaid', status: 'CHECKED_IN_UNPAID', pickup: '2026-05-10', ret: '2026-05-20T16:00:00Z', balance: 85 }),
  ] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });

  assert.equal(out.callouts.overdue, 2);
  assert.equal(out.callouts.dueBackToday, 1);
  assert.equal(out.callouts.pickingUpToday, 1);
  assert.equal(out.callouts.unpaidAtCheckin, 1);
  // currentlyOut = overdue + dueBackToday + currentlyOut group
  assert.equal(out.callouts.currentlyOut, 4);
});

test('computeData: statusMix counts active reservations by lifecycle bucket', async () => {
  const prisma = makePrisma({ reservations: [
    res({ id: 'a', status: 'NEW',               pickup: '2026-05-23T10:00:00Z', ret: '2026-05-25T10:00:00Z' }),
    res({ id: 'b', status: 'CONFIRMED',         pickup: '2026-05-30T10:00:00Z', ret: '2026-06-02T10:00:00Z' }),
    res({ id: 'c', status: 'CHECKED_OUT',       pickup: '2026-05-18',           ret: '2026-05-28T10:00:00Z' }),
    res({ id: 'd', status: 'CHECKED_IN_UNPAID', pickup: '2026-05-10',           ret: '2026-05-20T16:00:00Z' }),
  ] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  assert.equal(out.statusMix.OPEN, 2);
  assert.equal(out.statusMix.OUT, 1);
  assert.equal(out.statusMix.RETURNED, 1);
  assert.equal(out.totalActive, 4);
});

test('computeData: groups are ordered for triage (OVERDUE first, CURRENTLY_OUT last)', async () => {
  const prisma = makePrisma({ reservations: [] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  assert.deepEqual(
    out.groups.map((g) => g.key),
    ['OVERDUE', 'UNPAID_AT_CHECKIN', 'DUE_TODAY', 'PICKING_UP_TODAY', 'CURRENTLY_OUT'],
  );
});

test('computeData: location filter narrows by pickupLocationId', async () => {
  const prisma = makePrisma({ reservations: [
    res({ id: 'L1a', status: 'CHECKED_OUT', pickup: '2026-05-18', ret: '2026-05-28T12:00:00Z', location: 'L1' }),
    res({ id: 'L2a', status: 'CHECKED_OUT', pickup: '2026-05-18', ret: '2026-05-28T12:00:00Z', location: 'L2' }),
    res({ id: 'L1b', status: 'CHECKED_OUT', pickup: '2026-05-18', ret: '2026-05-28T12:00:00Z', location: 'L1' }),
  ] });
  const all = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  assert.equal(all.totalActive, 3);

  const onlyL1 = await computeData({ tenantId: 't1', query: { locationId: 'L1' } }, { prisma, now: NOW });
  assert.equal(onlyL1.totalActive, 2);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: no active rentals → all groups empty, callouts zero', async () => {
  const prisma = makePrisma({ reservations: [] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  for (const g of out.groups) {
    assert.equal(g.count, 0);
  }
  assert.equal(out.callouts.currentlyOut, 0);
  assert.equal(out.callouts.overdue, 0);
});

// ---------------------------------------------------------------------------
// groupDrillDownHandler
// ---------------------------------------------------------------------------

test('groupDrillDownHandler: 400 when group missing or unknown', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await groupDrillDownHandler({ query: {} }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /group must be one of/);

  statusCode = null; body = null;
  await groupDrillDownHandler({ query: { group: 'NOT_A_GROUP' } }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
});

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

test('registerReport mounts the standard + /group routes for rental-status', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/rental-status'),       'data route');
  assert.ok(paths.has('/rental-status/pdf'),   'pdf route');
  assert.ok(paths.has('/rental-status/excel'), 'excel route');
  assert.ok(paths.has('/rental-status/group'), '/group drill-down sub-route');
});
