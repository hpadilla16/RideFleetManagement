/**
 * DB-backed tests for the delayed post-check-in email sweep (LAX #8,
 * 2026-07-28). Requires DATABASE_URL. Senders are injected spies — no real
 * mail. Covers: receipt-vs-invoice decided by balance at send time,
 * exactly-once stamping, revert-on-failure retry, and the no-agreement guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { runCheckinEmailSweep } from './checkin-email.scheduler.js';

const prisma = new PrismaClient();
const TAG = `CIE-${Date.now()}`;
const NOW = new Date();
const PAST = new Date(NOW.getTime() - 60_000);

const ids = { tenant: null, location: null, vehicleType: null, vehicle: null, customer: null, reservations: [], agreements: [] };

function sendersSpy({ failFirst = false } = {}) {
  const calls = { receipts: [], invoices: [] };
  let failed = false;
  return {
    calls,
    sendReceiptPaidInFull: async (args) => {
      if (failFirst && !failed) { failed = true; throw new Error('mailer down'); }
      calls.receipts.push(args);
    },
    sendInvoiceAfterCheckin: async (args) => { calls.invoices.push(args); },
  };
}

test.after(async () => {
  await prisma.rentalAgreement.deleteMany({ where: { id: { in: ids.agreements } } }).catch(() => {});
  await prisma.reservation.deleteMany({ where: { id: { in: ids.reservations } } }).catch(() => {});
  if (ids.vehicle) await prisma.vehicle.delete({ where: { id: ids.vehicle } }).catch(() => {});
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where: { id: ids.vehicleType } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

async function seedBase() {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } }); ids.tenant = t.id;
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: t.id } }); ids.location = loc.id;
  const vt = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `VT-${TAG}`.slice(0, 10), name: 'SUV' } }); ids.vehicleType = vt.id;
  const veh = await prisma.vehicle.create({ data: {
    tenant: { connect: { id: t.id } }, internalNumber: `V-${TAG}`.slice(0, 18),
    plate: `P${TAG}`.slice(0, 10), status: 'AVAILABLE', vehicleType: { connect: { id: vt.id } },
  } }); ids.vehicle = veh.id;
  const cust = await prisma.customer.create({ data: {
    firstName: 'Delay', lastName: 'Email', phone: '7875550188', email: `c-${TAG}@x.com`, tenantId: t.id,
  } }); ids.customer = cust.id;
}

async function mkPair(num, { balance, due = PAST, sent = null, withAgreement = true } = {}) {
  const pickupAt = new Date(NOW.getTime() - 3 * 86400e3);
  const returnAt = new Date(NOW.getTime() - 3600e3);
  const r = await prisma.reservation.create({ data: {
    reservationNumber: `${num}-${TAG}`, tenantId: ids.tenant, customerId: ids.customer, vehicleId: ids.vehicle,
    pickupLocationId: ids.location, returnLocationId: ids.location, pickupAt, returnAt,
    status: balance > 0 ? 'CHECKED_IN_UNPAID' : 'CHECKED_IN',
    checkinEmailDueAt: due, checkinEmailSentAt: sent,
  } });
  ids.reservations.push(r.id);
  let ag = null;
  if (withAgreement) {
    ag = await prisma.rentalAgreement.create({ data: {
      agreementNumber: `RA-${num}-${TAG}`, reservationId: r.id, tenantId: ids.tenant, vehicleId: ids.vehicle,
      pickupAt, returnAt, pickupLocationId: ids.location, returnLocationId: ids.location,
      customerFirstName: 'Delay', customerLastName: 'Email', status: balance > 0 ? 'FINALIZED' : 'CLOSED',
      subtotal: 100, taxes: 10, total: 110, paidAmount: balance > 0 ? 110 - balance : 110, balance,
    } });
    ids.agreements.push(ag.id);
  }
  return { r, ag };
}

test('setup', async () => { await seedBase(); assert.ok(ids.tenant); });

test('due + zero balance → receipt sent once and stamped', async () => {
  const { r, ag } = await mkPair('R0', { balance: 0 });
  const senders = sendersSpy();
  const out = await runCheckinEmailSweep({ prisma, senders, now: () => NOW });
  assert.ok(out.receipts >= 1);
  assert.ok(senders.calls.receipts.some((c) => c.reservationId === r.id && c.agreementId === ag.id));
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.ok(after.checkinEmailSentAt, 'stamped');
  // Second sweep: nothing more for this row.
  const senders2 = sendersSpy();
  await runCheckinEmailSweep({ prisma, senders: senders2, now: () => NOW });
  assert.equal(senders2.calls.receipts.filter((c) => c.reservationId === r.id).length, 0, 'no double send');
});

test('due + outstanding balance → invoice (balance at SEND time decides)', async () => {
  const { r } = await mkPair('R1', { balance: 45.5 });
  const senders = sendersSpy();
  await runCheckinEmailSweep({ prisma, senders, now: () => NOW });
  assert.ok(senders.calls.invoices.some((c) => c.reservationId === r.id));
  assert.equal(senders.calls.receipts.filter((c) => c.reservationId === r.id).length, 0);
});

test('already stamped (e.g. autocharge receipt) → row not swept', async () => {
  const { r } = await mkPair('R2', { balance: 0, sent: NOW });
  const senders = sendersSpy();
  await runCheckinEmailSweep({ prisma, senders, now: () => NOW });
  assert.equal(senders.calls.receipts.filter((c) => c.reservationId === r.id).length, 0);
});

test('sender failure → stamp reverted so the next sweep retries', async () => {
  const { r } = await mkPair('R3', { balance: 0 });
  const senders = sendersSpy({ failFirst: true });
  const out1 = await runCheckinEmailSweep({ prisma, senders, now: () => NOW });
  assert.ok(out1.failed >= 1);
  const mid = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.equal(mid.checkinEmailSentAt, null, 'stamp reverted after failure');
  const out2 = await runCheckinEmailSweep({ prisma, senders, now: () => NOW });
  assert.ok(out2.receipts >= 1, 'retry succeeded');
  assert.ok(senders.calls.receipts.some((c) => c.reservationId === r.id));
});

test('no agreement → stamped as handled, nothing sent (no infinite loop)', async () => {
  const { r } = await mkPair('R4', { balance: 0, withAgreement: false });
  const senders = sendersSpy();
  const out = await runCheckinEmailSweep({ prisma, senders, now: () => NOW });
  assert.ok(out.skippedNoAgreement >= 1);
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.ok(after.checkinEmailSentAt, 'stamped so it will not loop');
});

test('not yet due → untouched', async () => {
  const future = new Date(NOW.getTime() + 3600e3);
  const { r } = await mkPair('R5', { balance: 0, due: future });
  const senders = sendersSpy();
  await runCheckinEmailSweep({ prisma, senders, now: () => NOW });
  assert.equal(senders.calls.receipts.filter((c) => c.reservationId === r.id).length, 0);
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.equal(after.checkinEmailSentAt, null);
});
