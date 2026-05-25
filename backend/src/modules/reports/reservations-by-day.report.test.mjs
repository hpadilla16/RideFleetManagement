/**
 * Tests for reservations-by-day.report.js (Round 27).
 * Run: node --test backend/src/modules/reports/reservations-by-day.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _reservationsByDayInternal } from './reservations-by-day.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, dayDrillDownHandler, STATUS_TO_BUCKET } = _reservationsByDayInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ reservations = [] } = {}) {
  return {
    reservation: {
      async findMany({ where, select, orderBy }) {
        let rows = reservations.filter((r) => {
          if (where.tenantId && r.tenantId !== where.tenantId) return false;
          if (where.pickupLocationId && r.pickupLocationId !== where.pickupLocationId) return false;
          if (where.pickupAt?.gte && new Date(r.pickupAt) < where.pickupAt.gte) return false;
          if (where.pickupAt?.lt  && new Date(r.pickupAt) >= where.pickupAt.lt)  return false;
          return true;
        });
        if (orderBy?.pickupAt === 'asc') {
          rows = [...rows].sort((a, b) => new Date(a.pickupAt) - new Date(b.pickupAt));
        }
        return rows.map((r) => {
          if (select) {
            const out = {};
            for (const k of Object.keys(select)) {
              if (k === 'customer'   && r.customer)        out.customer = r.customer;
              else if (k === 'vehicle'      && r.vehicle)       out.vehicle = r.vehicle;
              else if (k === 'vehicleType'  && r.vehicleType)   out.vehicleType = r.vehicleType;
              else if (k === 'pickupLocation' && r.pickupLocation) out.pickupLocation = r.pickupLocation;
              else if (r[k] !== undefined) out[k] = r[k];
            }
            return out;
          }
          return r;
        });
      },
    },
  };
}

function res({ id, status, pickup, tenantId = 't1', location = null }) {
  return {
    id, tenantId, status,
    pickupAt: new Date(pickup), returnAt: new Date(new Date(pickup).getTime() + 86400000),
    pickupLocationId: location,
    reservationNumber: `RES-${id}`,
  };
}

// ---------------------------------------------------------------------------
// Status bucketing
// ---------------------------------------------------------------------------

test('STATUS_TO_BUCKET maps every ReservationStatus enum value exactly once', () => {
  const allStatuses = ['NEW', 'CONFIRMED', 'CHECKED_OUT', 'CHECKED_IN', 'CHECKED_IN_UNPAID', 'CANCELLED', 'NO_SHOW', 'PENDING_FRANCHISE_IMPORT'];
  for (const s of allStatuses) {
    assert.ok(STATUS_TO_BUCKET[s], `${s} should map to a bucket`);
  }
  // No stray statuses
  assert.equal(Object.keys(STATUS_TO_BUCKET).length, allStatuses.length);
});

test('STATUS_TO_BUCKET groups statuses correctly', () => {
  assert.equal(STATUS_TO_BUCKET.NEW,                       'OPEN');
  assert.equal(STATUS_TO_BUCKET.CONFIRMED,                 'OPEN');
  assert.equal(STATUS_TO_BUCKET.PENDING_FRANCHISE_IMPORT,  'OPEN');
  assert.equal(STATUS_TO_BUCKET.CHECKED_OUT,               'OUT');
  assert.equal(STATUS_TO_BUCKET.CHECKED_IN,                'RETURNED');
  assert.equal(STATUS_TO_BUCKET.CHECKED_IN_UNPAID,         'RETURNED');
  assert.equal(STATUS_TO_BUCKET.CANCELLED,                 'LOST');
  assert.equal(STATUS_TO_BUCKET.NO_SHOW,                   'LOST');
});

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

test('computeData rejects without tenantId', async () => {
  await assert.rejects(
    () => computeData({ from: '2026-05-01', to: '2026-05-03' }, {}),
    (err) => /tenantId/.test(err.message),
  );
});

test('computeData returns full hybrid shape', async () => {
  const prisma = makePrisma({ reservations: [
    res({ id: 'a', status: 'CONFIRMED',   pickup: '2026-05-01T10:00:00Z' }),
    res({ id: 'b', status: 'CHECKED_OUT', pickup: '2026-05-01T14:00:00Z' }),
    res({ id: 'c', status: 'CHECKED_IN',  pickup: '2026-05-02T09:00:00Z' }),
    res({ id: 'd', status: 'CANCELLED',   pickup: '2026-05-02T15:00:00Z' }),
    res({ id: 'e', status: 'NO_SHOW',     pickup: '2026-05-03T11:00:00Z' }),
  ] });

  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-03', query: {},
  }, { prisma });

  assert.equal(out.days.length, 3);
  assert.equal(out.totals.OPEN,     1, 'OPEN total');
  assert.equal(out.totals.OUT,      1, 'OUT total');
  assert.equal(out.totals.RETURNED, 1, 'RETURNED total');
  assert.equal(out.totals.LOST,     2, 'LOST total (CANCELLED + NO_SHOW)');
  assert.equal(out.totals.total,    5);

  // Day 1: 1 OPEN + 1 OUT
  assert.equal(out.days[0].counts.OPEN, 1);
  assert.equal(out.days[0].counts.OUT,  1);
  assert.equal(out.days[0].total, 2);

  // Day 2: 1 RETURNED + 1 LOST
  assert.equal(out.days[1].counts.RETURNED, 1);
  assert.equal(out.days[1].counts.LOST,     1);

  // Peak day = day 1 OR day 2 (both total 2); since day 0 has total 2 first, it wins
  assert.ok(out.peak.total === 2);

  // completedPickups = OUT + RETURNED
  assert.equal(out.completedPickups, 2);
  // completedRate = 2 / 5 = 0.4
  assert.ok(Math.abs(out.completedRate - 0.4) < 0.0001);
  // cancelRate = 2 / 5 = 0.4
  assert.ok(Math.abs(out.cancelRate - 0.4) < 0.0001);

  assert.equal(out.filters.locationId, null);
  assert.deepEqual(out.bucketOrder, ['OPEN', 'OUT', 'RETURNED', 'LOST']);
});

test('computeData: peak day is the busiest pickup day', async () => {
  const prisma = makePrisma({ reservations: [
    // Day 0: 1 pickup
    res({ id: 'a', status: 'CONFIRMED', pickup: '2026-05-01T10:00:00Z' }),
    // Day 1: 3 pickups (peak)
    res({ id: 'b', status: 'CONFIRMED', pickup: '2026-05-02T10:00:00Z' }),
    res({ id: 'c', status: 'CHECKED_OUT', pickup: '2026-05-02T11:00:00Z' }),
    res({ id: 'd', status: 'CHECKED_IN', pickup: '2026-05-02T12:00:00Z' }),
    // Day 2: 2 pickups
    res({ id: 'e', status: 'NEW', pickup: '2026-05-03T10:00:00Z' }),
    res({ id: 'f', status: 'NEW', pickup: '2026-05-03T11:00:00Z' }),
  ] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-03', query: {},
  }, { prisma });
  assert.equal(out.peak.iso, '2026-05-02');
  assert.equal(out.peak.total, 3);
});

test('computeData: location filter narrows reservations', async () => {
  const prisma = makePrisma({ reservations: [
    res({ id: 'l1', status: 'CONFIRMED', pickup: '2026-05-01T10:00:00Z', location: 'L1' }),
    res({ id: 'l2', status: 'CONFIRMED', pickup: '2026-05-01T11:00:00Z', location: 'L2' }),
    res({ id: 'l3', status: 'CONFIRMED', pickup: '2026-05-01T12:00:00Z', location: 'L1' }),
  ] });

  const all = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-01', query: {},
  }, { prisma });
  assert.equal(all.totals.total, 3);

  const onlyL1 = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-01', query: { locationId: 'L1' },
  }, { prisma });
  assert.equal(onlyL1.totals.total, 2);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: window with no reservations returns zero totals + zero rates', async () => {
  const prisma = makePrisma({ reservations: [] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-03', query: {},
  }, { prisma });
  assert.equal(out.days.length, 3);
  assert.equal(out.totals.total, 0);
  assert.equal(out.completedPickups, 0);
  assert.equal(out.completedRate, 0);
  assert.equal(out.cancelRate, 0);
});

test('computeData: truncated=true when window exceeds 92 days', async () => {
  const prisma = makePrisma({ reservations: [] });
  const out = await computeData({
    tenantId: 't1', from: '2026-01-01', to: '2026-06-30', query: {},
  }, { prisma });
  assert.equal(out.truncated, true);
  assert.equal(out.days.length, 92);
});

// ---------------------------------------------------------------------------
// dayDrillDownHandler
// ---------------------------------------------------------------------------

test('dayDrillDownHandler: 400 when day missing', async () => {
  let statusCode = null, body = null;
  const r = {
    status(c) { statusCode = c; return this; },
    json(b)   { body = b;       return this; },
  };
  await dayDrillDownHandler({ query: {} }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /day query param/);
});

test('dayDrillDownHandler: 400 when day is not ISO', async () => {
  let statusCode = null, body = null;
  const r = {
    status(c) { statusCode = c; return this; },
    json(b)   { body = b;       return this; },
  };
  await dayDrillDownHandler({ query: { day: 'not-a-date' } }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /ISO date/);
});

// ---------------------------------------------------------------------------
// registerReport mounted the routes
// ---------------------------------------------------------------------------

test('registerReport mounts the standard + /day routes for reservations-by-day', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/reservations-by-day'),       'data route');
  assert.ok(paths.has('/reservations-by-day/pdf'),   'pdf route');
  assert.ok(paths.has('/reservations-by-day/excel'), 'excel route');
  assert.ok(paths.has('/reservations-by-day/day'),   '/day drill-down sub-route');
});
