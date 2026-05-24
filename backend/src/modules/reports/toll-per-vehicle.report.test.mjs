/**
 * Tests for toll-per-vehicle.report.js (Round 30).
 * Run: node --test backend/src/modules/reports/toll-per-vehicle.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _tollPerVehicleInternal } from './toll-per-vehicle.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, aggregateByVehicle, transactionsDrillDownHandler } = _tollPerVehicleInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ transactions = [] } = {}) {
  return {
    tollTransaction: {
      async findMany({ where, orderBy, take }) {
        let rows = transactions.filter((t) => {
          if (where.tenantId && t.tenantId !== where.tenantId) return false;
          if (where.vehicleId === null && t.vehicleId != null) return false;
          if (typeof where.vehicleId === 'string' && t.vehicleId !== where.vehicleId) return false;
          if (where.vehicleId?.not !== undefined && t.vehicleId === null) return false;
          if (where.transactionAt?.gte && new Date(t.transactionAt) < where.transactionAt.gte) return false;
          if (where.transactionAt?.lt  && new Date(t.transactionAt) >= where.transactionAt.lt)  return false;
          if (where.vehicle?.homeLocationId && t.vehicle?.homeLocationId !== where.vehicle.homeLocationId) return false;
          return true;
        });
        if (orderBy?.transactionAt === 'desc') {
          rows = [...rows].sort((a, b) => new Date(b.transactionAt) - new Date(a.transactionAt));
        }
        if (take && rows.length > take) rows = rows.slice(0, take);
        return rows;
      },
    },
  };
}

let _idSeq = 0;
function tx({ id, vehicleId = null, amount, when, location = null, lane = null, tenantId = 't1', status = 'IMPORTED', needsReview = false, vehicle = null }) {
  const useId = id || `t${++_idSeq}`;
  return {
    id: useId,
    tenantId,
    vehicleId,
    amount,
    transactionAt: new Date(when),
    location,
    lane,
    direction: null,
    plateRaw: null,
    tagRaw: null,
    status,
    needsReview,
    reservationId: null,
    vehicle: vehicleId ? (vehicle || {
      plate: `PL${vehicleId}`, year: 2024, make: 'Toyota', model: 'Camry',
      homeLocationId: null,
      vehicleType: { name: 'Sedan' },
      homeLocation: null,
    }) : null,
  };
}

const NOW = new Date('2026-05-23T12:00:00Z');

// ---------------------------------------------------------------------------
// aggregateByVehicle — pure
// ---------------------------------------------------------------------------

test('aggregateByVehicle: empty input', () => {
  const out = aggregateByVehicle([]);
  assert.deepEqual(out.vehicles, []);
  assert.equal(out.unmatched.count, 0);
  assert.equal(out.unmatched.amount, 0);
});

test('aggregateByVehicle: groups by vehicleId and sums amounts', () => {
  const out = aggregateByVehicle([
    tx({ vehicleId: 'V1', amount: 1.50, when: '2026-05-20', location: 'Plaza A' }),
    tx({ vehicleId: 'V1', amount: 2.50, when: '2026-05-21', location: 'Plaza B' }),
    tx({ vehicleId: 'V2', amount: 0.75, when: '2026-05-20', location: 'Plaza A' }),
  ]);
  assert.equal(out.vehicles.length, 2);
  const v1 = out.vehicles.find((v) => v.vehicleId === 'V1');
  assert.equal(v1.count, 2);
  assert.equal(v1.amount, 4.0);
});

test('aggregateByVehicle: sorts vehicles by total amount desc', () => {
  const out = aggregateByVehicle([
    tx({ vehicleId: 'small', amount: 1, when: '2026-05-20' }),
    tx({ vehicleId: 'big',   amount: 50, when: '2026-05-20' }),
    tx({ vehicleId: 'mid',   amount: 25, when: '2026-05-20' }),
  ]);
  assert.deepEqual(out.vehicles.map((v) => v.vehicleId), ['big', 'mid', 'small']);
});

test('aggregateByVehicle: topLocations counts visits per plaza, returns top 3', () => {
  const out = aggregateByVehicle([
    tx({ vehicleId: 'V', amount: 1, when: '2026-05-20', location: 'Plaza A' }),
    tx({ vehicleId: 'V', amount: 1, when: '2026-05-21', location: 'Plaza A' }),
    tx({ vehicleId: 'V', amount: 1, when: '2026-05-22', location: 'Plaza B' }),
    tx({ vehicleId: 'V', amount: 1, when: '2026-05-23', location: 'Plaza C' }),
    tx({ vehicleId: 'V', amount: 1, when: '2026-05-24', location: 'Plaza D' }),
  ]);
  const v = out.vehicles[0];
  assert.equal(v.topLocations.length, 3);
  assert.equal(v.topLocations[0].name, 'Plaza A');
  assert.equal(v.topLocations[0].count, 2);
});

test('aggregateByVehicle: unmatched bucket separate, capped at 50 detail rows', () => {
  const txs = [];
  for (let i = 0; i < 60; i++) txs.push(tx({ vehicleId: null, amount: 1.25, when: '2026-05-20' }));
  const out = aggregateByVehicle(txs);
  assert.equal(out.vehicles.length, 0);
  assert.equal(out.unmatched.count, 60);
  assert.equal(out.unmatched.amount, 75);
  assert.equal(out.unmatched.transactions.length, 50, 'detail capped at 50');
});

test('aggregateByVehicle: float arithmetic stays clean', () => {
  const out = aggregateByVehicle([
    tx({ vehicleId: 'V', amount: 0.10, when: '2026-05-20' }),
    tx({ vehicleId: 'V', amount: 0.20, when: '2026-05-21' }),
  ]);
  assert.equal(out.vehicles[0].amount, 0.30);
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

test('computeData: returns shape with totals and per-vehicle rows', async () => {
  const prisma = makePrisma({ transactions: [
    tx({ vehicleId: 'V1', amount: 1.50, when: '2026-05-20', location: 'Plaza A' }),
    tx({ vehicleId: 'V2', amount: 2.00, when: '2026-05-21' }),
    tx({ vehicleId: null, amount: 5.00, when: '2026-05-22' }),
  ] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-15', to: '2026-05-30', query: {},
  }, { prisma, now: NOW });

  assert.equal(out.totals.amount, 8.5);
  assert.equal(out.totals.count, 3);
  assert.equal(out.totals.vehicleCount, 2);
  assert.equal(out.totals.unmatchedCount, 1);
  assert.equal(out.totals.unmatchedAmount, 5);
  assert.equal(out.totals.averagePerVehicle, 1.75); // (1.50+2.00)/2
});

test('computeData: location filter narrows matched; unmatched excluded entirely', async () => {
  const prisma = makePrisma({ transactions: [
    tx({ vehicleId: 'V1', amount: 5, when: '2026-05-20',
         vehicle: { plate: 'V1', year: 2024, make: 'T', model: 'C', homeLocationId: 'L1', vehicleType: { name: 'Sedan' }, homeLocation: null } }),
    tx({ vehicleId: 'V2', amount: 7, when: '2026-05-20',
         vehicle: { plate: 'V2', year: 2024, make: 'T', model: 'C', homeLocationId: 'L2', vehicleType: { name: 'Sedan' }, homeLocation: null } }),
    tx({ vehicleId: null, amount: 3, when: '2026-05-20' }),
  ] });

  const all = await computeData({
    tenantId: 't1', from: '2026-05-15', to: '2026-05-30', query: {},
  }, { prisma, now: NOW });
  assert.equal(all.totals.amount, 15);

  const onlyL1 = await computeData({
    tenantId: 't1', from: '2026-05-15', to: '2026-05-30', query: { locationId: 'L1' },
  }, { prisma, now: NOW });
  // L1 vehicle only, unmatched excluded entirely
  assert.equal(onlyL1.totals.amount, 5);
  assert.equal(onlyL1.totals.unmatchedCount, 0);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: empty window returns zeros and empty buckets', async () => {
  const prisma = makePrisma({ transactions: [] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-10', query: {},
  }, { prisma, now: NOW });
  assert.equal(out.totals.amount, 0);
  assert.equal(out.totals.count, 0);
  assert.equal(out.vehicles.length, 0);
  assert.equal(out.unmatched.count, 0);
});

test('computeData: truncated=true when range exceeds 365 days', async () => {
  const prisma = makePrisma({ transactions: [] });
  const out = await computeData({
    tenantId: 't1', from: '2024-01-01', to: '2026-05-01', query: {},
  }, { prisma, now: NOW });
  assert.equal(out.truncated, true);
  assert.equal(out.rangeDays, 365);
});

// ---------------------------------------------------------------------------
// transactionsDrillDownHandler
// ---------------------------------------------------------------------------

test('transactionsDrillDownHandler: 400 without vehicleId or unmatched=true', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await transactionsDrillDownHandler({ query: {} }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /vehicleId or unmatched/);
});

test('transactionsDrillDownHandler: 400 on invalid from date', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await transactionsDrillDownHandler({ query: { vehicleId: 'V1', from: 'garbage' } }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
});

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

test('registerReport mounts standard + /transactions routes for toll-per-vehicle', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/toll-per-vehicle'),              'data route');
  assert.ok(paths.has('/toll-per-vehicle/pdf'),          'pdf route');
  assert.ok(paths.has('/toll-per-vehicle/excel'),        'excel route');
  assert.ok(paths.has('/toll-per-vehicle/transactions'), '/transactions sub-route');
});
