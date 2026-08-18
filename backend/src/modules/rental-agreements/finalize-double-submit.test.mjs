/**
 * DB-backed regression test for the double-finalize bug (2026-08-18).
 *
 * THE BUG: POST /api/rental-agreements/:id/finalize had no already-FINALIZED
 * precondition, so a second POST (double-click at the counter, or a client
 * retrying a request whose response was lost) re-ran the entire finalize write
 * body against a contract that was already done. Two writes did real damage:
 *   - `finalizedAt` was rewritten, so the contract claimed the car left on the
 *     day of the RETRY instead of the day it actually left — audit-trail loss;
 *   - a SECOND CHECKOUT row was appended to the vehicle's mileage timeline
 *     (recordMileageEntry is a bare create, deliberately: MANUAL corrections are
 *     meant to repeat, and a vehicle swap can legitimately produce another
 *     CHECKOUT reading — so the duplicate had to be stopped at this entry point,
 *     not deduped downstream).
 *
 * The fake-tx tests in rental-agreements-finalize-tx.test.mjs prove the SHAPE of
 * the compare-and-set claim. This one proves the outcome against a real
 * database: finalize twice, and the contract plus the timeline are untouched.
 *
 * Requires DATABASE_URL. Seeds its own tenant/location/vehicleType/vehicle/
 * customer/reservation/agreement and cleans up after itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { rentalAgreementsService } from './rental-agreements.service.js';

const prisma = new PrismaClient();
const TAG = `FDS-${Date.now()}`;
const ids = { tenant: null, location: null, vehicleType: null, vehicle: null, customer: null, reservation: null, agreement: null };

// The body the counter sends. fuelOut is 7/8 as a fraction — the column is
// Decimal(4,2), so it reads back as 0.88; the replay guard must still recognize
// the identical retry.
const FINALIZE_BODY = Object.freeze({
  odometerOut: 41000,
  fuelOut: 0.875,
  paidAmount: 100,
  paymentMethod: 'CARD',
  paymentReference: `TXN-${TAG}`
});

test.after(async () => {
  if (ids.agreement) {
    await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: ids.agreement } }).catch(() => {});
    await prisma.rentalAgreementPayment.deleteMany({ where: { rentalAgreementId: ids.agreement } }).catch(() => {});
  }
  if (ids.reservation) await prisma.auditLog.deleteMany({ where: { reservationId: ids.reservation } }).catch(() => {});
  if (ids.vehicle) {
    await prisma.vehicleMileageEntry.deleteMany({ where: { vehicleId: ids.vehicle } }).catch(() => {});
    await prisma.vehicleFuelReading.deleteMany({ where: { vehicleId: ids.vehicle } }).catch(() => {});
  }
  if (ids.agreement) await prisma.rentalAgreement.delete({ where: { id: ids.agreement } }).catch(() => {});
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
  const vt = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact' } }); ids.vehicleType = vt.id;
  const veh = await prisma.vehicle.create({ data: {
    tenant: { connect: { id: t.id } }, internalNumber: `V-${TAG}`.slice(0, 18),
    vehicleType: { connect: { id: vt.id } }, status: 'AVAILABLE', mileage: 40000
  } }); ids.vehicle = veh.id;
  const cust = await prisma.customer.create({ data: { firstName: 'Dou', lastName: 'Ble', phone: '7875550001', email: `c-${TAG}@x.com`, tenantId: t.id } }); ids.customer = cust.id;
  const pickupAt = new Date(Date.now() - 3600e3);
  const returnAt = new Date(Date.now() + 2 * 86400e3);
  const r = await prisma.reservation.create({ data: {
    reservationNumber: `R-${TAG}`, tenantId: t.id, customerId: cust.id, vehicleId: veh.id,
    pickupLocationId: loc.id, returnLocationId: loc.id, pickupAt, returnAt, status: 'CONFIRMED'
  } }); ids.reservation = r.id;
  const ag = await prisma.rentalAgreement.create({ data: {
    agreementNumber: `RA-${TAG}`, reservationId: r.id, tenantId: t.id, vehicleId: veh.id,
    pickupAt, returnAt, pickupLocationId: loc.id, returnLocationId: loc.id,
    customerFirstName: 'Dou', customerLastName: 'Ble', licenseNumber: 'L-9911',
    dateOfBirth: new Date('1990-01-01'), status: 'DRAFT',
    total: 300, paidAmount: 0, balance: 300
  } }); ids.agreement = ag.id;
  await prisma.rentalAgreementCharge.create({ data: {
    rentalAgreementId: ag.id, name: 'Daily', chargeType: 'DAILY', quantity: 2, rate: 150, total: 300, selected: true
  } });
}

// Snapshot of everything a second finalize must NOT disturb.
async function contractState() {
  const ag = await prisma.rentalAgreement.findUnique({
    where: { id: ids.agreement },
    select: { status: true, finalizedAt: true, odometerOut: true, fuelOut: true, paidAmount: true, balance: true, paymentReference: true }
  });
  const [checkoutMileage, payments, fuelReadings, resv] = await Promise.all([
    prisma.vehicleMileageEntry.findMany({ where: { vehicleId: ids.vehicle, source: 'CHECKOUT' }, select: { id: true, mileage: true } }),
    prisma.rentalAgreementPayment.findMany({ where: { rentalAgreementId: ids.agreement }, select: { id: true, amount: true } }),
    prisma.vehicleFuelReading.findMany({ where: { vehicleId: ids.vehicle, source: 'CHECKOUT' }, select: { id: true } }),
    prisma.reservation.findUnique({ where: { id: ids.reservation }, select: { status: true } })
  ]);
  return { ag, checkoutMileage, payments, fuelReadings, reservationStatus: resv?.status || null };
}

let afterFirst = null;

test('first finalize checks the car out: FINALIZED, one CHECKOUT mileage entry, reservation CHECKED_OUT', async () => {
  await seed();
  await rentalAgreementsService.finalize(ids.agreement, { ...FINALIZE_BODY });
  afterFirst = await contractState();

  assert.equal(afterFirst.ag.status, 'FINALIZED');
  assert.ok(afterFirst.ag.finalizedAt instanceof Date, 'finalizedAt stamped');
  assert.equal(afterFirst.checkoutMileage.length, 1, 'exactly one CHECKOUT mileage entry');
  assert.equal(Number(afterFirst.checkoutMileage[0].mileage), FINALIZE_BODY.odometerOut);
  assert.equal(afterFirst.payments.length, 1, 'one payment row for the card taken at the counter');
  assert.equal(afterFirst.reservationStatus, 'CHECKED_OUT');
});

test('THE BUG: a second finalize with the same body rewrites NOTHING', async () => {
  // The double-click. Before the fix this rewrote finalizedAt to today and
  // appended a second CHECKOUT row to the timeline.
  const replayed = await rentalAgreementsService.finalize(ids.agreement, { ...FINALIZE_BODY });
  assert.ok(replayed, 'the retry still gets the contract back, not an error');

  const after = await contractState();
  assert.equal(
    after.ag.finalizedAt.toISOString(), afterFirst.ag.finalizedAt.toISOString(),
    'finalizedAt must still be the moment the car actually left'
  );
  assert.equal(after.checkoutMileage.length, 1, 'still exactly ONE CHECKOUT mileage entry');
  assert.equal(after.checkoutMileage[0].id, afterFirst.checkoutMileage[0].id, 'and it is the same row');
  assert.equal(after.fuelReadings.length, afterFirst.fuelReadings.length, 'no duplicate CHECKOUT fuel reading');
  assert.equal(after.payments.length, 1, 'no duplicate payment row');
  assert.equal(Number(after.ag.balance), Number(afterFirst.ag.balance), 'balance untouched');
});

test('a retry that omits the body, or restates it in another shape, is still a retry', async () => {
  await rentalAgreementsService.finalize(ids.agreement, {});
  await rentalAgreementsService.finalize(ids.agreement, { ...FINALIZE_BODY, paidAmount: '100.00' });

  const after = await contractState();
  assert.equal(after.ag.finalizedAt.toISOString(), afterFirst.ag.finalizedAt.toISOString());
  assert.equal(after.checkoutMileage.length, 1);
  assert.equal(after.payments.length, 1);
});

test('a retry carrying DIFFERENT values is refused (409) instead of being silently dropped', async () => {
  // Sending a corrected odometer through finalize used to overwrite the signed
  // contract. Answering it 200 and discarding it would be no better, so it is a
  // 409 that names the field and points at the correction flow.
  await assert.rejects(
    () => rentalAgreementsService.finalize(ids.agreement, { ...FINALIZE_BODY, odometerOut: 41999 }),
    (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /already finalized/i);
      assert.match(err.message, /odometerOut/);
      return true;
    }
  );
  const after = await contractState();
  assert.equal(Number(after.ag.odometerOut), FINALIZE_BODY.odometerOut, 'the signed odometer stands');
  assert.equal(after.checkoutMileage.length, 1, 'a refused retry writes nothing');
});

test('a CLOSED agreement cannot be finalized at all', async () => {
  await prisma.rentalAgreement.update({ where: { id: ids.agreement }, data: { status: 'CLOSED' } });
  await assert.rejects(
    () => rentalAgreementsService.finalize(ids.agreement, { ...FINALIZE_BODY }),
    (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /can no longer be checked out/i);
      return true;
    }
  );
  const after = await contractState();
  assert.equal(after.checkoutMileage.length, 1, 'still one CHECKOUT entry');
});

test('concurrent finalizes: only ONE claim wins, and the losers write nothing', async () => {
  // The race the compare-and-set exists for. Put the agreement back in DRAFT and
  // fire five finalizes at once: exactly one may stamp finalizedAt and append the
  // mileage entry; the rest must resolve as replays, not duplicates.
  await prisma.vehicleMileageEntry.deleteMany({ where: { vehicleId: ids.vehicle } });
  await prisma.vehicleFuelReading.deleteMany({ where: { vehicleId: ids.vehicle } });
  await prisma.rentalAgreementPayment.deleteMany({ where: { rentalAgreementId: ids.agreement } });
  await prisma.rentalAgreement.update({
    where: { id: ids.agreement },
    data: { status: 'DRAFT', finalizedAt: null, paidAmount: 0, balance: 300 }
  });
  await prisma.reservation.update({ where: { id: ids.reservation }, data: { status: 'CONFIRMED' } });

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => rentalAgreementsService.finalize(ids.agreement, { ...FINALIZE_BODY }))
  );
  assert.deepEqual(
    results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message),
    [],
    'no caller should see an error for an identical body'
  );

  const after = await contractState();
  assert.equal(after.ag.status, 'FINALIZED');
  assert.equal(after.checkoutMileage.length, 1, 'five concurrent finalizes → ONE CHECKOUT mileage entry');
  assert.equal(after.payments.length, 1, 'five concurrent finalizes → ONE payment row');
});
