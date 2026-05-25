/**
 * Tests for unpaid-balance.report.js (Round 28).
 * Run: node --test backend/src/modules/reports/unpaid-balance.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _unpaidBalanceInternal } from './unpaid-balance.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, bucketAgreements, bucketDrillDownHandler, BUCKET_ORDER, EXCLUDED_AGREEMENT_STATUSES } = _unpaidBalanceInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ agreements = [] } = {}) {
  return {
    rentalAgreement: {
      async findMany({ where, orderBy }) {
        let rows = agreements.filter((a) => {
          if (where.tenantId && a.tenantId !== where.tenantId) return false;
          if (where.balance?.gt !== undefined && !(Number(a.balance) > where.balance.gt)) return false;
          if (where.status?.notIn && where.status.notIn.includes(a.status)) return false;
          if (where.pickupLocationId && a.pickupLocationId !== where.pickupLocationId) return false;
          return true;
        });
        if (orderBy?.returnAt === 'asc') {
          rows = [...rows].sort((a, b) => new Date(a.returnAt) - new Date(b.returnAt));
        }
        return rows;
      },
    },
  };
}

let _idSeq = 0;
function agr({ id, balance, returnAt, tenantId = 't1', location = null, status = 'FINALIZED', customer = 'Smith' }) {
  const useId = id || `a${++_idSeq}`;
  return {
    id: useId,
    tenantId,
    reservationId: `r-${useId}`,
    agreementNumber: `A-${useId}`,
    status,
    returnAt: new Date(returnAt),
    balance,
    pickupLocationId: location,
    customerFirstName: 'Test',
    customerLastName: customer,
    customerPhone: '787-555-0100',
    customerEmail: null,
    vehicle: { plate: `PL${useId}`, year: 2024, make: 'Toyota', model: 'Camry' },
    pickupLocation: location ? { id: location, name: `Loc ${location}` } : null,
  };
}

// Fixed "now" — May 23 2026 14:32 UTC
const NOW = new Date('2026-05-23T14:32:00Z');

// ---------------------------------------------------------------------------
// bucketAgreements — pure
// ---------------------------------------------------------------------------

test('bucketAgreements: empty input → all buckets empty', () => {
  const out = bucketAgreements([], NOW);
  for (const b of BUCKET_ORDER) {
    assert.equal(out[b.key].count, 0);
    assert.equal(out[b.key].amount, 0);
    assert.equal(out[b.key].agreements.length, 0);
  }
});

test('bucketAgreements: daysLate boundary mapping', () => {
  // Build agreements that land exactly on each boundary.
  const out = bucketAgreements([
    // returnAt in future → CURRENT
    agr({ id: 'cur',  balance: 100, returnAt: '2026-05-25T12:00:00Z' }),
    // returnAt today → 0 days late → CURRENT
    agr({ id: 'tdy',  balance: 100, returnAt: '2026-05-23T12:00:00Z' }),
    // 1 day late → B1_30
    agr({ id: '1d',   balance: 100, returnAt: '2026-05-22T00:00:00Z' }),
    // 30 days late → B1_30
    agr({ id: '30d',  balance: 100, returnAt: '2026-04-23T00:00:00Z' }),
    // 31 days late → B31_60
    agr({ id: '31d',  balance: 100, returnAt: '2026-04-22T00:00:00Z' }),
    // 60 days late → B31_60
    agr({ id: '60d',  balance: 100, returnAt: '2026-03-24T00:00:00Z' }),
    // 61 days late → B61_90
    agr({ id: '61d',  balance: 100, returnAt: '2026-03-23T00:00:00Z' }),
    // 90 days late → B61_90
    agr({ id: '90d',  balance: 100, returnAt: '2026-02-22T00:00:00Z' }),
    // 91 days late → B90_PLUS
    agr({ id: '91d',  balance: 100, returnAt: '2026-02-21T00:00:00Z' }),
  ], NOW);
  assert.equal(out.CURRENT.count, 2,  'tdy + cur');
  assert.equal(out.B1_30.count, 2,    '1d + 30d');
  assert.equal(out.B31_60.count, 2,   '31d + 60d');
  assert.equal(out.B61_90.count, 2,   '61d + 90d');
  assert.equal(out.B90_PLUS.count, 1, '91d');
});

test('bucketAgreements: amounts sum correctly per bucket', () => {
  const out = bucketAgreements([
    agr({ id: 'a', balance: 100,   returnAt: '2026-05-22T00:00:00Z' }), // 1 day late
    agr({ id: 'b', balance: 250.5, returnAt: '2026-05-20T00:00:00Z' }), // 3 days late
    agr({ id: 'c', balance: 75.50, returnAt: '2026-02-01T00:00:00Z' }), // 111 days late
  ], NOW);
  assert.equal(out.B1_30.amount, 350.5);
  assert.equal(out.B90_PLUS.amount, 75.5);
});

test('bucketAgreements: rows in past-due buckets sorted by daysLate desc', () => {
  const out = bucketAgreements([
    agr({ id: 'late10', balance: 100, returnAt: '2026-05-13T00:00:00Z' }), // ~10 days late
    agr({ id: 'late25', balance: 100, returnAt: '2026-04-28T00:00:00Z' }), // ~25 days late
    agr({ id: 'late2',  balance: 100, returnAt: '2026-05-21T00:00:00Z' }), // ~2 days late
  ], NOW);
  assert.deepEqual(
    out.B1_30.agreements.map((r) => r.id),
    ['late25', 'late10', 'late2'],
  );
});

test('bucketAgreements: CURRENT bucket sorted by returnAt asc (nearest-due first)', () => {
  const out = bucketAgreements([
    agr({ id: 'far',  balance: 100, returnAt: '2026-06-10T00:00:00Z' }),
    agr({ id: 'soon', balance: 100, returnAt: '2026-05-25T00:00:00Z' }),
  ], NOW);
  assert.deepEqual(
    out.CURRENT.agreements.map((r) => r.id),
    ['soon', 'far'],
  );
});

test('bucketAgreements: daysLate is positive for past-due, 0 or negative for current', () => {
  const out = bucketAgreements([
    agr({ id: 'late', balance: 100, returnAt: '2026-05-15T00:00:00Z' }), // 8 days late
    agr({ id: 'cur',  balance: 100, returnAt: '2026-05-30T00:00:00Z' }), // 7 days early
  ], NOW);
  assert.equal(out.B1_30.agreements[0].daysLate, 8);
  assert.equal(out.CURRENT.agreements[0].daysLate, -7);
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

test('computeData: full hybrid shape with totals + bucket ordering', async () => {
  const prisma = makePrisma({ agreements: [
    agr({ balance: 200, returnAt: '2026-04-20T00:00:00Z' }), // ~33 days late → B31_60
    agr({ balance: 100, returnAt: '2026-05-22T00:00:00Z' }), // 1 day late → B1_30
    agr({ balance: 50,  returnAt: '2026-05-28T00:00:00Z' }), // current
    agr({ balance: 75,  returnAt: '2026-01-01T00:00:00Z' }), // 142 days late → B90_PLUS
  ] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });

  assert.equal(out.totals.accountCount, 4);
  assert.equal(out.totals.totalAmount, 425);
  assert.equal(out.totals.pastDueAmount, 375);
  assert.equal(out.totals.pastDueCount, 3);
  // averageBalance = 425/4 = 106.25
  assert.equal(out.totals.averageBalance, 106.25);
  // oldest = 142 days
  assert.equal(out.totals.oldestDaysLate, 142);

  // Buckets are returned in triage order (90+ first → Current last)
  assert.deepEqual(
    out.buckets.map((b) => b.key),
    ['B90_PLUS', 'B61_90', 'B31_60', 'B1_30', 'CURRENT'],
  );

  // pctOfTotal sums to 1 within rounding tolerance
  const total = out.buckets.reduce((acc, b) => acc + b.pctOfTotal, 0);
  assert.ok(Math.abs(total - 1) < 0.0001, 'pctOfTotal should sum to 1');
});

test('computeData: excludes CANCELLED agreements', async () => {
  const prisma = makePrisma({ agreements: [
    agr({ balance: 100, returnAt: '2026-05-22T00:00:00Z', status: 'FINALIZED' }),
    agr({ balance: 200, returnAt: '2026-05-22T00:00:00Z', status: 'CANCELLED' }), // excluded
    agr({ balance: 50,  returnAt: '2026-05-22T00:00:00Z', status: 'CLOSED' }),
  ] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  assert.equal(out.totals.accountCount, 2);
  assert.equal(out.totals.totalAmount, 150);
  assert.ok(EXCLUDED_AGREEMENT_STATUSES.includes('CANCELLED'));
});

test('computeData: excludes balance <= 0', async () => {
  // The fake prisma already filters where.balance.gt to mirror the real
  // server-side behaviour, so paid-up agreements never reach the aggregation.
  const prisma = makePrisma({ agreements: [
    agr({ balance: 100, returnAt: '2026-05-22T00:00:00Z' }),
    agr({ balance: 0,   returnAt: '2026-05-22T00:00:00Z' }), // excluded
    agr({ balance: -10, returnAt: '2026-05-22T00:00:00Z' }), // refund/credit, also excluded
  ] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  assert.equal(out.totals.accountCount, 1);
  assert.equal(out.totals.totalAmount, 100);
});

test('computeData: location filter narrows by pickupLocationId', async () => {
  const prisma = makePrisma({ agreements: [
    agr({ balance: 100, returnAt: '2026-05-22T00:00:00Z', location: 'L1' }),
    agr({ balance: 200, returnAt: '2026-05-22T00:00:00Z', location: 'L2' }),
    agr({ balance: 50,  returnAt: '2026-05-22T00:00:00Z', location: 'L1' }),
  ] });
  const all = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  assert.equal(all.totals.totalAmount, 350);

  const onlyL1 = await computeData({ tenantId: 't1', query: { locationId: 'L1' } }, { prisma, now: NOW });
  assert.equal(onlyL1.totals.totalAmount, 150);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: no unpaid balances → all-clear state', async () => {
  const prisma = makePrisma({ agreements: [] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  assert.equal(out.totals.totalAmount, 0);
  assert.equal(out.totals.accountCount, 0);
  assert.equal(out.totals.oldestDaysLate, 0);
  for (const b of out.buckets) {
    assert.equal(b.count, 0);
    assert.equal(b.pctOfTotal, 0);
  }
});

// ---------------------------------------------------------------------------
// bucketDrillDownHandler
// ---------------------------------------------------------------------------

test('bucketDrillDownHandler: 400 when bucket missing or unknown', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await bucketDrillDownHandler({ query: {} }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /bucket must be one of/);

  statusCode = null; body = null;
  await bucketDrillDownHandler({ query: { bucket: 'GARBAGE' } }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
});

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

test('registerReport mounts the standard + /bucket routes for unpaid-balance', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/unpaid-balance'),        'data route');
  assert.ok(paths.has('/unpaid-balance/pdf'),    'pdf route');
  assert.ok(paths.has('/unpaid-balance/excel'),  'excel route');
  assert.ok(paths.has('/unpaid-balance/bucket'), '/bucket drill-down sub-route');
});
