/**
 * DB-backed tests for the AGE RULES at check-out (LAX meeting 2026-07-28).
 * Requires DATABASE_URL (embedded-postgres locally, see doc/SESSION-HANDOFF.md).
 *
 * Covers the full arc:
 *  - pricing engine auto-applies the mandatory underage fee (source
 *    UNDERAGE_FEE) for a 21-24 driver, per-day math, agreement mirror
 *  - an admin void (selected=false) survives the next recompute
 *  - aging out of the band removes the fee row
 *  - checkout-session start gate: DOB_REQUIRED (no DOB), UNDER_MIN (<21),
 *    and the happy path for an in-band driver
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';
import { checkoutSessionService, CheckoutSessionError } from './checkout-session.service.js';

const prisma = new PrismaClient();
const TAG = `AGR-${Date.now()}`;

// Fixed 3-day rental window, far enough out that age math is deterministic.
const PICKUP_AT = new Date(Date.now() + 30 * 86400e3);
const RETURN_AT = new Date(PICKUP_AT.getTime() + 3 * 86400e3);
const DAYS = 3;
const FEE_PER_DAY = 15;

function dobForAge(age) {
  const d = new Date(PICKUP_AT);
  return new Date(Date.UTC(d.getUTCFullYear() - age, d.getUTCMonth(), Math.max(1, d.getUTCDate() - 7)));
}

const ids = { tenant: null, location: null, fee: null, vehicleType: null, vehicle: null, customer: null, reservation: null };

test.after(async () => {
  if (ids.reservation) {
    const s = await prisma.checkoutSession.findUnique({ where: { reservationId: ids.reservation } }).catch(() => null);
    if (s) await prisma.checkoutSession.delete({ where: { id: s.id } }).catch(() => {});
    const ag = await prisma.rentalAgreement.findFirst({ where: { reservationId: ids.reservation } }).catch(() => null);
    if (ag) {
      await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: ag.id } }).catch(() => {});
      await prisma.rentalAgreement.delete({ where: { id: ag.id } }).catch(() => {});
    }
    await prisma.auditLog.deleteMany({ where: { reservationId: ids.reservation } }).catch(() => {});
    await prisma.reservationPricingSnapshot.deleteMany({ where: { reservationId: ids.reservation } }).catch(() => {});
    await prisma.reservationCharge.deleteMany({ where: { reservationId: ids.reservation } }).catch(() => {});
    await prisma.reservation.delete({ where: { id: ids.reservation } }).catch(() => {});
  }
  if (ids.fee) {
    await prisma.locationFee.deleteMany({ where: { feeId: ids.fee } }).catch(() => {});
    await prisma.fee.delete({ where: { id: ids.fee } }).catch(() => {});
  }
  if (ids.vehicle) await prisma.vehicle.delete({ where: { id: ids.vehicle } }).catch(() => {});
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where: { id: ids.vehicleType } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

async function seed() {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } }); ids.tenant = t.id;
  const loc = await prisma.location.create({ data: {
    code: `L-${TAG}`.slice(0, 12), name: 'LAX Test', tenantId: t.id,
    locationConfig: JSON.stringify({ ageRulesEnforced: true, chargeAgeMin: 21, underageFeeMaxAge: 24 }),
  } }); ids.location = loc.id;
  const fee = await prisma.fee.create({ data: {
    tenantId: t.id, code: `UF-${TAG}`.slice(0, 12), name: 'Young Driver Fee',
    mode: 'PER_DAY', amount: FEE_PER_DAY, taxable: false, isActive: true, isUnderageFee: true,
  } }); ids.fee = fee.id;
  await prisma.locationFee.create({ data: { locationId: loc.id, feeId: fee.id } });
  const vt = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `VT-${TAG}`.slice(0, 10), name: 'SUV' } }); ids.vehicleType = vt.id;
  const veh = await prisma.vehicle.create({ data: {
    tenant: { connect: { id: t.id } }, internalNumber: `V-${TAG}`.slice(0, 18),
    plate: `P${TAG}`.slice(0, 10), status: 'AVAILABLE', vehicleType: { connect: { id: vt.id } },
  } }); ids.vehicle = veh.id;
  const cust = await prisma.customer.create({ data: {
    firstName: 'Joven', lastName: 'Conductor', phone: '7875550123', email: `c-${TAG}@x.com`,
    tenantId: t.id, dateOfBirth: dobForAge(22),
  } }); ids.customer = cust.id;
  const r = await prisma.reservation.create({ data: {
    reservationNumber: `R-${TAG}`, tenantId: t.id, customerId: cust.id, vehicleId: veh.id,
    pickupLocationId: loc.id, returnLocationId: loc.id, pickupAt: PICKUP_AT, returnAt: RETURN_AT,
    status: 'CONFIRMED', dailyRate: 50,
  } }); ids.reservation = r.id;
  return { tenantId: t.id };
}

let scope = null;
test('setup', async () => { scope = await seed(); assert.ok(scope.tenantId); });

test('pricing: 22-year-old in the band gets the mandatory UNDERAGE_FEE row (per-day math)', async () => {
  const pricing = await reservationPricingService.getPricing(ids.reservation, { tenantId: scope.tenantId });
  const row = pricing.charges.find((c) => c.source === 'UNDERAGE_FEE');
  assert.ok(row, 'UNDERAGE_FEE charge exists');
  assert.equal(String(row.sourceRefId), String(ids.fee));
  assert.equal(Number(row.total), FEE_PER_DAY * DAYS);
  assert.equal(row.selected, true);
});

test('gate: no DOB → session start rejects AGE_RULES_DOB_REQUIRED', async () => {
  await prisma.customer.update({ where: { id: ids.customer }, data: { dateOfBirth: null } });
  await assert.rejects(
    () => checkoutSessionService.createForReservation({ reservationId: ids.reservation, tenantId: scope.tenantId }),
    (err) => err instanceof CheckoutSessionError && err.code === 'AGE_RULES_DOB_REQUIRED' && err.status === 422,
  );
});

test('gate: 19-year-old → session start rejects AGE_RULES_UNDER_MIN', async () => {
  await prisma.customer.update({ where: { id: ids.customer }, data: { dateOfBirth: dobForAge(19) } });
  await assert.rejects(
    () => checkoutSessionService.createForReservation({ reservationId: ids.reservation, tenantId: scope.tenantId }),
    (err) => err instanceof CheckoutSessionError && err.code === 'AGE_RULES_UNDER_MIN' && err.status === 422,
  );
});

test('gate: 22-year-old → session starts, agreement mirror carries the underage fee', async () => {
  await prisma.customer.update({ where: { id: ids.customer }, data: { dateOfBirth: dobForAge(22) } });
  const session = await checkoutSessionService.createForReservation({ reservationId: ids.reservation, tenantId: scope.tenantId });
  assert.ok(session?.id, 'session created');
  assert.equal(session.currentStep, 'CONFIRMING');
  assert.ok(session.agreementId, 'agreement auto-created');
  const mirrored = await prisma.rentalAgreementCharge.findFirst({
    where: { rentalAgreementId: session.agreementId, source: 'UNDERAGE_FEE' },
  });
  assert.ok(mirrored, 'underage fee mirrored onto the agreement');
  assert.equal(Number(mirrored.total), FEE_PER_DAY * DAYS);
});

test('void survives: admin-voided underage fee stays voided through a recompute', async () => {
  const row = await prisma.reservationCharge.findFirst({
    where: { reservationId: ids.reservation, source: 'UNDERAGE_FEE' },
  });
  assert.ok(row);
  await prisma.reservationCharge.update({ where: { id: row.id }, data: { selected: false } });
  const pricing = await reservationPricingService.getPricing(ids.reservation, { tenantId: scope.tenantId });
  assert.ok(!pricing.charges.some((c) => c.source === 'UNDERAGE_FEE'), 'voided fee excluded from pricing');
  const persisted = await prisma.reservationCharge.findUnique({ where: { id: row.id } });
  assert.equal(persisted.selected, false, 'void not rebounded by the recompute');
  // Re-select for the next test.
  await prisma.reservationCharge.update({ where: { id: row.id }, data: { selected: true } });
});

test('aging out: DOB → 30 removes the UNDERAGE_FEE row on the next recompute', async () => {
  await prisma.customer.update({ where: { id: ids.customer }, data: { dateOfBirth: dobForAge(30) } });
  const pricing = await reservationPricingService.getPricing(ids.reservation, { tenantId: scope.tenantId });
  assert.ok(!pricing.charges.some((c) => c.source === 'UNDERAGE_FEE'), 'fee gone from pricing');
  const rows = await prisma.reservationCharge.findMany({
    where: { reservationId: ids.reservation, source: 'UNDERAGE_FEE' },
  });
  assert.equal(rows.length, 0, 'stale UNDERAGE_FEE row deleted');
});
