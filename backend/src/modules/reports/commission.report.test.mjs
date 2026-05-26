/**
 * Tests for commission.report.js (Round 31).
 * Run: node --test backend/src/modules/reports/commission.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _commissionInternal } from './commission.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, aggregate, employeeDrillDownHandler, statusFilterToWhere, STATUSES, NON_VOID_STATUSES } = _commissionInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ commissions = [] } = {}) {
  return {
    agreementCommission: {
      async findMany({ where, orderBy, take }) {
        let rows = commissions.filter((c) => {
          if (where.tenantId && c.tenantId !== where.tenantId) return false;
          if (where.employeeUserId && c.employeeUserId !== where.employeeUserId) return false;
          if (where.calculatedAt?.gte && new Date(c.calculatedAt) < where.calculatedAt.gte) return false;
          if (where.calculatedAt?.lt && new Date(c.calculatedAt) >= where.calculatedAt.lt) return false;
          if (where.status?.equals && c.status !== where.status.equals) return false;
          if (where.status?.in && !where.status.in.includes(c.status)) return false;
          if (where.rentalAgreement?.pickupLocationId && c.rentalAgreement?.pickupLocationId !== where.rentalAgreement.pickupLocationId) return false;
          return true;
        });
        if (orderBy?.calculatedAt === 'desc') {
          rows = [...rows].sort((a, b) => new Date(b.calculatedAt) - new Date(a.calculatedAt));
        }
        if (take && rows.length > take) rows = rows.slice(0, take);
        return rows;
      },
    },
  };
}

let _idSeq = 0;
function com({ id, employee, status = 'PENDING', amount, when, rentalId, tenantId = 't1', empName = null, location = null }) {
  const useId = id || `c${++_idSeq}`;
  return {
    id: useId,
    tenantId,
    employeeUserId: employee,
    rentalAgreementId: rentalId || `ra-${useId}`,
    status,
    commissionAmount: amount,
    grossRevenue: amount * 10,
    serviceRevenue: amount * 3,
    eligibleRevenue: amount * 5,
    calculatedAt: new Date(when),
    paidAt: status === 'PAID' ? new Date(when) : null,
    approvedAt: status === 'APPROVED' || status === 'PAID' ? new Date(when) : null,
    monthKey: when.slice(0, 7),
    employeeUser: { fullName: empName || `Emp ${employee}`, email: `${employee}@example.com` },
    rentalAgreement: location ? { pickupLocationId: location } : null,
  };
}

const NOW = new Date('2026-05-23T12:00:00Z');

// ---------------------------------------------------------------------------
// statusFilterToWhere
// ---------------------------------------------------------------------------

test('statusFilterToWhere: default and ALL exclude VOID', () => {
  assert.deepEqual(statusFilterToWhere(), { in: NON_VOID_STATUSES });
  assert.deepEqual(statusFilterToWhere('ALL'), { in: NON_VOID_STATUSES });
  assert.ok(!NON_VOID_STATUSES.includes('VOID'));
});

test('statusFilterToWhere: specific status uses equals', () => {
  assert.deepEqual(statusFilterToWhere('PAID'), { equals: 'PAID' });
  assert.deepEqual(statusFilterToWhere('PENDING'), { equals: 'PENDING' });
});

test('statusFilterToWhere: unknown status falls back to default', () => {
  assert.deepEqual(statusFilterToWhere('GARBAGE'), { in: NON_VOID_STATUSES });
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

test('aggregate: empty input returns zeros', () => {
  const out = aggregate([]);
  assert.equal(out.totals.amount, 0);
  assert.equal(out.totals.count, 0);
  assert.equal(out.totals.employeeCount, 0);
  assert.equal(out.totals.rentalCount, 0);
  assert.deepEqual(out.byEmployee, []);
  assert.deepEqual(out.byDay, []);
});

test('aggregate: groups by employee and splits by status', () => {
  const out = aggregate([
    com({ employee: 'E1', amount: 100, when: '2026-05-10', status: 'PAID',     rentalId: 'r1' }),
    com({ employee: 'E1', amount:  50, when: '2026-05-11', status: 'APPROVED', rentalId: 'r2' }),
    com({ employee: 'E1', amount:  25, when: '2026-05-12', status: 'PENDING',  rentalId: 'r3' }),
    com({ employee: 'E2', amount:  80, when: '2026-05-10', status: 'PAID',     rentalId: 'r4' }),
  ]);
  assert.equal(out.totals.amount, 255);
  assert.equal(out.totals.paidAmount, 180);
  assert.equal(out.totals.approvedAmount, 50);
  assert.equal(out.totals.pendingAmount, 25);
  assert.equal(out.totals.employeeCount, 2);
  assert.equal(out.totals.rentalCount, 4);

  const e1 = out.byEmployee.find((e) => e.employeeUserId === 'E1');
  assert.equal(e1.amount, 175);
  assert.equal(e1.paidAmount, 100);
  assert.equal(e1.approvedAmount, 50);
  assert.equal(e1.pendingAmount, 25);
  assert.equal(e1.rentalCount, 3);
});

test('aggregate: sorted by employee total amount desc', () => {
  const out = aggregate([
    com({ employee: 'small', amount: 10, when: '2026-05-10', status: 'PAID' }),
    com({ employee: 'big',   amount: 100, when: '2026-05-10', status: 'PAID' }),
    com({ employee: 'mid',   amount: 50, when: '2026-05-10', status: 'PAID' }),
  ]);
  assert.deepEqual(out.byEmployee.map((e) => e.employeeUserId), ['big', 'mid', 'small']);
});

test('aggregate: rentalCount uses DISTINCT rentalAgreementIds', () => {
  // Same rental, 2 employees with commission on it → rentalCount = 1 fleet-wide,
  // each employee has rentalCount = 1
  const out = aggregate([
    com({ employee: 'E1', amount: 50, when: '2026-05-10', status: 'PAID', rentalId: 'r1' }),
    com({ employee: 'E2', amount: 30, when: '2026-05-10', status: 'PAID', rentalId: 'r1' }),
  ]);
  assert.equal(out.totals.rentalCount, 1);
  assert.equal(out.byEmployee[0].rentalCount, 1);
  assert.equal(out.byEmployee[1].rentalCount, 1);
});

test('aggregate: float arithmetic stays clean', () => {
  const out = aggregate([
    com({ employee: 'E', amount: 0.10, when: '2026-05-10', status: 'PAID' }),
    com({ employee: 'E', amount: 0.20, when: '2026-05-11', status: 'PAID' }),
  ]);
  assert.equal(out.byEmployee[0].amount, 0.30);
  assert.equal(out.totals.amount, 0.30);
});

test('aggregate: byDay aggregates by calculatedAt day', () => {
  const out = aggregate([
    com({ employee: 'E', amount: 10, when: '2026-05-10T08:00:00Z', status: 'PAID' }),
    com({ employee: 'E', amount: 20, when: '2026-05-10T14:00:00Z', status: 'PAID' }),
    com({ employee: 'E', amount: 30, when: '2026-05-11T08:00:00Z', status: 'PAID' }),
  ]);
  assert.equal(out.byDay.length, 2);
  assert.equal(out.byDay[0].iso, '2026-05-10');
  assert.equal(out.byDay[0].amount, 30);
  assert.equal(out.byDay[1].amount, 30);
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

test('computeData: full hybrid shape with day skeleton + peak detection', async () => {
  // Mid-day UTC `when` so each commission lands unambiguously on the
  // intended PR-TZ day after the tz-aware bucket fix.
  const prisma = makePrisma({ commissions: [
    com({ employee: 'E1', amount: 100, when: '2026-05-10T14:00:00Z', status: 'PAID' }),
    com({ employee: 'E1', amount:  50, when: '2026-05-12T14:00:00Z', status: 'APPROVED' }),
    com({ employee: 'E2', amount:  25, when: '2026-05-12T14:00:00Z', status: 'PENDING' }),
  ] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-10', to: '2026-05-13', query: {},
  }, { prisma, now: NOW });

  assert.equal(out.totals.amount, 175);
  assert.equal(out.totals.paidAmount, 100);
  assert.equal(out.totals.approvedAmount, 50);
  assert.equal(out.totals.pendingAmount, 25);
  assert.equal(out.byDay.length, 4);   // skeleton has all 4 days
  // May 11 was empty → 0
  assert.equal(out.byDay.find((d) => d.iso === '2026-05-11').amount, 0);
  // Peak is May 10 (100) — exceeds May 12's combined 75
  assert.equal(out.peakDay.iso, '2026-05-10');
  assert.equal(out.peakDay.amount, 100);
});

test('computeData: VOID rows are excluded by default', async () => {
  const prisma = makePrisma({ commissions: [
    com({ employee: 'E1', amount: 100, when: '2026-05-10', status: 'PAID' }),
    com({ employee: 'E2', amount: 999, when: '2026-05-10', status: 'VOID' }),
  ] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma, now: NOW });
  assert.equal(out.totals.amount, 100);
  assert.equal(out.totals.count, 1);
});

test('computeData: status filter narrows to one status', async () => {
  const prisma = makePrisma({ commissions: [
    com({ employee: 'E1', amount: 100, when: '2026-05-10', status: 'PAID' }),
    com({ employee: 'E1', amount:  50, when: '2026-05-10', status: 'APPROVED' }),
    com({ employee: 'E1', amount:  25, when: '2026-05-10', status: 'PENDING' }),
  ] });
  const paidOnly = await computeData({
    tenantId: 't1', query: { status: 'PAID' },
  }, { prisma, now: NOW });
  assert.equal(paidOnly.totals.amount, 100);
  assert.equal(paidOnly.filters.status, 'PAID');
});

test('computeData: location filter narrows by rentalAgreement.pickupLocationId', async () => {
  const prisma = makePrisma({ commissions: [
    com({ employee: 'E1', amount: 100, when: '2026-05-10', status: 'PAID', location: 'L1' }),
    com({ employee: 'E1', amount:  50, when: '2026-05-10', status: 'PAID', location: 'L2' }),
  ] });
  const onlyL1 = await computeData({
    tenantId: 't1', query: { locationId: 'L1' },
  }, { prisma, now: NOW });
  assert.equal(onlyL1.totals.amount, 100);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: empty result returns 0 totals, null peakDay, no employees', async () => {
  const prisma = makePrisma({ commissions: [] });
  const out = await computeData({
    tenantId: 't1', from: '2026-05-01', to: '2026-05-03', query: {},
  }, { prisma, now: NOW });
  assert.equal(out.totals.amount, 0);
  assert.equal(out.byEmployee.length, 0);
  assert.equal(out.peakDay, null);
  // Skeleton still has the days
  assert.equal(out.byDay.length, 3);
});

// ---------------------------------------------------------------------------
// employeeDrillDownHandler
// ---------------------------------------------------------------------------

test('employeeDrillDownHandler: 400 when employeeUserId missing', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await employeeDrillDownHandler({ query: {} }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /employeeUserId/);
});

test('employeeDrillDownHandler: 400 on invalid from date', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await employeeDrillDownHandler({ query: { employeeUserId: 'E1', from: 'garbage' } }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('STATUSES matches the CommissionStatus enum (4 values)', () => {
  assert.deepEqual(STATUSES.sort(), ['APPROVED', 'PAID', 'PENDING', 'VOID']);
});

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

test('registerReport mounts standard + /employee routes for commission', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/commission'),          'data route');
  assert.ok(paths.has('/commission/pdf'),      'pdf route');
  assert.ok(paths.has('/commission/excel'),    'excel route');
  assert.ok(paths.has('/commission/employee'), '/employee drill-down sub-route');
});
