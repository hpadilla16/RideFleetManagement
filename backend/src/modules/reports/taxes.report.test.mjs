/**
 * Tests for taxes.report.js (Round 31).
 * Run: node --test backend/src/modules/reports/taxes.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _taxesInternal } from './taxes.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, aggregate, categoryDrillDownHandler } = _taxesInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ charges = [] } = {}) {
  return {
    rentalAgreementCharge: {
      async findMany({ where, orderBy }) {
        let rows = charges.filter((c) => {
          if (where.selected !== undefined && c.selected !== where.selected) return false;
          if (typeof where.chargeType === 'string' && c.chargeType !== where.chargeType) return false;
          if (where.name?.in && !where.name.in.includes(c.name)) return false;
          const ra = where.rentalAgreement || {};
          if (ra.tenantId && c.rentalAgreement?.tenantId !== ra.tenantId) return false;
          if (ra.pickupLocationId && c.rentalAgreement?.pickupLocationId !== ra.pickupLocationId) return false;
          if (ra.pickupAt?.gte && new Date(c.rentalAgreement?.pickupAt) < ra.pickupAt.gte) return false;
          if (ra.pickupAt?.lt && new Date(c.rentalAgreement?.pickupAt) >= ra.pickupAt.lt) return false;
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
function chg({ id, name, chargeType = 'UNIT', taxable = false, total, pickup = '2026-05-15T10:00:00Z', tenantId = 't1', location = null, selected = true, code = null, agreementId = null }) {
  const useId = id || `c${++_idSeq}`;
  const aId = agreementId || `ra-${useId}`;
  return {
    id: useId,
    selected,
    name,
    code,
    chargeType,
    taxable,
    total,
    rentalAgreement: {
      id: aId,
      tenantId,
      pickupAt: new Date(pickup),
      pickupLocationId: location,
      agreementNumber: `A-${aId}`,
      customerFirstName: 'Test',
      customerLastName: aId,
      pickupLocation: location ? { id: location, name: `Loc ${location}` } : null,
    },
  };
}

const NOW = new Date('2026-05-23T12:00:00Z');

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

test('aggregate: empty input returns all zeros', () => {
  const out = aggregate([]);
  assert.equal(out.totals.taxCollected, 0);
  assert.equal(out.totals.taxableBase, 0);
  assert.equal(out.totals.effectiveRate, 0);
  assert.equal(out.byCategory.length, 0);
});

test('aggregate: sums TAX charges separately from taxable base', () => {
  const out = aggregate([
    chg({ name: 'Daily rental',     chargeType: 'DAILY', taxable: true,  total: 100, agreementId: 'a1' }),
    chg({ name: 'CDW Insurance',    chargeType: 'UNIT',  taxable: true,  total: 50,  agreementId: 'a1' }),
    chg({ name: 'Sales tax 11.5%',  chargeType: 'TAX',                  total: 17.25, agreementId: 'a1' }),
  ]);
  assert.equal(out.totals.taxCollected, 17.25);
  assert.equal(out.totals.taxableBase, 150);
  // 17.25 / 150 = 0.115
  assert.ok(Math.abs(out.totals.effectiveRate - 0.115) < 0.0001);
  assert.equal(out.totals.taxedAgreementCount, 1);
  assert.equal(out.totals.totalAgreementCount, 1);
});

test('aggregate: groups TAX by name and sorts by amount desc', () => {
  const out = aggregate([
    chg({ name: 'State tax',    chargeType: 'TAX', total: 50, agreementId: 'a1' }),
    chg({ name: 'City tax',     chargeType: 'TAX', total: 10, agreementId: 'a1' }),
    chg({ name: 'State tax',    chargeType: 'TAX', total: 100, agreementId: 'a2' }),
  ]);
  assert.equal(out.byCategory.length, 2);
  assert.equal(out.byCategory[0].name, 'State tax');
  assert.equal(out.byCategory[0].amount, 150);
  assert.equal(out.byCategory[0].count, 2);
  assert.equal(out.byCategory[1].name, 'City tax');
});

test('aggregate: pctOfTotal sums to ~1 across categories', () => {
  const out = aggregate([
    chg({ name: 'A', chargeType: 'TAX', total: 30, agreementId: 'a' }),
    chg({ name: 'B', chargeType: 'TAX', total: 70, agreementId: 'a' }),
  ]);
  const sum = out.byCategory.reduce((acc, c) => acc + c.pctOfTotal, 0);
  assert.ok(Math.abs(sum - 1) < 0.0001);
});

test('aggregate: non-taxable charges go to nonTaxableRevenue, not base', () => {
  const out = aggregate([
    chg({ name: 'Daily rental', chargeType: 'DAILY', taxable: true,  total: 100, agreementId: 'a' }),
    chg({ name: 'Cleaning fee', chargeType: 'UNIT',  taxable: false, total: 30,  agreementId: 'a' }),
  ]);
  assert.equal(out.totals.taxableBase, 100);
  assert.equal(out.totals.nonTaxableRevenue, 30);
  assert.equal(out.totals.taxCollected, 0);
  assert.equal(out.totals.grossRevenue, 130);
});

test('aggregate: DEPOSIT charges are excluded from base and revenue (just tracked)', () => {
  const out = aggregate([
    chg({ name: 'Daily rental', chargeType: 'DAILY',   taxable: true, total: 100, agreementId: 'a' }),
    chg({ name: 'Deposit',      chargeType: 'DEPOSIT',                 total: 200, agreementId: 'a' }),
    chg({ name: 'Tax',          chargeType: 'TAX',                     total: 11.5, agreementId: 'a' }),
  ]);
  assert.equal(out.totals.taxableBase, 100);
  assert.equal(out.totals.nonTaxableRevenue, 0);
  assert.equal(out.totals.depositTotal, 200);
  assert.equal(out.totals.grossRevenue, 111.5); // tax + base + nonTaxable, deposit NOT included
});

test('aggregate: float arithmetic stays clean', () => {
  const out = aggregate([
    chg({ name: 'T', chargeType: 'TAX', total: 0.10, agreementId: 'a' }),
    chg({ name: 'T', chargeType: 'TAX', total: 0.20, agreementId: 'a' }),
  ]);
  assert.equal(out.totals.taxCollected, 0.30);
  assert.equal(out.byCategory[0].amount, 0.30);
});

test('aggregate: dayMap aggregates by pickup day', () => {
  const out = aggregate([
    chg({ name: 'T', chargeType: 'TAX', total: 10, pickup: '2026-05-10T08:00:00Z', agreementId: 'a' }),
    chg({ name: 'T', chargeType: 'TAX', total: 5,  pickup: '2026-05-10T14:00:00Z', agreementId: 'b' }),
    chg({ name: 'T', chargeType: 'TAX', total: 7,  pickup: '2026-05-11T08:00:00Z', agreementId: 'c' }),
  ]);
  assert.equal(out.dayMap.get('2026-05-10').taxCollected, 15);
  assert.equal(out.dayMap.get('2026-05-11').taxCollected, 7);
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

test('computeData: full hybrid shape + day skeleton + peak detection', async () => {
  // Mid-day UTC pickup times so each lands unambiguously on the expected PR-TZ
  // day after the tz-aware bucket fix.
  const prisma = makePrisma({ charges: [
    chg({ name: 'Daily rental', chargeType: 'DAILY', taxable: true, total: 100, pickup: '2026-05-10T14:00:00Z', agreementId: 'a1' }),
    chg({ name: 'Sales tax',    chargeType: 'TAX',                  total: 11.5, pickup: '2026-05-10T14:00:00Z', agreementId: 'a1' }),
    chg({ name: 'Sales tax',    chargeType: 'TAX',                  total: 5,    pickup: '2026-05-12T14:00:00Z', agreementId: 'a2' }),
  ] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-10', to: '2026-05-13', query: {},
  }, { prisma, now: NOW });

  assert.equal(out.totals.taxCollected, 16.5);
  assert.equal(out.totals.taxableBase, 100);
  assert.ok(Math.abs(out.totals.effectiveRate - 0.165) < 0.0001);
  assert.equal(out.byDay.length, 4);
  // Empty day (May 11) is 0
  assert.equal(out.byDay.find((d) => d.iso === '2026-05-11').taxCollected, 0);
  // Peak day = May 10 (11.5)
  assert.equal(out.peakDay.iso, '2026-05-10');
  assert.equal(out.peakDay.taxCollected, 11.5);
});

test('computeData: location filter narrows', async () => {
  // Pin pickup to mid-day UTC so it stays on May 15 in PR-TZ.
  const prisma = makePrisma({ charges: [
    chg({ name: 'Tax', chargeType: 'TAX', total: 10, location: 'L1', agreementId: 'a1', pickup: '2026-05-15T14:00:00Z' }),
    chg({ name: 'Tax', chargeType: 'TAX', total: 20, location: 'L2', agreementId: 'a2', pickup: '2026-05-15T14:00:00Z' }),
  ] });
  const all = await computeData({
    tenantId: 't1', from: '2026-05-15', to: '2026-05-15', query: {},
  }, { prisma, now: NOW });
  assert.equal(all.totals.taxCollected, 30);

  const onlyL1 = await computeData({
    tenantId: 't1', from: '2026-05-15', to: '2026-05-15', query: { locationId: 'L1' },
  }, { prisma, now: NOW });
  assert.equal(onlyL1.totals.taxCollected, 10);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: empty window returns zeros, null peakDay', async () => {
  const prisma = makePrisma({ charges: [] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-03', query: {},
  }, { prisma, now: NOW });
  assert.equal(out.totals.taxCollected, 0);
  assert.equal(out.byCategory.length, 0);
  assert.equal(out.peakDay, null);
  // Day skeleton still present
  assert.equal(out.byDay.length, 3);
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

test('categoryDrillDownHandler: 400 on invalid from date', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await categoryDrillDownHandler({ query: { names: 'A', from: 'garbage' } }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
});

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

test('registerReport mounts standard + /category routes for taxes', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/taxes'),          'data route');
  assert.ok(paths.has('/taxes/pdf'),      'pdf route');
  assert.ok(paths.has('/taxes/excel'),    'excel route');
  assert.ok(paths.has('/taxes/category'), '/category drill-down sub-route');
});
