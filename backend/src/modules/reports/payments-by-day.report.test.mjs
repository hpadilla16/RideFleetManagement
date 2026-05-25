/**
 * Tests for payments-by-day.report.js (Round 27).
 * Run: node --test backend/src/modules/reports/payments-by-day.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _paymentsByDayInternal } from './payments-by-day.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, dayDrillDownHandler, METHOD_TO_BUCKET, BUCKET_ORDER, EXCLUDED_METHODS } = _paymentsByDayInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ payments = [] } = {}) {
  return {
    rentalAgreementPayment: {
      async findMany({ where, select, orderBy }) {
        let rows = payments.filter((p) => {
          if (where.rentalAgreement?.tenantId && p.tenantId !== where.rentalAgreement.tenantId) return false;
          if (where.rentalAgreement?.pickupLocationId && p.pickupLocationId !== where.rentalAgreement.pickupLocationId) return false;
          if (where.status && p.status !== where.status) return false;
          if (where.method?.notIn && where.method.notIn.includes(p.method)) return false;
          if (where.paidAt?.gte && new Date(p.paidAt) < where.paidAt.gte) return false;
          if (where.paidAt?.lt && new Date(p.paidAt) >= where.paidAt.lt) return false;
          return true;
        });
        if (orderBy?.paidAt === 'asc') {
          rows = [...rows].sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt));
        }
        // The select is structural; the test consumers only care about a few fields. Just return the row.
        return rows.map((p) => {
          if (select?.rentalAgreement) {
            return { ...p, rentalAgreement: p.rentalAgreement || null };
          }
          return p;
        });
      },
    },
  };
}

function pmt({ id, method, amount, paidAt, status = 'PAID', tenantId = 't1', location = null, agreement = null }) {
  return {
    id, tenantId, method, amount, status,
    paidAt: new Date(paidAt),
    pickupLocationId: location,
    rentalAgreement: agreement || {
      id: `ag-${id}`,
      agreementNumber: `A-${id}`,
      customerFirstName: 'Cust',
      customerLastName: id,
      pickupLocation: location ? { id: location, name: `Loc ${location}` } : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Bucket map
// ---------------------------------------------------------------------------

test('METHOD_TO_BUCKET maps every non-excluded enum value', () => {
  const all = ['CASH', 'CARD', 'ZELLE', 'ATH_MOVIL', 'BANK_TRANSFER', 'OTHER'];
  for (const m of all) {
    assert.ok(METHOD_TO_BUCKET[m], `${m} should map to a bucket`);
  }
  // AUTH_HOLD intentionally NOT in the bucket map (excluded from the report)
  assert.equal(METHOD_TO_BUCKET.AUTH_HOLD, undefined);
  assert.ok(EXCLUDED_METHODS.has('AUTH_HOLD'));
});

test('METHOD_TO_BUCKET groups digital methods together', () => {
  assert.equal(METHOD_TO_BUCKET.CASH,          'CASH');
  assert.equal(METHOD_TO_BUCKET.CARD,          'CARD');
  assert.equal(METHOD_TO_BUCKET.ZELLE,         'DIGITAL');
  assert.equal(METHOD_TO_BUCKET.ATH_MOVIL,     'DIGITAL');
  assert.equal(METHOD_TO_BUCKET.BANK_TRANSFER, 'DIGITAL');
  assert.equal(METHOD_TO_BUCKET.OTHER,         'OTHER');
});

test('BUCKET_ORDER is deterministic (Cash, Card, Digital, Other)', () => {
  assert.deepEqual(BUCKET_ORDER, ['CASH', 'CARD', 'DIGITAL', 'OTHER']);
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

test('computeData returns hybrid shape with totals and per-bucket sums', async () => {
  const prisma = makePrisma({ payments: [
    pmt({ id: '1', method: 'CASH',          amount: 100,  paidAt: '2026-05-01T10:00:00Z' }),
    pmt({ id: '2', method: 'CARD',          amount: 250.5, paidAt: '2026-05-01T11:00:00Z' }),
    pmt({ id: '3', method: 'ZELLE',         amount: 60,   paidAt: '2026-05-02T09:00:00Z' }),
    pmt({ id: '4', method: 'ATH_MOVIL',     amount: 40,   paidAt: '2026-05-02T10:00:00Z' }),
    pmt({ id: '5', method: 'BANK_TRANSFER', amount: 80,   paidAt: '2026-05-03T08:00:00Z' }),
    pmt({ id: '6', method: 'OTHER',         amount: 10,   paidAt: '2026-05-03T09:00:00Z' }),
  ] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-03', query: {},
  }, { prisma });

  assert.equal(out.days.length, 3);
  assert.equal(out.totals.count, 6);
  assert.equal(out.totals.amount, 540.5);

  // Method totals (Digital = 60 + 40 + 80 = 180)
  assert.equal(out.methodTotals.CASH,    100);
  assert.equal(out.methodTotals.CARD,    250.5);
  assert.equal(out.methodTotals.DIGITAL, 180);
  assert.equal(out.methodTotals.OTHER,   10);

  // Top method = CARD ($250.50 of $540.50 = 46.3%)
  assert.equal(out.topMethod.key, 'CARD');
  assert.equal(out.topMethod.amount, 250.5);
  assert.ok(Math.abs(out.topMethod.pct - 250.5 / 540.5) < 0.001);

  // Best day = day 1 ($350.50 total)
  assert.equal(out.peak.iso, '2026-05-01');
  assert.equal(out.peak.total, 350.5);

  // Daily average = 540.50 / 3
  assert.ok(Math.abs(out.dailyAverage - 180.17) < 0.01);

  assert.deepEqual(out.bucketOrder, ['CASH', 'CARD', 'DIGITAL', 'OTHER']);
});

test('computeData excludes AUTH_HOLD and non-PAID payments', async () => {
  const prisma = makePrisma({ payments: [
    pmt({ id: '1', method: 'CASH',      amount: 100, paidAt: '2026-05-01T10:00:00Z', status: 'PAID' }),
    pmt({ id: '2', method: 'AUTH_HOLD', amount: 500, paidAt: '2026-05-01T11:00:00Z', status: 'PAID' }), // excluded by method
    pmt({ id: '3', method: 'CARD',      amount: 200, paidAt: '2026-05-01T12:00:00Z', status: 'REFUNDED' }), // excluded by status
    pmt({ id: '4', method: 'CARD',      amount: 50,  paidAt: '2026-05-01T13:00:00Z', status: 'VOID' }),     // excluded by status
  ] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-01', query: {},
  }, { prisma });
  assert.equal(out.totals.count, 1);
  assert.equal(out.totals.amount, 100);
});

test('computeData: location filter narrows payments by pickupLocation', async () => {
  const prisma = makePrisma({ payments: [
    pmt({ id: 'L1a', method: 'CASH', amount: 100, paidAt: '2026-05-01T10:00:00Z', location: 'L1' }),
    pmt({ id: 'L1b', method: 'CARD', amount: 150, paidAt: '2026-05-01T11:00:00Z', location: 'L1' }),
    pmt({ id: 'L2a', method: 'CASH', amount: 200, paidAt: '2026-05-01T12:00:00Z', location: 'L2' }),
  ] });

  const all = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-01', query: {},
  }, { prisma });
  assert.equal(all.totals.amount, 450);

  const onlyL1 = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-01', query: { locationId: 'L1' },
  }, { prisma });
  assert.equal(onlyL1.totals.amount, 250);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: float arithmetic stays clean (.10 + .20 doesn\'t leak)', async () => {
  const prisma = makePrisma({ payments: [
    pmt({ id: '1', method: 'CASH', amount: 0.10, paidAt: '2026-05-01T10:00:00Z' }),
    pmt({ id: '2', method: 'CASH', amount: 0.20, paidAt: '2026-05-01T11:00:00Z' }),
  ] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-01', query: {},
  }, { prisma });
  assert.equal(out.totals.amount, 0.30);
  assert.equal(out.methodTotals.CASH, 0.30);
});

test('computeData: empty window returns zeros across the board', async () => {
  const prisma = makePrisma({ payments: [] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-03', query: {},
  }, { prisma });
  assert.equal(out.days.length, 3);
  assert.equal(out.totals.amount, 0);
  assert.equal(out.totals.count, 0);
  assert.equal(out.dailyAverage, 0);
  // topMethod still returns a deterministic key (first in BUCKET_ORDER) with amount 0
  assert.equal(out.topMethod.key, 'CASH');
  assert.equal(out.topMethod.amount, 0);
  assert.equal(out.topMethod.pct, 0);
});

test('computeData: truncated=true when window exceeds 92 days', async () => {
  const prisma = makePrisma({ payments: [] });
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
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await dayDrillDownHandler({ query: {} }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /day query param/);
});

test('dayDrillDownHandler: 400 when day is not ISO', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await dayDrillDownHandler({ query: { day: 'not-a-date' } }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /ISO date/);
});

// ---------------------------------------------------------------------------
// registerReport wired the routes
// ---------------------------------------------------------------------------

test('registerReport mounts the standard + /day routes for payments-by-day', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/payments-by-day'),       'data route');
  assert.ok(paths.has('/payments-by-day/pdf'),   'pdf route');
  assert.ok(paths.has('/payments-by-day/excel'), 'excel route');
  assert.ok(paths.has('/payments-by-day/day'),   '/day drill-down sub-route');
});
