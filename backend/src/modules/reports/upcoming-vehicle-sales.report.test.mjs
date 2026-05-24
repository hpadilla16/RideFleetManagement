/**
 * Tests for upcoming-vehicle-sales.report.js (Round 29).
 * Run: node --test backend/src/modules/reports/upcoming-vehicle-sales.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _upcomingVehicleSalesInternal } from './upcoming-vehicle-sales.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, bucketize, ageYears, DEFAULT_MAX_MILEAGE, DEFAULT_MAX_AGE, DEFAULT_APPROACHING_PCT } = _upcomingVehicleSalesInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ vehicles = [] } = {}) {
  return {
    vehicle: {
      async findMany({ where, orderBy, take }) {
        let rows = vehicles.filter((v) => {
          if (where.tenantId && v.tenantId !== where.tenantId) return false;
          if (where.homeLocationId && v.homeLocationId !== where.homeLocationId) return false;
          // OR branch: mileage >= X OR year <= Y
          if (Array.isArray(where.OR)) {
            const m = Number(v.mileage) || 0;
            const y = v.year;
            const mileageOk = where.OR.some((c) => c.mileage?.gte !== undefined) && m >= where.OR.find((c) => c.mileage?.gte !== undefined).mileage.gte;
            const yearClause = where.OR.find((c) => c.year?.lte !== undefined);
            const yearOk = yearClause && y != null && y <= yearClause.year.lte;
            if (!mileageOk && !yearOk) return false;
          }
          return true;
        });
        if (Array.isArray(orderBy)) {
          rows = [...rows].sort((a, b) => Number(b.mileage) - Number(a.mileage));
        }
        if (take && rows.length > take) rows = rows.slice(0, take);
        return rows;
      },
    },
  };
}

let _idSeq = 0;
function veh({ id, mileage, year, status = 'AVAILABLE', tenantId = 't1', location = null, plate = null }) {
  const useId = id || `v${++_idSeq}`;
  return {
    id: useId,
    tenantId,
    status,
    plate: plate || `PL${useId}`,
    internalNumber: useId,
    year,
    make: 'Toyota',
    model: 'Camry',
    color: 'white',
    mileage,
    homeLocationId: location,
    vehicleType: { id: 'T', code: 'T', name: 'Sedan' },
    homeLocation: location ? { id: location, name: `Loc ${location}` } : null,
  };
}

// Fixed "now" so age math is deterministic — 2026-05-23
const NOW = new Date('2026-05-23T12:00:00Z');

// ---------------------------------------------------------------------------
// ageYears
// ---------------------------------------------------------------------------

test('ageYears: simple year delta', () => {
  assert.equal(ageYears(2020, 2026), 6);
  assert.equal(ageYears(2026, 2026), 0);
});

test('ageYears: null/invalid year returns null', () => {
  assert.equal(ageYears(null, 2026), null);
  assert.equal(ageYears(undefined, 2026), null);
});

// ---------------------------------------------------------------------------
// bucketize — pure
// ---------------------------------------------------------------------------

test('bucketize: mileage above threshold → OVER', () => {
  const out = bucketize({ mileage: 70000, age: 1, maxMileage: 60000, maxAge: 4, approachingPct: 0.1 });
  assert.equal(out, 'OVER');
});

test('bucketize: mileage exactly at threshold → OVER', () => {
  // 60000 is gte 60000
  assert.equal(
    bucketize({ mileage: 60000, age: 1, maxMileage: 60000, maxAge: 4, approachingPct: 0.1 }),
    'OVER',
  );
});

test('bucketize: age above threshold → OVER', () => {
  assert.equal(
    bucketize({ mileage: 10000, age: 5, maxMileage: 60000, maxAge: 4, approachingPct: 0.1 }),
    'OVER',
  );
});

test('bucketize: mileage in approaching zone (between 90% and 100% of threshold)', () => {
  // 90% of 60000 = 54000; vehicle at 55000 should be APPROACHING
  assert.equal(
    bucketize({ mileage: 55000, age: 1, maxMileage: 60000, maxAge: 4, approachingPct: 0.1 }),
    'APPROACHING',
  );
});

test('bucketize: age in approaching zone', () => {
  // 90% of 4 = 3.6; vehicle 4 years old would be OVER; 3.8 years APPROACHING
  assert.equal(
    bucketize({ mileage: 10000, age: 3.8, maxMileage: 60000, maxAge: 4, approachingPct: 0.1 }),
    'APPROACHING',
  );
});

test('bucketize: well below both → SAFE', () => {
  assert.equal(
    bucketize({ mileage: 20000, age: 2, maxMileage: 60000, maxAge: 4, approachingPct: 0.1 }),
    'SAFE',
  );
});

test('bucketize: null age only considers mileage', () => {
  assert.equal(
    bucketize({ mileage: 70000, age: null, maxMileage: 60000, maxAge: 4, approachingPct: 0.1 }),
    'OVER',
  );
  assert.equal(
    bucketize({ mileage: 20000, age: null, maxMileage: 60000, maxAge: 4, approachingPct: 0.1 }),
    'SAFE',
  );
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('Defaults: 60,000 mi · 4 yrs · 10% approaching zone', () => {
  assert.equal(DEFAULT_MAX_MILEAGE, 60000);
  assert.equal(DEFAULT_MAX_AGE, 4);
  assert.equal(DEFAULT_APPROACHING_PCT, 0.10);
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

test('computeData: groups vehicles into OVER and APPROACHING; omits SAFE', async () => {
  const prisma = makePrisma({ vehicles: [
    veh({ id: 'over1', mileage: 70000, year: 2020 }),         // OVER (mileage + age)
    veh({ id: 'over2', mileage: 30000, year: 2021 }),         // OVER (age 5 > 4)
    veh({ id: 'appr',  mileage: 55000, year: 2024 }),         // APPROACHING (mileage 90%)
    veh({ id: 'safe',  mileage: 10000, year: 2024 }),         // SAFE (will be excluded by prisma where clause but guarded too)
  ] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  assert.equal(out.totals.overCount, 2);
  assert.equal(out.totals.approachingCount, 1);
  assert.equal(out.totals.candidateCount, 3);
  assert.equal(out.buckets[0].key, 'OVER');
  assert.equal(out.buckets[1].key, 'APPROACHING');
});

test('computeData: respects custom thresholds from query', async () => {
  const prisma = makePrisma({ vehicles: [
    veh({ id: 'v1', mileage: 45000, year: 2024 }),
    veh({ id: 'v2', mileage: 60000, year: 2023 }),
  ] });
  // Lower threshold to 40k → both are OVER
  const tight = await computeData({
    tenantId: 't1', query: { maxMileage: '40000', maxAge: '10' },
  }, { prisma, now: NOW });
  assert.equal(tight.totals.overCount, 2);
  assert.equal(tight.thresholds.maxMileage, 40000);

  // Raise threshold to 80k and age 10 → both SAFE (and approaching zone is 72k+)
  const loose = await computeData({
    tenantId: 't1', query: { maxMileage: '80000', maxAge: '10' },
  }, { prisma, now: NOW });
  assert.equal(loose.totals.candidateCount, 0);
});

test('computeData: reasons[] surfaces the right cause of inclusion', async () => {
  const prisma = makePrisma({ vehicles: [
    veh({ id: 'mileageOnly', mileage: 70000, year: 2024 }),  // mileage trigger; age safe
    veh({ id: 'ageOnly',     mileage: 5000,  year: 2020 }),  // age 6 > 4; mileage safe
  ] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  const over = out.buckets[0].vehicles;
  const byId = Object.fromEntries(over.map((v) => [v.id, v]));
  assert.ok(byId.mileageOnly.reasons.some((r) => r.toLowerCase().includes('mileage')));
  assert.ok(byId.ageOnly.reasons.some((r) => r.toLowerCase().includes('age')));
});

test('computeData: location filter narrows by homeLocationId', async () => {
  const prisma = makePrisma({ vehicles: [
    veh({ id: 'L1a', mileage: 70000, year: 2020, location: 'L1' }),
    veh({ id: 'L2a', mileage: 70000, year: 2020, location: 'L2' }),
  ] });
  const onlyL1 = await computeData({
    tenantId: 't1', query: { locationId: 'L1' },
  }, { prisma, now: NOW });
  assert.equal(onlyL1.totals.candidateCount, 1);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: empty fleet returns all-clear (no candidates)', async () => {
  const prisma = makePrisma({ vehicles: [] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  assert.equal(out.totals.candidateCount, 0);
  assert.equal(out.buckets[0].count, 0);
  assert.equal(out.buckets[1].count, 0);
});

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

test('registerReport mounts standard routes for upcoming-vehicle-sales', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/upcoming-vehicle-sales'),       'data route');
  assert.ok(paths.has('/upcoming-vehicle-sales/pdf'),   'pdf route');
  assert.ok(paths.has('/upcoming-vehicle-sales/excel'), 'excel route');
});
