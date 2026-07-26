/**
 * DB-backed regression for the toll→agreement mirror (2026-07-26). MONEY.
 * Requires DATABASE_URL.
 *
 * THE BUG (found by the TollBridge team reading this module, verified by
 * us): syncReservationTollCharges wrote the TOLL_MODULE ReservationCharge
 * and stopped — it never mirrored into the RentalAgreement, whose `balance`
 * is what the counter reads. Tolls almost always post AFTER the rental
 * closed (SunPass 2+ weeks late, CA statements up to a month), so the
 * charge existed on the reservation, the counter never saw it, and nobody
 * collected it. Silent loss with TODAY's providers.
 *
 * CARES PROVEN:
 *  1. A MATCHED toll on a reservation whose agreement is CLOSED lands in
 *     the agreement's charge rows and its balance after the sync — the fix.
 *  2. skipAgreementMirror leaves the agreement untouched (getPricing's
 *     concurrent call site must not race a second rebuild).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { tollsService } from './tolls.service.js';

const prisma = new PrismaClient();
const TAG = `TOLLMIR-${Date.now()}`;
const ids = { tenant: null, loc: null, customer: null, res: null, agr: null, res2: null, agr2: null };

test.after(async () => {
  await prisma.tollTransaction.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreement: { tenantId: ids.tenant } } }).catch(() => {});
  await prisma.rentalAgreement.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.reservationCharge.deleteMany({ where: { reservation: { tenantId: ids.tenant } } }).catch(() => {});
  await prisma.reservation.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.loc) await prisma.location.delete({ where: { id: ids.loc } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

async function makeClosedRental(suffix) {
  const customer = ids.customer;
  const res = await prisma.reservation.create({
    data: {
      tenantId: ids.tenant,
      reservationNumber: `R-${TAG}-${suffix}`,
      customerId: customer,
      pickupLocationId: ids.loc,
      returnLocationId: ids.loc,
      pickupAt: new Date('2026-07-01T10:00:00Z'),
      returnAt: new Date('2026-07-03T10:00:00Z'),
      status: 'CHECKED_IN'
    }
  });
  const agr = await prisma.rentalAgreement.create({
    data: {
      tenantId: ids.tenant,
      agreementNumber: `AGR-${TAG}-${suffix}`,
      reservationId: res.id,
      pickupAt: res.pickupAt,
      returnAt: res.returnAt,
      pickupLocationId: ids.loc,
      returnLocationId: ids.loc,
      customerFirstName: 'Toll',
      customerLastName: 'Mirror',
      status: 'CLOSED',
      total: 0,
      balance: 0
    }
  });
  return { res, agr };
}

test('setup: tolls-enabled tenant, one CLOSED rental, one MATCHED toll that posted after close', async () => {
  const tenant = await prisma.tenant.create({
    data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase(), tollsEnabled: true }
  });
  ids.tenant = tenant.id;
  const loc = await prisma.location.create({
    data: { tenantId: tenant.id, code: `L-${TAG}`.slice(0, 12), name: 'Toll Branch' }
  });
  ids.loc = loc.id;
  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, firstName: 'Toll', lastName: 'Mirror', email: `toll-${TAG}@x.test`.toLowerCase(), phone: '5550002222' }
  });
  ids.customer = customer.id;
  const one = await makeClosedRental('A');
  ids.res = one.res.id; ids.agr = one.agr.id;
  const two = await makeClosedRental('B');
  ids.res2 = two.res.id; ids.agr2 = two.agr.id;

  for (const [resId, ext] of [[ids.res, 'A'], [ids.res2, 'B']]) {
    await prisma.tollTransaction.create({
      data: {
        tenantId: tenant.id,
        externalId: `EXT-${TAG}-${ext}`,
        transactionAt: new Date('2026-07-02T16:14:00Z'),
        amount: 3.25,
        location: 'SR-73 Test Plaza',
        plateRaw: `TM${TAG.slice(-5)}`,
        plateNormalized: `TM${TAG.slice(-5)}`,
        reservationId: resId,
        status: 'MATCHED',
        billingStatus: 'PENDING'
      }
    });
  }
  assert.ok(ids.agr && ids.agr2);
});

test('THE FIX: a post-close toll reaches the CLOSED agreement charges and balance', async () => {
  const out = await tollsService.syncReservationCharges(ids.res, { tenantId: ids.tenant });
  assert.equal(out.tollsEnabled, true);
  assert.ok(out.syncedChargeCount >= 1);

  const resCharge = await prisma.reservationCharge.findFirst({
    where: { reservationId: ids.res, source: 'TOLL_MODULE' }
  });
  assert.ok(resCharge, 'TOLL_MODULE ReservationCharge written');

  const agrCharges = await prisma.rentalAgreementCharge.findMany({
    where: { rentalAgreementId: ids.agr, selected: true }
  });
  const tollRow = agrCharges.find((c) => Number(c.total) === Number(resCharge.total));
  assert.ok(tollRow, 'the toll charge is MIRRORED into the CLOSED agreement (the bug: it never was)');

  const agr = await prisma.rentalAgreement.findUnique({ where: { id: ids.agr }, select: { balance: true, total: true } });
  assert.ok(Number(agr.balance) > 0, `agreement balance includes the toll (got ${agr.balance}) — this is what the counter reads`);
});

test('skipAgreementMirror leaves the agreement untouched (getPricing race guard)', async () => {
  await tollsService.syncReservationCharges(ids.res2, { tenantId: ids.tenant }, { skipAgreementMirror: true });
  const resCharge = await prisma.reservationCharge.findFirst({
    where: { reservationId: ids.res2, source: 'TOLL_MODULE' }
  });
  assert.ok(resCharge, 'ReservationCharge still written');
  const agrCharges = await prisma.rentalAgreementCharge.count({ where: { rentalAgreementId: ids.agr2 } });
  assert.equal(agrCharges, 0, 'no agreement rebuild from the skip path');
});
