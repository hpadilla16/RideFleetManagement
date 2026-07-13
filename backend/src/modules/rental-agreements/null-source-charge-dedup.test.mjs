/**
 * DB-backed regression test for the null-source duplicate-charges bug
 * (2026-07-13, RES-213665). Requires DATABASE_URL.
 *
 * THE BUG: legacy agreement mirror rows written with source:null (pre-source
 * era) survived the re-sync deleteMany in BOTH writers — Prisma/Postgres
 * negated string filters (NOT startsWith / NOT equals) never match NULL — so
 * every re-sync (Print/Email Agreement → startFromReservation, or any pricing
 * recompute → syncAgreementCharges) ADDED a fresh mirror set next to the
 * surviving null-source set: two Daily rows, two TAX rows, doubled totals.
 * 23 agreements found in prod (22 repaired + 1 held for review). Branch 3
 * already had the NULL-safe predicate; this locks all writers to it.
 *
 * QA B1 guard (also covered here): syncAgreementCharges purges null-source
 * rows ONLY when it has a fresh mirror set to write. Branch-3 agreements
 * (reservation has NO ReservationCharge rows; startFromReservation
 * synthesizes Daily/Tax with source:null) must survive a pricing read —
 * otherwise a plain GET /pricing zeroed the agreement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { rentalAgreementsService } from './rental-agreements.service.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';

const prisma = new PrismaClient();
const TAG = `NSD-${Date.now()}`;

const ids = { tenant: null, location: null, vehicleType: null, vehicle: null, customer: null, reservation: null, agreement: null };

test.after(async () => {
  if (ids.reservation) await prisma.auditLog.deleteMany({ where: { reservationId: ids.reservation } }).catch(() => {});
  if (ids.agreement) await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: ids.agreement } }).catch(() => {});
  if (ids.agreement) await prisma.rentalAgreementPayment.deleteMany({ where: { rentalAgreementId: ids.agreement } }).catch(() => {});
  if (ids.agreement) await prisma.rentalAgreement.delete({ where: { id: ids.agreement } }).catch(() => {});
  if (ids.reservation) await prisma.reservationCharge.deleteMany({ where: { reservationId: ids.reservation } }).catch(() => {});
  if (ids.reservation) await prisma.reservation.delete({ where: { id: ids.reservation } }).catch(() => {});
  if (ids.vehicle) await prisma.vehicle.delete({ where: { id: ids.vehicle } }).catch(() => {});
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where: { id: ids.vehicleType } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

async function seed() {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } }); ids.tenant = t.id;
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: t.id } }); ids.location = loc.id;
  const vt = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `VT-${TAG}`.slice(0, 10), name: 'SUV' } }); ids.vehicleType = vt.id;
  const veh = await prisma.vehicle.create({ data: { tenant: { connect: { id: t.id } }, internalNumber: `V-${TAG}`.slice(0, 18), plate: `P${TAG}`.slice(0, 10), status: 'ON_RENT', vehicleType: { connect: { id: vt.id } } } }); ids.vehicle = veh.id;
  const cust = await prisma.customer.create({ data: { firstName: 'Nula', lastName: 'Source', phone: '7875550199', email: `c-${TAG}@x.com`, tenantId: t.id } }); ids.customer = cust.id;
  const pickupAt = new Date(Date.now() - 2 * 86400e3); const returnAt = new Date(Date.now());
  const r = await prisma.reservation.create({ data: {
    reservationNumber: `R-${TAG}`, tenantId: t.id, customerId: cust.id, vehicleId: veh.id,
    pickupLocationId: loc.id, returnLocationId: loc.id, pickupAt, returnAt,
    status: 'CHECKED_OUT', dailyRate: 0
  } }); ids.reservation = r.id;
  // Current reservation pricing (franchise-style: daily $0 + tolls + tax) —
  // typed sources, the modern shape.
  await prisma.reservationCharge.createMany({ data: [
    { reservationId: r.id, name: 'Daily', chargeType: 'DAILY', quantity: 2, rate: 0, total: 0, taxable: true, selected: true, sortOrder: 0, source: 'DAILY' },
    { reservationId: r.id, name: 'Service: Pre-Paid Tolls (N)', chargeType: 'UNIT', quantity: 2, rate: 12.99, total: 25.98, taxable: true, selected: true, sortOrder: 1, source: 'SERVICE' },
    { reservationId: r.id, name: 'Sales Tax (11.50%)', chargeType: 'TAX', quantity: 1, rate: 2.99, total: 2.99, taxable: false, selected: true, sortOrder: 2, source: 'TAX' }
  ] });
  const ag = await prisma.rentalAgreement.create({ data: {
    agreementNumber: `RA-${TAG}`, reservationId: r.id, tenantId: t.id, vehicleId: veh.id,
    pickupAt, returnAt, pickupLocationId: loc.id, returnLocationId: loc.id,
    customerFirstName: 'Nula', customerLastName: 'Source', status: 'FINALIZED',
    subtotal: 120.73, taxes: 12.45, total: 149.7, paidAmount: 28.97, balance: 120.73
  } }); ids.agreement = ag.id;
  // LEGACY mirror rows with source:null — the exact shape that survived the
  // old delete predicate and duplicated (RES-213665's batch 1).
  await prisma.rentalAgreementCharge.createMany({ data: [
    { rentalAgreementId: ag.id, name: 'Daily', chargeType: 'DAILY', quantity: 2, rate: 54.14, total: 108.28, taxable: true, selected: true, sortOrder: 0, source: null },
    { rentalAgreementId: ag.id, name: 'Tax (11.50%)', chargeType: 'TAX', quantity: 1, rate: 12.45, total: 12.45, taxable: false, selected: true, sortOrder: 1, source: null }
  ] });
  // An agreement-only fee that MUST survive the resync (the carve-out).
  await prisma.rentalAgreementCharge.create({ data: {
    rentalAgreementId: ag.id, name: 'Fuel refill', chargeType: 'UNIT', quantity: 1, rate: 30, total: 30,
    taxable: false, selected: true, sortOrder: 9, source: 'FEE_ENGINE_FUEL'
  } });
  return { tenantId: t.id };
}

let scope = null;
test('setup', async () => { scope = await seed(); assert.ok(scope.tenantId); });

test('startFromReservation re-sync deletes legacy null-source mirror rows (no duplicates), keeps fee-engine rows', async () => {
  await rentalAgreementsService.startFromReservation(ids.reservation, { tenantId: scope.tenantId });
  const rows = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement } });
  const daily = rows.filter((c) => c.chargeType === 'DAILY' && c.selected);
  const tax = rows.filter((c) => c.chargeType === 'TAX' && c.selected);
  assert.equal(daily.length, 1, `exactly one Daily row (got ${daily.length})`);
  assert.equal(tax.length, 1, `exactly one TAX row (got ${tax.length})`);
  assert.equal(Number(daily[0].total), 0, 'Daily mirrors the CURRENT reservation pricing ($0 franchise)');
  assert.equal(rows.filter((c) => c.source === null).length, 0, 'no null-source rows survive');
  assert.ok(rows.some((c) => c.source === 'FEE_ENGINE_FUEL'), 'fee-engine carve-out row preserved');
});

test('B1 guard: branch-3 agreement (no ReservationCharges, null-source synthesized rows) SURVIVES a pricing sync', async () => {
  // Simulate a branch-3 shaped pair: a second reservation with NO
  // ReservationCharge rows whose agreement carries synthesized null-source
  // Daily/Tax (exactly what startFromReservation branch 3 writes).
  const r2 = await prisma.reservation.create({ data: {
    reservationNumber: `R2-${TAG}`, tenantId: ids.tenant, customerId: ids.customer, vehicleId: ids.vehicle,
    pickupLocationId: ids.location, returnLocationId: ids.location,
    pickupAt: new Date(Date.now() - 86400e3), returnAt: new Date(),
    status: 'CHECKED_OUT', dailyRate: 100
  } });
  const ag2 = await prisma.rentalAgreement.create({ data: {
    agreementNumber: `RA2-${TAG}`, reservationId: r2.id, tenantId: ids.tenant, vehicleId: ids.vehicle,
    pickupAt: r2.pickupAt, returnAt: r2.returnAt, pickupLocationId: ids.location, returnLocationId: ids.location,
    customerFirstName: 'Branch', customerLastName: 'Three', status: 'FINALIZED',
    subtotal: 200, taxes: 20, total: 220, paidAmount: 0, balance: 220
  } });
  await prisma.rentalAgreementCharge.createMany({ data: [
    { rentalAgreementId: ag2.id, name: 'Daily', chargeType: 'DAILY', quantity: 2, rate: 100, total: 200, taxable: true, selected: true, sortOrder: 0, source: null },
    { rentalAgreementId: ag2.id, name: 'Tax (10.00%)', chargeType: 'TAX', quantity: 1, rate: 20, total: 20, taxable: false, selected: true, sortOrder: 1, source: null }
  ] });
  try {
    // A pricing sync with an EMPTY reservation charge set must NOT touch the
    // synthesized null rows (pre-B1 this wiped them and zeroed the agreement).
    await reservationPricingService.syncAgreementCharges(r2.id, { tenantId: ids.tenant });
    const rows = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ag2.id } });
    assert.equal(rows.length, 2, 'synthesized rows intact');
    const ag = await prisma.rentalAgreement.findUnique({ where: { id: ag2.id } });
    assert.equal(Number(ag.total), 220, 'total not zeroed by a pricing read');
    assert.equal(Number(ag.balance), 220, 'balance not zeroed');
  } finally {
    await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: ag2.id } }).catch(() => {});
    await prisma.rentalAgreement.delete({ where: { id: ag2.id } }).catch(() => {});
    await prisma.reservation.delete({ where: { id: r2.id } }).catch(() => {});
  }
});

test('syncAgreementCharges also stays null-source-clean and totals do not double', async () => {
  // Re-inject a stray legacy row, then run the pricing-side sync.
  await prisma.rentalAgreementCharge.create({ data: {
    rentalAgreementId: ids.agreement, name: 'Daily', chargeType: 'DAILY', quantity: 2, rate: 54.14, total: 108.28,
    taxable: true, selected: true, sortOrder: 0, source: null
  } });
  await reservationPricingService.syncAgreementCharges(ids.reservation, { tenantId: scope.tenantId });
  const rows = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement } });
  assert.equal(rows.filter((c) => c.chargeType === 'DAILY' && c.selected).length, 1, 'one Daily after pricing sync');
  assert.equal(rows.filter((c) => c.source === null).length, 0, 'null-source purged by pricing sync');
  const ag = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement } });
  // total = tolls 25.98 + tax 2.99 + preserved fee 30 = 58.97 (no doubled daily/tax)
  assert.equal(Number(ag.total), 58.97);
});
