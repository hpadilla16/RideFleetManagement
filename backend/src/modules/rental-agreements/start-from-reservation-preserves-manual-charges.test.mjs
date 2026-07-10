/**
 * DB-backed regression test for the Print Agreement money bug (2026-07-09).
 * Requires DATABASE_URL. Seeds its own tenant/vehicle/customer/location plus a
 * CHECKED_OUT reservation (with selected ReservationCharges) and its agreement.
 *
 * THE BUG: rentalAgreementsService.startFromReservation (hit by handlePrintAgreement
 * → POST /reservations/:id/start-rental on a CHECKED_OUT rental) used to run an
 * UNCONDITIONAL deleteMany of ALL RentalAgreementCharge rows and recreate only the
 * reservation-mirrored rows. That erased the agreement-only rows — ADMIN_CORRECTION
 * misc charges and DAMAGE_CHARGE damage charges — so Print Agreement made the charge
 * vanish AND left the void unable to find its chargeId, and it reverted total/balance.
 *
 * THE CONTRACT this test locks in: after adding a misc / damage charge and then
 * running startFromReservation (the Print path), the ADMIN_CORRECTION / DAMAGE_CHARGE
 * row STILL EXISTS exactly once, is STILL voidable (voidAgreementCharge finds it), and
 * the agreement total/balance still include it ONCE (not reverted, not doubled).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { rentalAgreementsService } from './rental-agreements.service.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';

const prisma = new PrismaClient();
const TAG = `SFR-${Date.now()}`;

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
  const vt = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact SUV' } }); ids.vehicleType = vt.id;
  const veh = await prisma.vehicle.create({ data: { tenant: { connect: { id: t.id } }, internalNumber: `V-${TAG}`.slice(0, 18), plate: `P${TAG}`.slice(0, 10), status: 'ON_RENT', vehicleType: { connect: { id: vt.id } } } }); ids.vehicle = veh.id;
  const cust = await prisma.customer.create({ data: { firstName: 'Pat', lastName: 'Printer', phone: '7875550100', email: `c-${TAG}@x.com`, tenantId: t.id } }); ids.customer = cust.id;
  const pickupAt = new Date(Date.now() - 2 * 86400e3); const returnAt = new Date(Date.now());
  // CHECKED_OUT is the status that reaches the (formerly buggy) re-sync path — it
  // is NOT in the CHECKED_IN / CHECKED_IN_UNPAID skip guard.
  const r = await prisma.reservation.create({ data: {
    reservationNumber: `R-${TAG}`, tenantId: t.id, customerId: cust.id, vehicleId: veh.id,
    pickupLocationId: loc.id, returnLocationId: loc.id, pickupAt, returnAt,
    status: 'CHECKED_OUT', dailyRate: 100
  } }); ids.reservation = r.id;
  // Selected reservation charges → structuredReservationChargeRows returns rows,
  // so startFromReservation takes the structuredRows re-sync path (the bug path).
  await prisma.reservationCharge.createMany({ data: [
    { reservationId: r.id, name: 'Daily', chargeType: 'DAILY', quantity: 2, rate: 100, total: 200, taxable: true, selected: true, sortOrder: 0, source: 'DAILY' },
    { reservationId: r.id, name: 'Tax (10.00%)', chargeType: 'TAX', quantity: 1, rate: 20, total: 20, taxable: false, selected: true, sortOrder: 1, source: 'TAX' }
  ] });
  const ag = await prisma.rentalAgreement.create({ data: {
    agreementNumber: `RA-${TAG}`, reservationId: r.id, tenantId: t.id, vehicleId: veh.id,
    pickupAt, returnAt, pickupLocationId: loc.id, returnLocationId: loc.id,
    customerFirstName: 'Pat', customerLastName: 'Printer', status: 'FINALIZED',
    subtotal: 0, taxes: 0, total: 0, paidAmount: 0, balance: 0
  } }); ids.agreement = ag.id;
  return { tenantId: t.id };
}

let scope = null;
test('setup', async () => { scope = (await seed()); assert.ok(scope.tenantId); });

// Baseline reservation-only agreement money: subtotal 200 + tax 20 = 220.
const RES_TOTAL = 220;

test('ADMIN_CORRECTION misc charge survives Print (start-rental) and stays voidable, counted once', async () => {
  // 1. Admin adds a $50 misc charge. addManualCharge mirrors reservation rows +
  //    keeps the ADMIN_CORRECTION row and recomputes: total 220 + 50 = 270.
  const added = await reservationPricingService.addManualCharge(
    ids.reservation,
    { name: 'Cleaning re-bill', amount: 50 },
    { reason: 'admin correction', actorUserId: null, returnMeta: true },
    { tenantId: ids.tenant }
  );
  const chargeId = added.chargeId;
  assert.ok(chargeId, 'addManualCharge returned the new charge id');

  const agBefore = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { total: true, balance: true } });
  assert.ok(Math.abs(Number(agBefore.total) - (RES_TOTAL + 50)) < 0.01, `total should be 270 after add, got ${agBefore.total}`);
  assert.ok(Math.abs(Number(agBefore.balance) - (RES_TOTAL + 50)) < 0.01, `balance should be 270 after add, got ${agBefore.balance}`);

  // 2. Print Agreement path: startFromReservation on the CHECKED_OUT rental.
  await rentalAgreementsService.startFromReservation(ids.reservation, { tenantId: ids.tenant });

  // 3a. The ADMIN_CORRECTION row STILL EXISTS — exactly one, unchanged amount.
  const rows = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement, source: 'ADMIN_CORRECTION', selected: true } });
  assert.equal(rows.length, 1, 'exactly one live ADMIN_CORRECTION row survives Print');
  assert.equal(rows[0].id, chargeId, 'the SAME charge row survives (voidable by its id)');
  assert.equal(Number(rows[0].total), 50, 'charge amount unchanged');

  // 3b. total/balance still include it ONCE — not reverted to 220, not doubled to 320.
  const agAfter = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { total: true, balance: true } });
  assert.ok(Math.abs(Number(agAfter.total) - (RES_TOTAL + 50)) < 0.01, `total still 270 after Print (once, no revert/double), got ${agAfter.total}`);
  assert.ok(Math.abs(Number(agAfter.balance) - (RES_TOTAL + 50)) < 0.01, `balance still 270 after Print, got ${agAfter.balance}`);

  // 3c. STILL VOIDABLE: voidAgreementCharge must FIND the charge by its id (the bug
  //     deleted the row, so the void 404'd). Voiding it drops the balance by $50.
  await reservationPricingService.voidAgreementCharge(ids.reservation, chargeId, { reason: 'reversed' }, { tenantId: ids.tenant });
  const voided = await prisma.rentalAgreementCharge.findUnique({ where: { id: chargeId }, select: { selected: true } });
  assert.equal(voided.selected, false, 'the charge is voided (row kept for history)');
  const agVoided = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { total: true, balance: true } });
  assert.ok(Math.abs(Number(agVoided.total) - RES_TOTAL) < 0.01, `total back to 220 after void, got ${agVoided.total}`);
  assert.ok(Math.abs(Number(agVoided.balance) - RES_TOTAL) < 0.01, `balance back to 220 after void, got ${agVoided.balance}`);
});

test('DAMAGE_CHARGE survives Print (start-rental) and stays voidable, counted once', async () => {
  // 1. Damage flow adds an $80 DAMAGE_CHARGE (agreement-only, like the misc charge).
  const added = await reservationPricingService.addManualCharge(
    ids.reservation,
    { name: 'Bumper damage', amount: 80, source: 'DAMAGE_CHARGE' },
    { reason: 'report damage', actorUserId: null, returnMeta: true },
    { tenantId: ids.tenant }
  );
  const chargeId = added.chargeId;
  assert.equal(added.source, 'DAMAGE_CHARGE', 'charge landed with source DAMAGE_CHARGE');

  const agBefore = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { total: true } });
  assert.ok(Math.abs(Number(agBefore.total) - (RES_TOTAL + 80)) < 0.01, `total should be 300 after damage add, got ${agBefore.total}`);

  // 2. Print Agreement path.
  await rentalAgreementsService.startFromReservation(ids.reservation, { tenantId: ids.tenant });

  // 3a. DAMAGE_CHARGE survives, once.
  const rows = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement, source: 'DAMAGE_CHARGE', selected: true } });
  assert.equal(rows.length, 1, 'exactly one live DAMAGE_CHARGE survives Print');
  assert.equal(rows[0].id, chargeId, 'same DAMAGE_CHARGE row survives (voidable by id)');
  assert.equal(Number(rows[0].total), 80, 'damage amount unchanged');

  // 3b. total includes it once (300), not reverted to 220, not doubled to 380.
  const agAfter = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { total: true } });
  assert.ok(Math.abs(Number(agAfter.total) - (RES_TOTAL + 80)) < 0.01, `total still 300 after Print, got ${agAfter.total}`);

  // 3c. Still voidable.
  await reservationPricingService.voidAgreementCharge(ids.reservation, chargeId, { reason: 'damage waived' }, { tenantId: ids.tenant });
  const voided = await prisma.rentalAgreementCharge.findUnique({ where: { id: chargeId }, select: { selected: true } });
  assert.equal(voided.selected, false, 'DAMAGE_CHARGE voided after Print');
  const agVoided = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { total: true } });
  assert.ok(Math.abs(Number(agVoided.total) - RES_TOTAL) < 0.01, `total back to 220 after void, got ${agVoided.total}`);
});
