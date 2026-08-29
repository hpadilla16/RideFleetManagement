/**
 * DB-backed regression: RentalAgreement.returnedAt survives a close that
 * leaves an OUTSTANDING BALANCE.
 *
 * THE BUG (found 2026-08-26): closeAgreementWithCheckinFees computed
 * `returnedAt` — the moment the car actually came back, and the timestamp the
 * fee engine bills LATE_RETURN from — but wrote it to the agreement ONLY
 * inside the `balance <= 0` branch. The `balance > 0` branch updates the
 * RESERVATION and never touches the agreement, and the later closeAgreement()
 * that finally flips such an agreement to CLOSED does not write returnedAt
 * either. So the value was dropped on exactly the closes that needed it most:
 * a rental closes owing money BECAUSE it was charged a late fee, and the
 * timestamp justifying that charge was gone. A customer disputing the fee
 * could not be answered from the record.
 *
 * The primary test below is the with-balance close. A zero-balance test would
 * have passed before the fix and proven nothing, so it is here only as a
 * no-regression control on the path that already worked.
 *
 * Requires DATABASE_URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { closeAgreementWithCheckinFees } from './checkin-close.service.js';

const prisma = new PrismaClient();
const TAG = `RAT-${Date.now()}`;

const HOUR = 3600e3;
const DAY = 24 * HOUR;

const ids = {
  tenant: null, location: null, vehicleType: null, customer: null,
  vehicles: [], reservations: [], agreements: [], settingKey: null,
};

test.after(async () => {
  for (const a of ids.agreements) {
    await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: a } }).catch(() => {});
    await prisma.rentalAgreementPayment.deleteMany({ where: { rentalAgreementId: a } }).catch(() => {});
    await prisma.rentalAgreement.delete({ where: { id: a } }).catch(() => {});
  }
  for (const r of ids.reservations) {
    await prisma.auditLog.deleteMany({ where: { reservationId: r } }).catch(() => {});
    await prisma.reservationCharge.deleteMany({ where: { reservationId: r } }).catch(() => {});
    await prisma.loanerAgreement.deleteMany({ where: { reservationId: r } }).catch(() => {});
    await prisma.reservation.delete({ where: { id: r } }).catch(() => {});
  }
  for (const v of ids.vehicles) await prisma.vehicle.delete({ where: { id: v } }).catch(() => {});
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where: { id: ids.vehicleType } }).catch(() => {});
  if (ids.settingKey) await prisma.appSetting.delete({ where: { key: ids.settingKey } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

async function seedShared() {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = t.id;
  // checkinEmailDelayHours > 0 defers the post-check-in email (LAX #8), so the
  // close logs instead of reaching for SMTP. Grace 30 = the engine default.
  const loc = await prisma.location.create({ data: {
    code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: t.id,
    locationConfig: JSON.stringify({ checkinEmailDelayHours: 1, gracePeriodMin: 30 }),
  } });
  ids.location = loc.id;
  // autocharge MANUAL — the with-balance branch then leaves the balance for
  // staff instead of enqueueing a BullMQ job against a Redis this test has no
  // business needing.
  ids.settingKey = `tenant:${t.id}:paymentGatewayConfig`;
  await prisma.appSetting.create({ data: {
    key: ids.settingKey, value: JSON.stringify({ autocharge: { mode: 'MANUAL' } }),
  } });
  const vt = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `VT-${TAG}`.slice(0, 10), name: 'SUV' } });
  ids.vehicleType = vt.id;
  const cust = await prisma.customer.create({ data: {
    firstName: 'Late', lastName: 'Returner', phone: '7875550188', email: `c-${TAG}@x.com`, tenantId: t.id,
  } });
  ids.customer = cust.id;
}

/**
 * A checked-out rental due back `dueHoursAgo` hours ago, carrying `dailyTotal`
 * of unpaid charges (0 = nothing owed, i.e. the paid-in-full branch).
 */
async function seedRental({ label, dueHoursAgo, dailyTotal }) {
  const veh = await prisma.vehicle.create({ data: {
    tenant: { connect: { id: ids.tenant } },
    internalNumber: `V-${label}-${TAG}`.slice(0, 18), plate: `P${label}${TAG}`.slice(0, 10),
    status: 'ON_RENT', vehicleType: { connect: { id: ids.vehicleType } },
  } });
  ids.vehicles.push(veh.id);
  const pickupAt = new Date(Date.now() - 3 * DAY);
  const returnAt = new Date(Date.now() - dueHoursAgo * HOUR);
  const r = await prisma.reservation.create({ data: {
    reservationNumber: `R-${label}-${TAG}`, tenantId: ids.tenant, customerId: ids.customer, vehicleId: veh.id,
    pickupLocationId: ids.location, returnLocationId: ids.location, pickupAt, returnAt,
    status: 'CHECKED_OUT', dailyRate: 0,
  } });
  ids.reservations.push(r.id);
  const ag = await prisma.rentalAgreement.create({ data: {
    agreementNumber: `RA-${label}-${TAG}`, reservationId: r.id, tenantId: ids.tenant, vehicleId: veh.id,
    pickupAt, returnAt, pickupLocationId: ids.location, returnLocationId: ids.location,
    customerFirstName: 'Late', customerLastName: 'Returner', status: 'FINALIZED',
    finalizedAt: pickupAt,
    odometerOut: 10000, fuelOut: 1, cleanlinessOut: 5,
    subtotal: dailyTotal, taxes: 0, fees: 0, total: dailyTotal, paidAmount: 0, balance: dailyTotal,
  } });
  ids.agreements.push(ag.id);
  if (dailyTotal > 0) {
    await prisma.rentalAgreementCharge.create({ data: {
      rentalAgreementId: ag.id, name: 'Daily', chargeType: 'DAILY', quantity: 3,
      rate: dailyTotal / 3, total: dailyTotal, taxable: false, selected: true, sortOrder: 0, source: 'DAILY',
    } });
  }
  return { agreementId: ag.id, reservationId: r.id };
}

test('setup', async () => {
  await seedShared();
  assert.ok(ids.tenant);
});

test('THE CASE: a close that leaves an outstanding balance still stores returnedAt', async () => {
  // Due back 4 hours ago, $300 of unpaid rental on the books. The car came
  // back 3 hours late, so a LATE_RETURN fee lands, which is precisely why the
  // agreement closes owing money.
  const { agreementId, reservationId } = await seedRental({ label: 'BAL', dueHoursAgo: 4, dailyTotal: 300 });
  const returnedAt = new Date(Date.now() - 1 * HOUR);   // 3h past the due time

  const res = await closeAgreementWithCheckinFees(
    agreementId,
    { odometerIn: 10120, fuelIn: 1, cleanlinessIn: 5, returnedAt: returnedAt.toISOString() },
    null, null, 'ADMIN'
  );

  assert.ok(res.newBalance > 0, `precondition: the close must leave a balance (got ${res.newBalance})`);
  assert.equal(res.reservationStatus, 'CHECKED_IN_UNPAID', 'this is the with-balance branch');
  const late = res.feesAdded.find((f) => f.feeType === 'LATE_RETURN');
  assert.ok(late, 'a LATE_RETURN fee was charged: this is the timestamp that has to be defensible');

  const row = await prisma.rentalAgreement.findUnique({
    where: { id: agreementId }, select: { returnedAt: true, closedAt: true },
  });
  assert.ok(row.returnedAt, 'returnedAt persisted on the with-balance close (was NULL before the fix)');
  assert.equal(
    row.returnedAt.toISOString(), returnedAt.toISOString(),
    'the stored moment is the one the late fee was billed from'
  );
  // The agreement stays open until the balance resolves; returnedAt must not
  // be waiting on closedAt to be written.
  assert.equal(row.closedAt, null, 'agreement still open, and returnedAt does not depend on the close');

  const resv = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { status: true } });
  assert.equal(resv.status, 'CHECKED_IN_UNPAID');
});

test('the stored timestamp is what the late fee was actually computed from', async () => {
  // Same shape, backdated: staff records the check-in now, but the car came
  // back 5 hours ago and only 1 hour late. The fee must reflect the BACKDATED
  // moment, and the record must show that same moment.
  const { agreementId } = await seedRental({ label: 'BACK', dueHoursAgo: 6, dailyTotal: 300 });
  const returnedAt = new Date(Date.now() - 5 * HOUR);   // 1h past due -> 1h billable (30m grace)

  const res = await closeAgreementWithCheckinFees(
    agreementId,
    { odometerIn: 10050, fuelIn: 1, cleanlinessIn: 5, returnedAt: returnedAt.toISOString() },
    null, null, 'ADMIN'
  );

  const late = res.feesAdded.find((f) => f.feeType === 'LATE_RETURN');
  assert.ok(late, 'LATE_RETURN charged');
  assert.equal(late.quantity, 1, '1 billable hour from the BACKDATED return, not from now');

  const row = await prisma.rentalAgreement.findUnique({
    where: { id: agreementId }, select: { returnedAt: true },
  });
  assert.equal(row.returnedAt.toISOString(), returnedAt.toISOString(),
    'the record can be handed to a disputing customer and recomputed');
});

test('a rejected backdate leaves no partial check-in behind', async () => {
  // An AGENT may not backdate past the grace. The 403 has to land before the
  // odometer reading is written, or a refused close still mutates the record.
  const { agreementId } = await seedRental({ label: 'DENY', dueHoursAgo: 30, dailyTotal: 300 });
  const before = await prisma.rentalAgreement.findUnique({
    where: { id: agreementId }, select: { odometerIn: true, returnedAt: true },
  });

  await assert.rejects(
    () => closeAgreementWithCheckinFees(
      agreementId,
      { odometerIn: 10999, fuelIn: 1, cleanlinessIn: 5, returnedAt: new Date(Date.now() - 20 * HOUR).toISOString() },
      null, null, 'AGENT'
    ),
    /Only an admin/
  );

  const after = await prisma.rentalAgreement.findUnique({
    where: { id: agreementId }, select: { odometerIn: true, returnedAt: true },
  });
  assert.deepEqual(after, before, 'nothing written on a refused close');
});

test('no regression: the paid-in-full close still stores returnedAt', async () => {
  // The path that already worked. On its own this proves nothing about the
  // bug; it is here so the fix, which MOVED the write, cannot silently drop
  // the case it used to cover.
  const { agreementId } = await seedRental({ label: 'ZERO', dueHoursAgo: 0.1, dailyTotal: 0 });
  const returnedAt = new Date(Date.now() - 5 * 60e3);

  const res = await closeAgreementWithCheckinFees(
    agreementId,
    { odometerIn: 10010, fuelIn: 1, cleanlinessIn: 5, returnedAt: returnedAt.toISOString() },
    null, null, 'ADMIN'
  );
  assert.equal(res.newBalance, 0, 'precondition: nothing owed');
  assert.equal(res.agreementStatus, 'CLOSED');

  const row = await prisma.rentalAgreement.findUnique({
    where: { id: agreementId }, select: { returnedAt: true, closedAt: true },
  });
  assert.equal(row.returnedAt.toISOString(), returnedAt.toISOString());
  assert.ok(row.closedAt, 'closedAt still stamped: it remains the operational record');
});

test('default (no payload.returnedAt): the close stamps the moment it ran, balance or not', async () => {
  // The wizard ordinary case. Before the fix this left NULL whenever money was
  // owed, which is how the column ended up empty in production.
  const { agreementId } = await seedRental({ label: 'NOW', dueHoursAgo: 3, dailyTotal: 300 });
  const t0 = Date.now();

  const res = await closeAgreementWithCheckinFees(
    agreementId, { odometerIn: 10030, fuelIn: 1, cleanlinessIn: 5 }, null, null, 'AGENT'
  );
  assert.ok(res.newBalance > 0, 'precondition: balance owed');

  const row = await prisma.rentalAgreement.findUnique({
    where: { id: agreementId }, select: { returnedAt: true },
  });
  assert.ok(row.returnedAt, 'returnedAt stamped without an explicit payload value');
  const drift = row.returnedAt.getTime() - t0;
  assert.ok(drift >= -1000 && drift < 120000, `stamped at close time (drift ${drift}ms)`);
});
