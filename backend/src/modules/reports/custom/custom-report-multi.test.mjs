/**
 * Multi-dataset Report Builder — DB-backed tests (LAX #14, 2026-07-28).
 * Requires DATABASE_URL. Pins both tenant-selectable modes:
 *   SECTIONS — per-section results, tenant isolation held per section
 *   JOINED   — reservations anchor + per-reservation aggregates from tolls/
 *              citations, zero-filled, cross-tenant rows excluded, money
 *              metrics role-gated
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runCustomReportMulti, validateMultiDefinition, CustomReportError } from './custom-report.engine.js';

const prisma = new PrismaClient();
const TAG = `CRMD-${Date.now()}`;
const ids = { tenant: null, other: null, loc: null, customer: null, resA: null, resB: null };

test.after(async () => {
  for (const t of [ids.tenant, ids.other]) {
    if (!t) continue;
    await prisma.tollTransaction.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.citation.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.location.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: t } }).catch(() => {});
  }
  await prisma.$disconnect();
});

const RANGE = { preset: 'CUSTOM', from: '2026-07-01T00:00:00Z', to: '2026-07-18T00:00:00Z' };
const SCOPE_ADMIN = () => ({ tenantId: ids.tenant, role: 'ADMIN', allowedLocationIds: null });

test('setup: reservations + tolls + citations across two tenants', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;
  const other = await prisma.tenant.create({ data: { name: `O ${TAG}`, slug: `o-${TAG}`.toLowerCase() } });
  ids.other = other.id;
  const loc = await prisma.location.create({ data: { tenantId: tenant.id, code: `L${TAG.slice(-6)}`, name: 'Sede' } });
  ids.loc = loc.id;
  const customer = await prisma.customer.create({ data: { tenantId: tenant.id, firstName: 'Multi', lastName: 'Set', phone: '5550001111' } });
  ids.customer = customer.id;

  const mkRes = (num, pickupAtIso, tenantId = tenant.id, locId = loc.id, custId = customer.id) => prisma.reservation.create({
    data: {
      tenantId, reservationNumber: num, customerId: custId,
      pickupLocationId: locId, returnLocationId: locId,
      pickupAt: new Date(pickupAtIso), returnAt: new Date('2026-07-20T10:00:00Z'),
      status: 'CONFIRMED', dailyRate: 50, estimatedTotal: 150,
    },
  });
  const resA = await mkRes(`R-${TAG}-A`, '2026-07-10T15:00:00Z');
  ids.resA = resA.id;
  const resB = await mkRes(`R-${TAG}-B`, '2026-07-11T15:00:00Z');
  ids.resB = resB.id;

  // Tolls: 2 on A ($3.50 + $1.50), none on B; one MATCHED toll on the OTHER tenant
  // wired (illegitimately) to resA — the tenant filter must exclude it.
  const mkToll = (tenantId, reservationId, amount) => prisma.tollTransaction.create({
    data: { tenantId, reservationId, transactionAt: new Date('2026-07-10T18:00:00Z'), amount, status: 'MATCHED', billingStatus: 'PENDING' },
  });
  await mkToll(tenant.id, resA.id, 3.5);
  await mkToll(tenant.id, resA.id, 1.5);
  await mkToll(other.id, resA.id, 99);

  // Citations: 1 on B ($100 + $10 fee).
  await prisma.citation.create({ data: {
    tenantId: tenant.id, reservationId: resB.id, source: 'MANUAL', citationNo: `C-${TAG}`,
    agency: 'PD', amount: 100, fee: 10, issuedAt: new Date('2026-07-11T18:00:00Z'),
  } });
  assert.ok(ids.resA && ids.resB);
});

test('SECTIONS: two sections run independently, tenant-isolated, one shared range', async () => {
  const out = await runCustomReportMulti({
    mode: 'SECTIONS',
    range: RANGE,
    sections: [
      { dataset: 'reservations', columns: ['reservationNumber', 'estimatedTotal'], dateField: 'pickupAt' },
      { dataset: 'tolls', columns: ['transactionAt', 'amount'], dateField: 'transactionAt' },
    ],
  }, SCOPE_ADMIN());

  assert.equal(out.mode, 'sections');
  assert.equal(out.sections.length, 2);
  const [resSection, tollSection] = out.sections;
  assert.equal(resSection.dataset, 'reservations');
  assert.equal(resSection.rowCount, 2, 'both reservations, no cross-tenant rows');
  assert.equal(tollSection.dataset, 'tolls');
  assert.equal(tollSection.rowCount, 2, 'the other tenant toll is excluded');
});

test('SECTIONS: section count is capped', () => {
  const section = { dataset: 'reservations', columns: ['reservationNumber'], dateField: 'pickupAt' };
  assert.throws(
    () => validateMultiDefinition({ mode: 'SECTIONS', range: RANGE, sections: Array(6).fill(section) }, 'ADMIN'),
    (e) => e instanceof CustomReportError && /limited to 5/.test(e.message),
  );
});

test('JOINED: per-reservation aggregates, zero-filled, cross-tenant excluded', async () => {
  const out = await runCustomReportMulti({
    mode: 'JOINED',
    range: RANGE,
    anchor: { columns: ['reservationNumber'], dateField: 'pickupAt' },
    joins: [
      { dataset: 'tolls', metrics: ['count', 'amount'] },
      { dataset: 'citations', metrics: ['count', 'amount'] },
    ],
  }, SCOPE_ADMIN());

  assert.equal(out.mode, 'flat');
  assert.equal(out.ids, undefined, 'internal ids never serialized');
  assert.deepEqual(out.columns.map((c) => c.key), [
    'reservationNumber', 'tolls_count', 'tolls_amount', 'citations_count', 'citations_amount',
  ]);
  const byNumber = new Map(out.rows.map((r) => [r[0], r]));
  // A: 2 tolls totaling $5 (the $99 other-tenant toll excluded), no citations.
  assert.deepEqual(byNumber.get(`R-${TAG}-A`).slice(1), [2, 5, 0, 0]);
  // B: no tolls, 1 citation of $100.
  assert.deepEqual(byNumber.get(`R-${TAG}-B`).slice(1), [0, 0, 1, 100]);
});

test('JOINED: money metrics are role-gated (AGENT keeps counts, loses sums)', async () => {
  const scope = { tenantId: ids.tenant, role: 'AGENT', allowedLocationIds: null };
  const out = await runCustomReportMulti({
    mode: 'JOINED',
    range: RANGE,
    anchor: { columns: ['reservationNumber'], dateField: 'pickupAt' },
    joins: [{ dataset: 'tolls', metrics: ['count', 'amount'] }],
  }, scope);
  assert.deepEqual(out.columns.map((c) => c.key), ['reservationNumber', 'tolls_count'], 'sum silently dropped for AGENT');
});

test('JOINED: grouping is rejected; unknown join dataset is rejected', () => {
  assert.throws(
    () => validateMultiDefinition({
      mode: 'JOINED', range: RANGE, groupBy: { field: 'status' },
      anchor: { columns: ['reservationNumber'], dateField: 'pickupAt' },
      joins: [{ dataset: 'tolls' }],
    }, 'ADMIN'),
    (e) => /flat/.test(e.message),
  );
  assert.throws(
    () => validateMultiDefinition({
      mode: 'JOINED', range: RANGE,
      anchor: { columns: ['reservationNumber'], dateField: 'pickupAt' },
      joins: [{ dataset: 'fleet' }],
    }, 'ADMIN'),
    (e) => /cannot be joined/.test(e.message),
  );
});

test('validate: unknown mode throws; a SECTIONS report with a money dataset 403s for AGENT', () => {
  assert.throws(
    () => validateMultiDefinition({ mode: 'PIVOT' }, 'ADMIN'),
    (e) => /Unknown report mode/.test(e.message),
  );
  assert.throws(
    () => validateMultiDefinition({
      mode: 'SECTIONS', range: RANGE,
      sections: [{ dataset: 'payments', columns: ['amount'], dateField: 'paidAt' }],
    }, 'AGENT'),
    (e) => e instanceof CustomReportError && e.status === 403,
  );
});
