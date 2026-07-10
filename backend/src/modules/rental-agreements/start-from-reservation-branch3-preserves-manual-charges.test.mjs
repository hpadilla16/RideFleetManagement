/**
 * DB-backed regression test for the Print Agreement money bug — BRANCH 3
 * (2026-07-09). Requires DATABASE_URL. Sibling of
 * start-from-reservation-preserves-manual-charges.test.mjs, which covers BRANCH 1
 * (reservation HAS selected ReservationCharge rows). This file covers BRANCH 3.
 *
 * THE BRANCH: rentalAgreementsService.startFromReservation has three charge
 * re-sync branches. Branches 1 & 2 fire when structuredReservationChargeRows
 * returns rows (the reservation has selected ReservationCharge rows) — those were
 * fixed first. BRANCH 3 is the DEFAULT / SYNTHESIZED-charges path, reached ONLY
 * when the reservation has ZERO selected ReservationCharge rows (staff / imported /
 * snapshot-priced reservations) so structuredReservationChargeRows returns null.
 * Branch 3 SYNTHESIZES the daily/service/fee/tax RentalAgreementCharge rows
 * directly (there is no ReservationCharge to mirror), which is exactly why it
 * cannot delegate to syncAgreementCharges (that reconciler re-mirrors from the
 * EMPTY reservation.charges and would delete the synthesized rows without
 * recreating them, zeroing the agreement).
 *
 * THE BUG (branch 3): the branch-3 deleteMany was UNCONDITIONAL — it wiped ALL
 * RentalAgreementCharge rows, including the agreement-only ADMIN_CORRECTION misc
 * charges and DAMAGE_CHARGE damage charges (which have no ReservationCharge to
 * re-sync from). Because startFromReservation is hit by BOTH Print/Email Agreement
 * AND GET /reservations/:id/agreement (fetched on page load), the misc/damage
 * charge vanished on refresh, never reached the contract, and the later void 404'd.
 *
 * THE CONTRACT this test locks in: on a branch-3 reservation (empty
 * reservation.charges), after adding a misc / damage charge and running
 * startFromReservation (the Print / agreement-fetch path), (a) the ADMIN_CORRECTION
 * / DAMAGE_CHARGE row STILL EXISTS exactly once by id, (b) it is still voidable
 * (voidAgreementCharge FINDS it — no 404 — and the balance drops), and (c) the
 * agreement total/balance INCLUDE it exactly once AND the SYNTHESIZED daily/tax
 * rows were re-created (agreement not zeroed, charge not double-counted).
 *
 * NOTE on the void assertion: on a branch-3 reservation the void's own
 * syncAgreementCharges re-mirrors the EMPTY reservation.charges and therefore
 * removes the synthesized daily/tax rows (only startFromReservation can
 * synthesize them). So after the void we assert the CHARGE was found + soft-voided
 * and the balance dropped — NOT a specific post-void total (that is an inherent
 * property of the synthesized-charges architecture, not part of this bug).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { rentalAgreementsService } from './rental-agreements.service.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';

const prisma = new PrismaClient();
const TAG = `SFR3-${Date.now()}`;

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
  // taxRate 10 → branch 3 synthesizes a 10% tax row on the daily base (200 → 20),
  // mirroring the reservation-charge Tax row used in the branch-1 sibling test.
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: t.id, taxRate: 10 } }); ids.location = loc.id;
  const vt = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact SUV' } }); ids.vehicleType = vt.id;
  const veh = await prisma.vehicle.create({ data: { tenant: { connect: { id: t.id } }, internalNumber: `V-${TAG}`.slice(0, 18), plate: `P${TAG}`.slice(0, 10), status: 'ON_RENT', vehicleType: { connect: { id: vt.id } } } }); ids.vehicle = veh.id;
  const cust = await prisma.customer.create({ data: { firstName: 'Sam', lastName: 'Staff', phone: '7875550200', email: `c-${TAG}@x.com`, tenantId: t.id } }); ids.customer = cust.id;
  const pickupAt = new Date(Date.now() - 2 * 86400e3); const returnAt = new Date(Date.now());
  // CHECKED_OUT reaches the re-sync path (not in the CHECKED_IN skip guard). The
  // reservation has NO ReservationCharge rows → structuredReservationChargeRows
  // returns null → startFromReservation takes BRANCH 3 (synthesized charges).
  const r = await prisma.reservation.create({ data: {
    reservationNumber: `R-${TAG}`, tenantId: t.id, customerId: cust.id, vehicleId: veh.id,
    pickupLocationId: loc.id, returnLocationId: loc.id, pickupAt, returnAt,
    status: 'CHECKED_OUT', dailyRate: 100
  } }); ids.reservation = r.id;
  // Deliberately NO reservationCharge rows — this is what forces branch 3.
  const ag = await prisma.rentalAgreement.create({ data: {
    agreementNumber: `RA-${TAG}`, reservationId: r.id, tenantId: t.id, vehicleId: veh.id,
    pickupAt, returnAt, pickupLocationId: loc.id, returnLocationId: loc.id,
    customerFirstName: 'Sam', customerLastName: 'Staff', status: 'FINALIZED',
    subtotal: 0, taxes: 0, total: 0, paidAmount: 0, balance: 0
  } }); ids.agreement = ag.id;
  return { tenantId: t.id };
}

let scope = null;
test('setup', async () => { scope = (await seed()); assert.ok(scope.tenantId); });

// Branch-3 SYNTHESIZED reservation money: daily (2 x 100 = 200) + tax (10% = 20) = 220.
const RES_TOTAL = 220;

test('BRANCH 3: reservation has no ReservationCharge rows (forces the synthesized path)', async () => {
  const resCharges = await prisma.reservationCharge.findMany({ where: { reservationId: ids.reservation, selected: true } });
  assert.equal(resCharges.length, 0, 'reservation has ZERO selected charges → startFromReservation must take branch 3');
});

test('BRANCH 3: ADMIN_CORRECTION misc charge survives Print, daily/tax re-synthesized, counted once, still voidable', async () => {
  // 1. Admin adds a $50 misc charge. addManualCharge keeps the ADMIN_CORRECTION row
  //    and recomputes via syncAgreementCharges. Because reservation.charges is EMPTY,
  //    syncAgreementCharges has nothing to synthesize, so at this point the agreement
  //    holds ONLY the misc row: total 50. (The daily/tax appear once startFromReservation
  //    runs — that is the branch-3 behavior under test.)
  const added = await reservationPricingService.addManualCharge(
    ids.reservation,
    { name: 'Cleaning re-bill', amount: 50 },
    { reason: 'admin correction', actorUserId: null, returnMeta: true },
    { tenantId: ids.tenant }
  );
  const chargeId = added.chargeId;
  assert.ok(chargeId, 'addManualCharge returned the new charge id');

  const agBefore = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { total: true } });
  assert.ok(Math.abs(Number(agBefore.total) - 50) < 0.01, `total should be 50 (misc only, no synthesized rows yet) before Print, got ${agBefore.total}`);

  // 2. Print Agreement / agreement-fetch path: startFromReservation on the
  //    CHECKED_OUT rental. Branch 3 synthesizes daily+tax AND must preserve the misc.
  await rentalAgreementsService.startFromReservation(ids.reservation, { tenantId: ids.tenant });

  // 3a. The ADMIN_CORRECTION row STILL EXISTS — exactly one, unchanged amount.
  const misc = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement, source: 'ADMIN_CORRECTION', selected: true } });
  assert.equal(misc.length, 1, 'exactly one live ADMIN_CORRECTION row survives branch-3 Print');
  assert.equal(misc[0].id, chargeId, 'the SAME charge row survives (voidable by its id)');
  assert.equal(Number(misc[0].total), 50, 'charge amount unchanged');

  // 3b. The SYNTHESIZED daily + tax rows were (re)created — agreement not zeroed.
  const daily = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement, chargeType: 'DAILY', selected: true } });
  const tax = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement, chargeType: 'TAX', selected: true } });
  assert.equal(daily.length, 1, 'synthesized Daily row present after branch-3 Print');
  assert.equal(Number(daily[0].total), 200, 'synthesized Daily total is 2 x 100');
  assert.equal(tax.length, 1, 'synthesized Tax row present after branch-3 Print');
  assert.equal(Number(tax[0].total), 20, 'synthesized Tax total is 10% of 200');

  // 3c. total/balance = daily(200) + tax(20) + misc(50) = 270 — misc counted ONCE
  //     (not dropped to 220, not doubled to 320) AND daily/tax included.
  const agAfter = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { subtotal: true, taxes: true, total: true, balance: true } });
  assert.ok(Math.abs(Number(agAfter.subtotal) - 250) < 0.01, `subtotal = daily 200 + misc 50 = 250, got ${agAfter.subtotal}`);
  assert.ok(Math.abs(Number(agAfter.taxes) - 20) < 0.01, `taxes = 20, got ${agAfter.taxes}`);
  assert.ok(Math.abs(Number(agAfter.total) - (RES_TOTAL + 50)) < 0.01, `total = 270 (daily+tax+misc, once), got ${agAfter.total}`);
  assert.ok(Math.abs(Number(agAfter.balance) - (RES_TOTAL + 50)) < 0.01, `balance = 270 (paid 0), got ${agAfter.balance}`);

  // 3d. STILL VOIDABLE: voidAgreementCharge must FIND the charge by its id (the bug
  //     deleted the row, so the void 404'd). Voiding soft-deletes it and drops balance.
  const balBefore = Number(agAfter.balance);
  await reservationPricingService.voidAgreementCharge(ids.reservation, chargeId, { reason: 'reversed' }, { tenantId: ids.tenant });
  const voided = await prisma.rentalAgreementCharge.findUnique({ where: { id: chargeId }, select: { selected: true } });
  assert.equal(voided.selected, false, 'the charge is voided (row kept for history)');
  const agVoided = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { balance: true } });
  assert.ok(Number(agVoided.balance) < balBefore, `balance drops after voiding the misc charge (${agVoided.balance} < ${balBefore})`);
});

test('BRANCH 3: DAMAGE_CHARGE survives Print, daily/tax re-synthesized, counted once, still voidable', async () => {
  // 1. Damage flow adds an $80 DAMAGE_CHARGE (agreement-only, like the misc charge).
  //    The previously-voided ADMIN_CORRECTION row from the prior test stays selected=false
  //    (excluded from totals), so this agreement now nets daily+tax+damage.
  const added = await reservationPricingService.addManualCharge(
    ids.reservation,
    { name: 'Bumper damage', amount: 80, source: 'DAMAGE_CHARGE' },
    { reason: 'report damage', actorUserId: null, returnMeta: true },
    { tenantId: ids.tenant }
  );
  const chargeId = added.chargeId;
  assert.equal(added.source, 'DAMAGE_CHARGE', 'charge landed with source DAMAGE_CHARGE');

  // 2. Print Agreement / agreement-fetch path.
  await rentalAgreementsService.startFromReservation(ids.reservation, { tenantId: ids.tenant });

  // 3a. DAMAGE_CHARGE survives, once.
  const dmg = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement, source: 'DAMAGE_CHARGE', selected: true } });
  assert.equal(dmg.length, 1, 'exactly one live DAMAGE_CHARGE survives branch-3 Print');
  assert.equal(dmg[0].id, chargeId, 'same DAMAGE_CHARGE row survives (voidable by id)');
  assert.equal(Number(dmg[0].total), 80, 'damage amount unchanged');

  // 3b. Synthesized daily/tax re-created and total = daily(200) + tax(20) + damage(80) = 300,
  //     counted once (not reverted to 220, not doubled to 380). The voided misc is excluded.
  const daily = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement, chargeType: 'DAILY', selected: true } });
  const tax = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement, chargeType: 'TAX', selected: true } });
  assert.equal(daily.length, 1, 'synthesized Daily row present after branch-3 Print');
  assert.equal(tax.length, 1, 'synthesized Tax row present after branch-3 Print');
  const agAfter = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { total: true } });
  assert.ok(Math.abs(Number(agAfter.total) - (RES_TOTAL + 80)) < 0.01, `total = 300 (daily+tax+damage, once), got ${agAfter.total}`);

  // 3c. Still voidable.
  const agBeforeVoid = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { balance: true } });
  await reservationPricingService.voidAgreementCharge(ids.reservation, chargeId, { reason: 'damage waived' }, { tenantId: ids.tenant });
  const voided = await prisma.rentalAgreementCharge.findUnique({ where: { id: chargeId }, select: { selected: true } });
  assert.equal(voided.selected, false, 'DAMAGE_CHARGE voided after branch-3 Print');
  const agVoided = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { balance: true } });
  assert.ok(Number(agVoided.balance) < Number(agBeforeVoid.balance), `balance drops after voiding the damage charge (${agVoided.balance} < ${agBeforeVoid.balance})`);
});
