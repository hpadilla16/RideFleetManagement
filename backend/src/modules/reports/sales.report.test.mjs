/**
 * Tests for sales.report.js (Round 28).
 * Run: node --test backend/src/modules/reports/sales.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _salesInternal } from './sales.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, aggregate, categoryDrillDownHandler } = _salesInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ charges = [] } = {}) {
  return {
    rentalAgreementCharge: {
      async findMany({ where, select, orderBy }) {
        let rows = charges.filter((c) => {
          if (where.selected !== undefined && c.selected !== where.selected) return false;
          if (where.rentalAgreement?.tenantId && c.rentalAgreement?.tenantId !== where.rentalAgreement.tenantId) return false;
          if (where.rentalAgreement?.pickupLocationId && c.rentalAgreement?.pickupLocationId !== where.rentalAgreement.pickupLocationId) return false;
          if (where.rentalAgreement?.pickupAt?.gte && new Date(c.rentalAgreement.pickupAt) < where.rentalAgreement.pickupAt.gte) return false;
          if (where.rentalAgreement?.pickupAt?.lt  && new Date(c.rentalAgreement.pickupAt) >= where.rentalAgreement.pickupAt.lt)  return false;
          if (where.name?.in && !where.name.in.includes(c.name)) return false;
          return true;
        });
        if (orderBy?.total === 'desc') {
          rows = [...rows].sort((a, b) => Number(b.total) - Number(a.total));
        }
        return rows;
      },
    },
  };
}

let _idSeq = 0;
function chg({ name, chargeType = 'UNIT', total, pickup = '2026-05-15T10:00:00Z', tenantId = 't1', location = null, selected = true, code = null }) {
  return {
    id: `c${++_idSeq}`,
    selected,
    name,
    code,
    chargeType,
    quantity: 1,
    rate: total,
    total,
    rentalAgreement: {
      tenantId,
      pickupAt: new Date(pickup),
      pickupLocationId: location,
      agreementNumber: `A-${_idSeq}`,
      customerFirstName: 'Test',
      customerLastName: `${_idSeq}`,
      pickupLocation: location ? { id: location, name: `Loc ${location}` } : null,
    },
  };
}

// ---------------------------------------------------------------------------
// aggregate — pure
// ---------------------------------------------------------------------------

test('aggregate: empty input → all zeros', () => {
  const out = aggregate([]);
  assert.equal(out.salesAmount, 0);
  assert.equal(out.taxAmount, 0);
  assert.equal(out.topCategories.length, 0);
  assert.equal(out.taxBreakdown.length, 0);
  assert.equal(out.peakDay.amount, 0);
});

test('aggregate: groups sales by name and computes pctOfSales', () => {
  const out = aggregate([
    chg({ name: 'Daily rental', chargeType: 'DAILY', total: 100 }),
    chg({ name: 'Daily rental', chargeType: 'DAILY', total: 200 }),
    chg({ name: 'CDW Insurance', chargeType: 'UNIT', total: 50 }),
    chg({ name: 'CDW Insurance', chargeType: 'UNIT', total: 50 }),
    chg({ name: 'GPS Unit',      chargeType: 'UNIT', total: 25 }),
  ]);
  assert.equal(out.salesAmount, 425);
  assert.equal(out.salesChargeCount, 5);
  assert.equal(out.topCategories[0].name, 'Daily rental');
  assert.equal(out.topCategories[0].amount, 300);
  assert.equal(out.topCategories[0].count, 2);
  // 300 / 425 ≈ 0.7058
  assert.ok(Math.abs(out.topCategories[0].pctOfSales - 300 / 425) < 0.0001);
  // avgPerSale rounded to .01
  assert.equal(out.topCategories[0].avgPerSale, 150);
});

test('aggregate: sorts categories by amount desc', () => {
  const out = aggregate([
    chg({ name: 'B', total: 10 }),
    chg({ name: 'A', total: 100 }),
    chg({ name: 'C', total: 50 }),
  ]);
  assert.deepEqual(out.topCategories.map((c) => c.name), ['A', 'C', 'B']);
});

test('aggregate: Top-N + Other rollup when categories exceed topN', () => {
  const charges = [];
  for (let i = 1; i <= 12; i++) {
    // Larger i has larger amount so #1..#10 are the top
    charges.push(chg({ name: `Cat ${String(i).padStart(2, '0')}`, total: i * 10 }));
  }
  const out = aggregate(charges, 5);
  // 5 top + 1 Other
  assert.equal(out.topCategories.length, 6);
  // Other is last and aggregates the 7 leftover lowest categories
  const other = out.topCategories[5];
  assert.equal(other.isOther, true);
  assert.match(other.name, /^Other \(7 categories\)$/);
  assert.equal(other.count, 7);
  // Hidden categories list carries the original names for drill-down
  assert.equal(other.hiddenCategories.length, 7);
  // Top 5 should be 12,11,10,9,8 (largest amounts)
  assert.deepEqual(
    out.topCategories.slice(0, 5).map((c) => c.name),
    ['Cat 12', 'Cat 11', 'Cat 10', 'Cat 09', 'Cat 08'],
  );
});

test('aggregate: Other label is singular when one leftover', () => {
  const charges = [];
  for (let i = 1; i <= 6; i++) charges.push(chg({ name: `Cat ${i}`, total: i }));
  const out = aggregate(charges, 5);
  assert.equal(out.topCategories[5].isOther, true);
  assert.match(out.topCategories[5].name, /^Other \(1 category\)$/);
});

test('aggregate: TAX charges separated from sales', () => {
  const out = aggregate([
    chg({ name: 'Daily rental', chargeType: 'DAILY', total: 100 }),
    chg({ name: 'Sales tax 11.5%', chargeType: 'TAX', total: 11.5 }),
    chg({ name: 'Sales tax 11.5%', chargeType: 'TAX', total: 23 }),
  ]);
  assert.equal(out.salesAmount, 100);
  assert.equal(out.taxAmount, 34.5);
  assert.equal(out.topCategories.length, 1);
  assert.equal(out.topCategories[0].name, 'Daily rental');
  assert.equal(out.taxBreakdown.length, 1);
  assert.equal(out.taxBreakdown[0].count, 2);
});

test('aggregate: peakDay picks the highest-sales pickup day (tax excluded)', () => {
  // Mid-day UTC pickup times so each date lands unambiguously on the same
  // PR-TZ day after the tz-aware bucket fix in sales.report.js.
  const out = aggregate([
    chg({ name: 'Daily rental', total: 100, pickup: '2026-05-10T14:00:00Z' }),
    chg({ name: 'Daily rental', total: 200, pickup: '2026-05-12T14:00:00Z' }),
    chg({ name: 'CDW',          total: 50,  pickup: '2026-05-12T14:00:00Z' }),
    chg({ name: 'Sales tax',    chargeType: 'TAX', total: 1000, pickup: '2026-05-15T14:00:00Z' }), // shouldn't sway peak
  ]);
  assert.equal(out.peakDay.iso, '2026-05-12');
  assert.equal(out.peakDay.amount, 250);
});

test('aggregate: float arithmetic stays clean', () => {
  const out = aggregate([
    chg({ name: 'A', total: 0.1 }),
    chg({ name: 'A', total: 0.2 }),
  ]);
  assert.equal(out.salesAmount, 0.3);
  assert.equal(out.topCategories[0].amount, 0.3);
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
  const prisma = makePrisma({ charges: [
    chg({ name: 'Daily rental',   chargeType: 'DAILY', total: 100, pickup: '2026-05-10' }),
    chg({ name: 'CDW Insurance',  chargeType: 'UNIT',  total: 60,  pickup: '2026-05-11' }),
    chg({ name: 'Sales tax 11.5%',chargeType: 'TAX',   total: 18.40, pickup: '2026-05-11' }),
  ] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-31', query: {},
  }, { prisma });

  assert.equal(out.totals.salesAmount, 160);
  assert.equal(out.totals.taxAmount, 18.40);
  assert.equal(out.totals.totalAmount, 178.40);
  assert.equal(out.totals.salesChargeCount, 2);
  assert.equal(out.totals.taxChargeCount, 1);
  assert.equal(out.topCategories.length, 2);
  assert.equal(out.taxBreakdown.length, 1);
  assert.equal(out.categoryCount, 2);
  assert.equal(out.filters.locationId, null);
});

test('computeData: respects topN query param', async () => {
  const charges = [];
  for (let i = 1; i <= 8; i++) {
    charges.push(chg({ name: `Cat ${i}`, total: i * 10, pickup: '2026-05-10' }));
  }
  const prisma = makePrisma({ charges });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-31', query: { topN: '3' },
  }, { prisma });
  // 3 top + 1 Other
  assert.equal(out.topCategories.length, 4);
  assert.equal(out.topCategories[3].isOther, true);
  assert.equal(out.topN, 3);
});

test('computeData: location filter narrows charges', async () => {
  const prisma = makePrisma({ charges: [
    chg({ name: 'Daily rental', total: 100, pickup: '2026-05-10', location: 'L1' }),
    chg({ name: 'Daily rental', total: 200, pickup: '2026-05-10', location: 'L2' }),
    chg({ name: 'CDW Insurance', total: 50,  pickup: '2026-05-10', location: 'L1' }),
  ] });
  const all = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-31', query: {},
  }, { prisma });
  assert.equal(all.totals.salesAmount, 350);

  const onlyL1 = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-31', query: { locationId: 'L1' },
  }, { prisma });
  assert.equal(onlyL1.totals.salesAmount, 150);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: empty window → zeros, peakDay is sentinel', async () => {
  const prisma = makePrisma({ charges: [] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-31', query: {},
  }, { prisma });
  assert.equal(out.totals.salesAmount, 0);
  assert.equal(out.totals.taxAmount, 0);
  assert.equal(out.topCategories.length, 0);
  assert.equal(out.peakDay.iso, null);
});

// ---------------------------------------------------------------------------
// categoryDrillDownHandler
// ---------------------------------------------------------------------------

test('categoryDrillDownHandler: 400 when names missing', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await categoryDrillDownHandler({ query: {} }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /names/);
});

test('categoryDrillDownHandler: 400 on invalid from/to', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await categoryDrillDownHandler({ query: { names: 'A', from: 'garbage' } }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /from/);
});

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

test('registerReport mounts the standard + /category routes for sales', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/sales'),          'data route');
  assert.ok(paths.has('/sales/pdf'),      'pdf route');
  assert.ok(paths.has('/sales/excel'),    'excel route');
  assert.ok(paths.has('/sales/category'), '/category drill-down sub-route');
});
