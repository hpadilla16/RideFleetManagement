/**
 * Tests for toll-per-location.report.js (Round 30).
 * Run: node --test backend/src/modules/reports/toll-per-location.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _tollPerLocationInternal } from './toll-per-location.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, aggregateByPlaza, plazaDrillDownHandler, UNKNOWN_PLAZA_KEY, UNKNOWN_PLAZA_LABEL } = _tollPerLocationInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ transactions = [] } = {}) {
  return {
    tollTransaction: {
      async findMany({ where, orderBy, take }) {
        let rows = transactions.filter((t) => {
          if (where.tenantId && t.tenantId !== where.tenantId) return false;
          if (where.transactionAt?.gte && new Date(t.transactionAt) < where.transactionAt.gte) return false;
          if (where.transactionAt?.lt && new Date(t.transactionAt) >= where.transactionAt.lt) return false;
          if (typeof where.location === 'string' && t.location !== where.location) return false;
          if (Array.isArray(where.OR)) {
            // Unknown-plaza branch: location null or empty
            if (!(t.location == null || t.location === '')) return false;
          }
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
function tx({ id, vehicleId = null, amount, when, location = null, tenantId = 't1', status = 'IMPORTED', needsReview = false, vehicleHome = null }) {
  const useId = id || `t${++_idSeq}`;
  return {
    id: useId,
    tenantId,
    vehicleId,
    amount,
    transactionAt: new Date(when),
    location,
    lane: null,
    direction: null,
    plateRaw: null,
    tagRaw: null,
    status,
    needsReview,
    reservationId: null,
    vehicle: vehicleId ? {
      plate: `PL${vehicleId}`, year: 2024, make: 'Toyota', model: 'Camry',
      homeLocationId: vehicleHome,
    } : null,
  };
}

const NOW = new Date('2026-05-23T12:00:00Z');

// ---------------------------------------------------------------------------
// aggregateByPlaza — pure
// ---------------------------------------------------------------------------

test('aggregateByPlaza: empty input', () => {
  assert.deepEqual(aggregateByPlaza([]), []);
});

test('aggregateByPlaza: groups by plaza name and sums', () => {
  const plazas = aggregateByPlaza([
    tx({ amount: 1.50, when: '2026-05-20', location: 'Plaza A' }),
    tx({ amount: 2.50, when: '2026-05-21', location: 'Plaza A' }),
    tx({ amount: 0.75, when: '2026-05-22', location: 'Plaza B' }),
  ]);
  assert.equal(plazas.length, 2);
  const a = plazas.find((p) => p.label === 'Plaza A');
  assert.equal(a.count, 2);
  assert.equal(a.amount, 4.0);
  assert.equal(a.averagePerTxn, 2.0);
});

test('aggregateByPlaza: empty/null plaza goes to Unknown plaza bucket', () => {
  const plazas = aggregateByPlaza([
    tx({ amount: 1, when: '2026-05-20', location: null }),
    tx({ amount: 2, when: '2026-05-21', location: '' }),
    tx({ amount: 3, when: '2026-05-22', location: '   ' }), // whitespace also unknown
    tx({ amount: 4, when: '2026-05-23', location: 'Plaza A' }),
  ]);
  const unknown = plazas.find((p) => p.isUnknown);
  assert.ok(unknown);
  assert.equal(unknown.label, UNKNOWN_PLAZA_LABEL);
  assert.equal(unknown.key, UNKNOWN_PLAZA_KEY);
  assert.equal(unknown.count, 3);
  assert.equal(unknown.amount, 6);
});

test('aggregateByPlaza: sorted by total amount desc', () => {
  const plazas = aggregateByPlaza([
    tx({ amount: 1,  when: '2026-05-20', location: 'small' }),
    tx({ amount: 50, when: '2026-05-20', location: 'big' }),
    tx({ amount: 25, when: '2026-05-20', location: 'mid' }),
  ]);
  assert.deepEqual(plazas.map((p) => p.label), ['big', 'mid', 'small']);
});

test('aggregateByPlaza: top vehicles per plaza, max 3, sorted by amount desc', () => {
  const plazas = aggregateByPlaza([
    tx({ vehicleId: 'V1', amount: 5,  when: '2026-05-20', location: 'P' }),
    tx({ vehicleId: 'V2', amount: 10, when: '2026-05-20', location: 'P' }),
    tx({ vehicleId: 'V3', amount: 7,  when: '2026-05-20', location: 'P' }),
    tx({ vehicleId: 'V4', amount: 3,  when: '2026-05-20', location: 'P' }),
    tx({ vehicleId: 'V5', amount: 2,  when: '2026-05-20', location: 'P' }),
  ]);
  const p = plazas[0];
  assert.equal(p.topVehicles.length, 3);
  assert.deepEqual(p.topVehicles.map((v) => v.vehicleId), ['V2', 'V3', 'V1']);
});

test('aggregateByPlaza: unmatched (no vehicle) transactions still credit the plaza', () => {
  const plazas = aggregateByPlaza([
    tx({ vehicleId: null, amount: 5, when: '2026-05-20', location: 'P' }),
    tx({ vehicleId: 'V1', amount: 3, when: '2026-05-20', location: 'P' }),
  ]);
  assert.equal(plazas[0].count, 2);
  assert.equal(plazas[0].amount, 8);
  // topVehicles only counts the matched one
  assert.equal(plazas[0].topVehicles.length, 1);
  assert.equal(plazas[0].topVehicles[0].vehicleId, 'V1');
});

test('aggregateByPlaza: float arithmetic stays clean', () => {
  const plazas = aggregateByPlaza([
    tx({ amount: 0.10, when: '2026-05-20', location: 'P' }),
    tx({ amount: 0.20, when: '2026-05-21', location: 'P' }),
  ]);
  assert.equal(plazas[0].amount, 0.30);
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

test('computeData: returns shape with totals + busiest plaza + unknown bucket', async () => {
  const prisma = makePrisma({ transactions: [
    tx({ amount: 1.50, when: '2026-05-20', location: 'Plaza A' }),
    tx({ amount: 2.50, when: '2026-05-20', location: 'Plaza A' }),
    tx({ amount: 0.75, when: '2026-05-20', location: 'Plaza B' }),
    tx({ amount: 1.00, when: '2026-05-20', location: null }),
  ] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-15', to: '2026-05-30', query: {},
  }, { prisma, now: NOW });
  assert.equal(out.totals.amount, 5.75);
  assert.equal(out.totals.count, 4);
  assert.equal(out.totals.plazaCount, 2); // known plazas A + B
  assert.equal(out.totals.unknownCount, 1);
  assert.equal(out.totals.unknownAmount, 1);
  assert.equal(out.totals.busiestPlazaLabel, 'Plaza A');
  assert.equal(out.totals.busiestPlazaAmount, 4);
});

test('computeData: location filter narrows by vehicle.homeLocationId', async () => {
  const prisma = makePrisma({ transactions: [
    tx({ vehicleId: 'V1', amount: 5, when: '2026-05-20', location: 'P', vehicleHome: 'L1' }),
    tx({ vehicleId: 'V2', amount: 7, when: '2026-05-20', location: 'P', vehicleHome: 'L2' }),
  ] });
  const all = await computeData({
    tenantId: 't1', from: '2026-05-15', to: '2026-05-30', query: {},
  }, { prisma, now: NOW });
  assert.equal(all.totals.amount, 12);

  const onlyL1 = await computeData({
    tenantId: 't1', from: '2026-05-15', to: '2026-05-30', query: { locationId: 'L1' },
  }, { prisma, now: NOW });
  assert.equal(onlyL1.totals.amount, 5);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: empty window returns sensible zeros', async () => {
  const prisma = makePrisma({ transactions: [] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-10', query: {},
  }, { prisma, now: NOW });
  assert.equal(out.totals.amount, 0);
  assert.equal(out.totals.count, 0);
  assert.equal(out.totals.plazaCount, 0);
  assert.equal(out.totals.busiestPlazaLabel, null);
  assert.equal(out.plazas.length, 0);
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
// plazaDrillDownHandler
// ---------------------------------------------------------------------------

test('plazaDrillDownHandler: 400 when plaza missing', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await plazaDrillDownHandler({ query: {} }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /plaza query param/);
});

test('plazaDrillDownHandler: 400 on invalid from date', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await plazaDrillDownHandler({ query: { plaza: 'P', from: 'garbage' } }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
});

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

test('registerReport mounts standard + /transactions routes for toll-per-location', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/toll-per-location'),              'data route');
  assert.ok(paths.has('/toll-per-location/pdf'),          'pdf route');
  assert.ok(paths.has('/toll-per-location/excel'),        'excel route');
  assert.ok(paths.has('/toll-per-location/transactions'), '/transactions sub-route');
});
