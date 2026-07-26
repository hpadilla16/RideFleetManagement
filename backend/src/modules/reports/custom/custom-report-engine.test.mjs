/**
 * DB-backed tests for the Report Builder engine. Requires DATABASE_URL.
 *
 * PINS (the risks QA/Innovation flagged):
 *  1. Tenant + location scope are INJECTED — a definition cannot reach
 *     another tenant, and a location-scoped runner only sees their sede.
 *  2. Role stripping at RUN time: an AGENT running an admin-built definition
 *     gets money columns stripped (reported in hiddenColumns), never a leak.
 *  3. TZ bucketing: an AST late-night payment lands on the AST day, not UTC.
 *  4. Required date filter + unknown keys drift-safe + scoped-user block on
 *     datasets without a location path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runCustomReport, CustomReportError } from './custom-report.engine.js';

const prisma = new PrismaClient();
const TAG = `CRPT-${Date.now()}`;
const ids = { tenant: null, other: null, locA: null, locB: null, customer: null };

test.after(async () => {
  for (const t of [ids.tenant, ids.other]) {
    if (!t) continue;
    await prisma.reservation.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.location.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: t } }).catch(() => {});
  }
  await prisma.$disconnect();
});

async function makeReservation(tenantId, locId, customerId, num, pickupAtIso) {
  return prisma.reservation.create({
    data: {
      tenantId, reservationNumber: num, customerId,
      pickupLocationId: locId, returnLocationId: locId,
      pickupAt: new Date(pickupAtIso), returnAt: new Date('2026-07-20T10:00:00Z'),
      status: 'CONFIRMED', bookingChannel: 'WEBSITE', dailyRate: 50, estimatedTotal: 150
    }
  });
}

test('setup: two tenants, two sedes, reservations incl. an AST-late-night one', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;
  const other = await prisma.tenant.create({ data: { name: `O ${TAG}`, slug: `o-${TAG}`.toLowerCase() } });
  ids.other = other.id;
  const locA = await prisma.location.create({ data: { tenantId: tenant.id, code: `A${TAG.slice(-6)}`, name: 'Sede A' } });
  ids.locA = locA.id;
  const locB = await prisma.location.create({ data: { tenantId: tenant.id, code: `B${TAG.slice(-6)}`, name: 'Sede B' } });
  ids.locB = locB.id;
  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, firstName: 'Rep', lastName: 'Ort', phone: '5550008888' }
  });
  ids.customer = customer.id;
  const otherCustomer = await prisma.customer.create({
    data: { tenantId: other.id, firstName: 'Leak', lastName: 'Test', phone: '5550009999' }
  });
  const otherLoc = await prisma.location.create({ data: { tenantId: other.id, code: `X${TAG.slice(-6)}`, name: 'Other' } });

  await makeReservation(tenant.id, locA.id, customer.id, `R-${TAG}-A1`, '2026-07-10T15:00:00Z');
  // 2026-07-16 03:30Z == 2026-07-15 23:30 AST — must bucket on the 15th.
  await makeReservation(tenant.id, locA.id, customer.id, `R-${TAG}-A2`, '2026-07-16T03:30:00Z');
  await makeReservation(tenant.id, locB.id, customer.id, `R-${TAG}-B1`, '2026-07-10T16:00:00Z');
  await makeReservation(other.id, otherLoc.id, otherCustomer.id, `R-${TAG}-LEAK`, '2026-07-10T17:00:00Z');
  assert.ok(ids.locA && ids.locB);
});

// Deliberately includes a PATH-ONLY field (agreementStatus -> nested select
// with `select` wrapper at every hop) and a RESOLVE field with its own select
// (vehicleMakeModel) — the QA blocker was an invalid Prisma select that 500'd
// exactly these; a fixture without agreement/vehicle must yield nulls, not
// PrismaClientValidationError.
const DEF = {
  columns: ['reservationNumber', 'pickupAt', 'estimatedTotal', 'pickupLocation', 'agreementStatus', 'vehicleMakeModel'],
  dateField: 'pickupAt',
  range: { preset: 'CUSTOM', from: '2026-07-01T00:00:00Z', to: '2026-07-18T00:00:00Z' }
};

test('PIN 1: tenant isolation + location scoping are injected', async () => {
  const all = await runCustomReport('reservations', DEF, { tenantId: ids.tenant, role: 'ADMIN' });
  const nums = all.rows.map((r) => r[0]);
  assert.equal(nums.length, 3, 'exactly this tenant, never the other');
  assert.ok(!nums.some((n) => String(n).includes('LEAK')));

  const scoped = await runCustomReport('reservations', DEF, {
    tenantId: ids.tenant, role: 'ADMIN', allowedLocationIds: [ids.locA]
  });
  assert.equal(scoped.rows.length, 2, 'sede-scoped runner only sees their branch');
  assert.ok(scoped.rows.every((r) => String(r[0]).includes('-A')));
});

test('PIN 2: AGENT running an admin definition gets money stripped, not leaked', async () => {
  const out = await runCustomReport('reservations', DEF, { tenantId: ids.tenant, role: 'AGENT' });
  assert.ok(!out.columns.some((c) => c.key === 'estimatedTotal'), 'money column gone');
  assert.ok(out.hiddenColumns.includes('estimatedTotal'), 'and reported as hidden');
  assert.ok(out.columns.some((c) => c.key === 'reservationNumber'), 'operational columns remain');

  await assert.rejects(
    runCustomReport('payments', { columns: ['amount'], range: DEF.range }, { tenantId: ids.tenant, role: 'AGENT' }),
    (e) => e instanceof CustomReportError && e.status === 403,
    'money dataset is 403 for AGENT outright'
  );
});

test('PIN 3: day bucketing uses tenant TZ (AST late-night lands on the AST day)', async () => {
  const out = await runCustomReport('reservations', {
    ...DEF,
    groupBy: { field: 'pickupAt', bucket: 'day' },
    aggregates: [{ fn: 'count' }, { fn: 'sum', field: 'estimatedTotal' }]
  }, { tenantId: ids.tenant, role: 'ADMIN' });
  assert.equal(out.mode, 'grouped');
  const days = out.rows.map((r) => r[0]);
  assert.ok(days.includes('2026-07-15'), `03:30Z buckets as the 15th AST (got ${days.join(',')})`);
  assert.ok(!days.includes('2026-07-16'), 'and NOT as the UTC 16th');
  const day10 = out.rows.find((r) => r[0] === '2026-07-10');
  assert.equal(day10[1], 2, 'count aggregate');
  assert.equal(day10[2], 300, 'sum aggregate');
  assert.equal(out.totals[1], 3, 'totals row');
});

test('PIN 4: guardrails — required date, drift-safe unknowns, scoped-block, caps', async () => {
  // No range on an event dataset never table-scans: the engine bounds it to
  // THIS_MONTH by default (the builder's default too).
  const defaulted = await runCustomReport('reservations', { columns: ['reservationNumber'] }, { tenantId: ids.tenant, role: 'ADMIN' });
  assert.ok(defaulted.range?.from instanceof Date && defaulted.range?.to instanceof Date, 'auto-bounded to a real range');

  const drift = await runCustomReport('reservations', {
    ...DEF, columns: [...DEF.columns, 'fieldThatWasDeleted']
  }, { tenantId: ids.tenant, role: 'ADMIN' });
  assert.deepEqual(drift.unavailableColumns, ['fieldThatWasDeleted'], 'unknown key reported, no 500');

  await assert.rejects(
    runCustomReport('customers', { columns: ['firstName'] }, {
      tenantId: ids.tenant, role: 'ADMIN', allowedLocationIds: [ids.locA]
    }),
    (e) => e instanceof CustomReportError && e.status === 403,
    'dataset without a location path is fail-closed for scoped users'
  );

  await assert.rejects(
    runCustomReport('reservations', {
      ...DEF, range: { preset: 'CUSTOM', from: '2024-01-01T00:00:00Z', to: '2026-07-01T00:00:00Z' }
    }, { tenantId: ids.tenant, role: 'ADMIN' }),
    /limited to 366 days/i
  );
});
