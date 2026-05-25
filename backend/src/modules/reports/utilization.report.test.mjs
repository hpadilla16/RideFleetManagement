/**
 * Tests for utilization.report.js (Round 29).
 * Run: node --test backend/src/modules/reports/utilization.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _utilizationInternal } from './utilization.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const {
  computeData, buildDailyCounts, bucketDailySeries, pickGranularity,
  startOfDay, addDays, ACTIVE_STATUSES,
} = _utilizationInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ vehicleTypes = [], reservations = [] } = {}) {
  return {
    vehicleType: {
      async findMany({ where, select }) {
        const rows = vehicleTypes.filter((vt) => !where?.tenantId || vt.tenantId === where.tenantId);
        const vehicleWhere = select?.vehicles?.where || {};
        return rows.map((vt) => ({
          id: vt.id, code: vt.code, name: vt.name,
          vehicles: (vt.vehicles || []).filter((v) => {
            if (vehicleWhere.homeLocationId && v.homeLocationId !== vehicleWhere.homeLocationId) return false;
            return true;
          }).map((v) => ({ id: v.id })),
        }));
      },
    },
    reservation: {
      async findMany({ where }) {
        return reservations.filter((r) => {
          if (where.tenantId && r.tenantId !== where.tenantId) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          if (where.pickupLocationId && r.pickupLocationId !== where.pickupLocationId) return false;
          if (where.vehicleTypeId?.not !== undefined && r.vehicleTypeId === where.vehicleTypeId.not) return false;
          if (where.pickupAt?.lt && new Date(r.pickupAt) >= where.pickupAt.lt) return false;
          if (where.returnAt?.gt && new Date(r.returnAt) <= where.returnAt.gt) return false;
          return true;
        });
      },
    },
  };
}

function vt({ id, code, name, tenantId, capacity, location = null }) {
  const vehicles = [];
  for (let i = 0; i < capacity; i++) {
    vehicles.push({ id: `${id}-v${i}`, homeLocationId: location });
  }
  return { id, code, name, tenantId, vehicles };
}

function res({ id, typeId, tenantId, pickup, ret, location = null, status = 'CHECKED_OUT' }) {
  return {
    id, tenantId, vehicleTypeId: typeId,
    status,
    pickupAt: new Date(pickup),
    returnAt: new Date(ret),
    pickupLocationId: location,
  };
}

const NOW = new Date('2026-05-23T12:00:00Z');

// ---------------------------------------------------------------------------
// Granularity picker
// ---------------------------------------------------------------------------

test('pickGranularity: day ≤ 60', () => {
  assert.equal(pickGranularity(1),  'day');
  assert.equal(pickGranularity(30), 'day');
  assert.equal(pickGranularity(60), 'day');
});
test('pickGranularity: week 61..365', () => {
  assert.equal(pickGranularity(61),  'week');
  assert.equal(pickGranularity(180), 'week');
  assert.equal(pickGranularity(365), 'week');
});
test('pickGranularity: month > 365', () => {
  assert.equal(pickGranularity(366), 'month');
  assert.equal(pickGranularity(730), 'month');
});

// ---------------------------------------------------------------------------
// buildDailyCounts
// ---------------------------------------------------------------------------

test('buildDailyCounts: counts only days an overlapping reservation touches', () => {
  const days = [
    startOfDay(new Date('2026-05-20')),
    startOfDay(new Date('2026-05-21')),
    startOfDay(new Date('2026-05-22')),
    startOfDay(new Date('2026-05-23')),
  ];
  const reservations = [
    // Spans May 21 (inclusive) → May 23 (exclusive) — touches May 21 + May 22 only
    { vehicleTypeId: 'A', pickupAt: new Date('2026-05-21T10:00:00Z'), returnAt: new Date('2026-05-23T09:00:00Z') },
    // Spans May 20 → May 22 — touches May 20 + May 21
    { vehicleTypeId: 'A', pickupAt: new Date('2026-05-20T08:00:00Z'), returnAt: new Date('2026-05-22T08:00:00Z') },
  ];
  const { fleetReserved, typeReserved } = buildDailyCounts(days, ['A'], reservations);
  assert.deepEqual(fleetReserved, [1, 2, 1, 0]);
  assert.deepEqual(typeReserved[0], [1, 2, 1, 0]);
});

test('buildDailyCounts: per-type bucketing keeps types separate', () => {
  const days = [startOfDay(new Date('2026-05-20')), startOfDay(new Date('2026-05-21'))];
  const { typeReserved } = buildDailyCounts(days, ['A', 'B'], [
    { vehicleTypeId: 'A', pickupAt: new Date('2026-05-20'), returnAt: new Date('2026-05-22') },
    { vehicleTypeId: 'B', pickupAt: new Date('2026-05-20'), returnAt: new Date('2026-05-21') },
  ]);
  assert.deepEqual(typeReserved[0], [1, 1]); // type A
  assert.deepEqual(typeReserved[1], [1, 0]); // type B
});

// ---------------------------------------------------------------------------
// bucketDailySeries
// ---------------------------------------------------------------------------

test('bucketDailySeries: passes through unchanged for day granularity', () => {
  const days = [startOfDay(new Date('2026-05-20')), startOfDay(new Date('2026-05-21'))];
  const buckets = bucketDailySeries(days, [3, 5], 'day');
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].daysInBucket, 1);
  assert.equal(buckets[0].sumReserved, 3);
  assert.equal(buckets[1].sumReserved, 5);
});

test('bucketDailySeries: weekly groups by ISO week starting Monday', () => {
  // Sun May 17 → Sat May 23 = week 1; Sun May 24 → Mon May 25 starts week 2.
  // ISO week-start is Monday, so:
  //   Sun May 17 → previous week
  //   Mon May 18 → week of May 18
  //   Sun May 24 → still week of May 18
  //   Mon May 25 → week of May 25
  const days = [
    startOfDay(new Date('2026-05-17')), // Sun  — week of May 11
    startOfDay(new Date('2026-05-18')), // Mon  — week of May 18
    startOfDay(new Date('2026-05-24')), // Sun  — week of May 18
    startOfDay(new Date('2026-05-25')), // Mon  — week of May 25
  ];
  const buckets = bucketDailySeries(days, [1, 2, 3, 4], 'week');
  assert.equal(buckets.length, 3);
  // Bucket 1: just Sun May 17
  assert.equal(buckets[0].daysInBucket, 1);
  assert.equal(buckets[0].sumReserved, 1);
  // Bucket 2: May 18 + May 24
  assert.equal(buckets[1].daysInBucket, 2);
  assert.equal(buckets[1].sumReserved, 5);
  // Bucket 3: May 25
  assert.equal(buckets[2].daysInBucket, 1);
  assert.equal(buckets[2].sumReserved, 4);
});

test('bucketDailySeries: monthly groups by calendar month', () => {
  const days = [
    startOfDay(new Date('2026-04-29')),
    startOfDay(new Date('2026-04-30')),
    startOfDay(new Date('2026-05-01')),
    startOfDay(new Date('2026-05-02')),
  ];
  const buckets = bucketDailySeries(days, [1, 1, 1, 1], 'month');
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].daysInBucket, 2);
  assert.equal(buckets[1].daysInBucket, 2);
  assert.equal(buckets[0].label, 'Apr 2026');
  assert.equal(buckets[1].label, 'May 2026');
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

test('computeData: fleet-wide averages with daily granularity', async () => {
  // 4 days, fleet capacity 5. Each day 1 reservation = 1/5 = 20%. Avg 20%.
  const prisma = makePrisma({
    vehicleTypes: [vt({ id: 'A', code: 'A', name: 'A', tenantId: 't1', capacity: 5 })],
    reservations: [
      res({ id: 'r', typeId: 'A', tenantId: 't1', pickup: '2026-05-20T08:00:00Z', ret: '2026-05-24T08:00:00Z' }),
    ],
  });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-20', to: '2026-05-23', query: {},
  }, { prisma, now: NOW });
  assert.equal(out.granularity, 'day');
  assert.equal(out.fleet.capacity, 5);
  assert.equal(out.fleet.buckets.length, 4);
  // Each day reserved=1, capacity=5 → utilization = 0.2
  for (const b of out.fleet.buckets) {
    assert.ok(Math.abs(b.utilization - 0.2) < 0.0001);
  }
  // Avg = 4 rental-days / (5 capacity × 4 days) = 4/20 = 0.2
  assert.ok(Math.abs(out.fleet.averageUtilization - 0.2) < 0.0001);
  assert.equal(out.fleet.totalRentalDays, 4);
  assert.equal(out.fleet.capacityUnitDays, 20);
});

test('computeData: granularity auto-switches based on range', async () => {
  const prisma = makePrisma({
    vehicleTypes: [vt({ id: 'A', code: 'A', name: 'A', tenantId: 't1', capacity: 1 })],
    reservations: [],
  });
  // 100 days → weekly
  const wk = await computeData({
    tenantId: 't1', from: '2026-02-01', to: '2026-05-12', query: {},
  }, { prisma, now: NOW });
  assert.equal(wk.granularity, 'week');

  // 400 days → monthly
  const mo = await computeData({
    tenantId: 't1', from: '2025-01-01', to: '2026-02-05', query: {},
  }, { prisma, now: NOW });
  assert.equal(mo.granularity, 'month');
});

test('computeData: per-type utilization sorted desc', async () => {
  const prisma = makePrisma({
    vehicleTypes: [
      vt({ id: 'A', code: 'A', name: 'Economy', tenantId: 't1', capacity: 5 }),
      vt({ id: 'B', code: 'B', name: 'SUV',     tenantId: 't1', capacity: 2 }),
    ],
    reservations: [
      // SUV: 2 reservations × 4 days = 8 rental-days, capacity 2 × 4 days = 8 → 100%
      res({ id: 's1', typeId: 'B', tenantId: 't1', pickup: '2026-05-20', ret: '2026-05-24' }),
      res({ id: 's2', typeId: 'B', tenantId: 't1', pickup: '2026-05-20', ret: '2026-05-24' }),
      // Economy: 1 reservation × 4 days = 4 rental-days, capacity 5 × 4 days = 20 → 20%
      res({ id: 'e1', typeId: 'A', tenantId: 't1', pickup: '2026-05-20', ret: '2026-05-24' }),
    ],
  });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-20', to: '2026-05-23', query: {},
  }, { prisma, now: NOW });
  assert.equal(out.byType[0].name, 'SUV');
  assert.equal(out.byType[0].utilizationPct, 1.0);
  assert.equal(out.byType[1].name, 'Economy');
  assert.ok(Math.abs(out.byType[1].utilizationPct - 0.2) < 0.0001);
});

test('computeData: location filter narrows capacity AND reservations', async () => {
  const prisma = makePrisma({
    vehicleTypes: [{
      id: 'A', code: 'A', name: 'A', tenantId: 't1',
      vehicles: [
        { id: 'v1', homeLocationId: 'L1' },
        { id: 'v2', homeLocationId: 'L1' },
        { id: 'v3', homeLocationId: 'L2' },
      ],
    }],
    reservations: [
      res({ id: 'r1', typeId: 'A', tenantId: 't1', pickup: '2026-05-20', ret: '2026-05-24', location: 'L1' }),
      res({ id: 'r2', typeId: 'A', tenantId: 't1', pickup: '2026-05-20', ret: '2026-05-24', location: 'L2' }),
    ],
  });
  const all = await computeData({
    tenantId: 't1', from: '2026-05-20', to: '2026-05-23', query: {},
  }, { prisma, now: NOW });
  assert.equal(all.fleet.capacity, 3);

  const l1 = await computeData({
    tenantId: 't1', from: '2026-05-20', to: '2026-05-23', query: { locationId: 'L1' },
  }, { prisma, now: NOW });
  assert.equal(l1.fleet.capacity, 2);
  assert.equal(l1.filters.locationId, 'L1');
  // Only the L1 reservation counts → 4 rental-days / (2 × 4) = 50%
  assert.ok(Math.abs(l1.fleet.averageUtilization - 0.5) < 0.0001);
});

test('computeData: lastYear is null unless compareLastYear=true', async () => {
  const prisma = makePrisma({
    vehicleTypes: [vt({ id: 'A', code: 'A', name: 'A', tenantId: 't1', capacity: 5 })],
    reservations: [],
  });
  const out1 = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-10', query: {},
  }, { prisma, now: NOW });
  assert.equal(out1.lastYear, null);

  const out2 = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-10', query: { compareLastYear: 'true' },
  }, { prisma, now: NOW });
  assert.ok(out2.lastYear);
  assert.equal(out2.lastYear.hasData, false);
});

test('computeData: lastYear hasData=true when LY reservations exist', async () => {
  const prisma = makePrisma({
    vehicleTypes: [vt({ id: 'A', code: 'A', name: 'A', tenantId: 't1', capacity: 5 })],
    reservations: [
      res({ id: 'ly', typeId: 'A', tenantId: 't1', pickup: '2025-05-02', ret: '2025-05-05' }),
    ],
  });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-10', query: { compareLastYear: '1' },
  }, { prisma, now: NOW });
  assert.ok(out.lastYear);
  assert.equal(out.lastYear.hasData, true);
  assert.equal(out.lastYear.sampleSize, 1);
  assert.ok(Array.isArray(out.lastYear.buckets));
});

test('computeData: range over 730 days is truncated', async () => {
  const prisma = makePrisma({
    vehicleTypes: [vt({ id: 'A', code: 'A', name: 'A', tenantId: 't1', capacity: 1 })],
    reservations: [],
  });
  const out = await computeData({
    tenantId: 't1', from: '2024-01-01', to: '2026-05-01', query: {},
  }, { prisma, now: NOW });
  assert.equal(out.truncated, true);
  assert.equal(out.rangeDays, 730);
});

// ---------------------------------------------------------------------------
// Route mount — utilization has no drill-down sub-route
// ---------------------------------------------------------------------------

test('registerReport mounts standard routes for utilization', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/utilization'),       'data route');
  assert.ok(paths.has('/utilization/pdf'),   'pdf route');
  assert.ok(paths.has('/utilization/excel'), 'excel route');
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

test('ACTIVE_STATUSES excludes CANCELLED and NO_SHOW', () => {
  assert.ok(!ACTIVE_STATUSES.includes('CANCELLED'));
  assert.ok(!ACTIVE_STATUSES.includes('NO_SHOW'));
  assert.ok(ACTIVE_STATUSES.includes('CHECKED_OUT'));
  assert.ok(ACTIVE_STATUSES.includes('CHECKED_IN'));
});
