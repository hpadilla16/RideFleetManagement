/**
 * RES-849093 DB-backed tests. Requires DATABASE_URL.
 *
 * FIX 2a: voiding a TOLL_MODULE charge voids the underlying tollTransaction so the
 *         toll sync does NOT recreate it (the void sticks).
 * FIX 2b: adding a coversTolls package re-runs the toll sync and removes existing
 *         TOLL_MODULE charges (tolls waived by the package).
 * FIX 3 : a per-rental credit added via addManualCharge is visible in
 *         listAgreementCharges, lowers the balance, is voidable, and voiding
 *         restores the balance (selected:false).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationPricingService } from './reservation-pricing.service.js';
import { tollsService } from '../tolls/tolls.service.js';

const prisma = new PrismaClient();
const TAG = `TVC-${Date.now()}`;
const ids = {};

test.after(async () => {
  for (const rid of [ids.reservation, ids.reservation2].filter(Boolean)) {
    await prisma.tollTransaction.deleteMany({ where: { reservationId: rid } }).catch(()=>{});
    await prisma.reservationCharge.deleteMany({ where: { reservationId: rid } }).catch(()=>{});
    await prisma.reservationPricingSnapshot.deleteMany({ where: { reservationId: rid } }).catch(()=>{});
    await prisma.auditLog.deleteMany({ where: { reservationId: rid } }).catch(()=>{});
  }
  if (ids.agreement2) {
    await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: ids.agreement2 } }).catch(()=>{});
    await prisma.rentalAgreement.delete({ where: { id: ids.agreement2 } }).catch(()=>{});
  }
  if (ids.reservation2) await prisma.reservation.delete({ where: { id: ids.reservation2 } }).catch(()=>{});
  if (ids.agreement) {
    await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: ids.agreement } }).catch(()=>{});
    await prisma.rentalAgreement.delete({ where: { id: ids.agreement } }).catch(()=>{});
  }
  if (ids.service) await prisma.additionalService.delete({ where: { id: ids.service } }).catch(()=>{});
  if (ids.reservation) await prisma.reservation.delete({ where: { id: ids.reservation } }).catch(()=>{});
  if (ids.vehicle) await prisma.vehicle.delete({ where: { id: ids.vehicle } }).catch(()=>{});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where: { id: ids.vehicleType } }).catch(()=>{});
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(()=>{});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(()=>{});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(()=>{});
  await prisma.$disconnect();
});

async function seed() {
  const t = await prisma.tenant.create({ data: { name:`T ${TAG}`, slug:`t-${TAG}`.toLowerCase(), tollsEnabled: true } }); ids.tenant=t.id;
  const loc = await prisma.location.create({ data: { code:`L-${TAG}`.slice(0,12), name:'Loc', tenantId:t.id } }); ids.location=loc.id;
  const vt = await prisma.vehicleType.create({ data: { tenantId:t.id, code:`VT-${TAG}`.slice(0,10), name:'Compact' } }); ids.vehicleType=vt.id;
  const veh = await prisma.vehicle.create({ data: { tenant:{connect:{id:t.id}}, internalNumber:`V-${TAG}`.slice(0,18), plate:'TOLLCAR1', vehicleType:{connect:{id:vt.id}} } }); ids.vehicle=veh.id;
  const cust = await prisma.customer.create({ data: { firstName:'Toll', lastName:'Void', phone:'7875551111', email:`c-${TAG}@x.com`, tenantId:t.id } }); ids.customer=cust.id;
  const pickupAt=new Date(Date.now()-5*86400e3), returnAt=new Date(Date.now()-2*86400e3);
  const r = await prisma.reservation.create({ data: { reservationNumber:`R-${TAG}`, tenantId:t.id, customerId:cust.id, vehicleId:veh.id, pickupLocationId:loc.id, returnLocationId:loc.id, pickupAt, returnAt, status:'CHECKED_OUT', estimatedTotal:0 } }); ids.reservation=r.id;
  const ag = await prisma.rentalAgreement.create({ data: { agreementNumber:`RA-${TAG}`, reservationId:r.id, tenantId:t.id, vehicleId:veh.id, pickupAt, returnAt, pickupLocationId:loc.id, returnLocationId:loc.id, customerFirstName:'Toll', customerLastName:'Void', status:'FINALIZED', total:0, paidAmount:0, balance:0 } }); ids.agreement=ag.id;
  // A coversTolls package (NOT yet selected on the reservation)
  const svc = await prisma.additionalService.create({ data: { tenantId:t.id, code:`TP-${TAG}`.slice(0,10), name:'Toll Pass', rate:30, coversTolls:true, isActive:true } }); ids.service=svc.id;
  return { scope: { tenantId: t.id } };
}

async function makeMatchedToll(amount, externalId) {
  const r = await prisma.reservation.findUnique({ where: { id: ids.reservation }, select: { pickupAt: true } });
  return prisma.tollTransaction.create({ data: {
    tenantId: ids.tenant, reservationId: ids.reservation, vehicleId: ids.vehicle,
    externalId, transactionAt: new Date(r.pickupAt.getTime() + 3600e3),
    amount, plateRaw:'TOLLCAR1', status:'MATCHED', billingStatus:'PENDING'
  } });
}

test('FIX 2a: voiding a TOLL_MODULE charge voids the transaction and the toll does NOT come back', async () => {
  const { scope } = await seed();
  await makeMatchedToll(7.5, `${TAG}-A`);

  // getPricing runs the toll sync → a TOLL_MODULE charge should be created.
  await reservationPricingService.getPricing(ids.reservation, scope, { allowClosed: true });
  let charges = (await reservationPricingService.listAgreementCharges(ids.reservation, scope)).charges;
  const tollCharge = charges.find((c) => c.source === 'TOLL_MODULE');
  assert.ok(tollCharge, 'a TOLL_MODULE charge should exist after sync');

  // Void it via the corrections path.
  await reservationPricingService.voidAgreementCharge(ids.reservation, tollCharge.id, { reason: 'wrong car' }, scope);

  // The underlying transaction must be VOID.
  const tx = await prisma.tollTransaction.findFirst({ where: { externalId: `${TAG}-A` } });
  assert.equal(tx.status, 'VOID', 'tollTransaction should be VOID after the charge void');
  assert.equal(tx.billingStatus, 'WAIVED', 'tollTransaction billingStatus should be WAIVED');

  // Re-run sync (simulating any later pricing call) — the toll must NOT reappear.
  await reservationPricingService.getPricing(ids.reservation, scope, { allowClosed: true });
  charges = (await reservationPricingService.listAgreementCharges(ids.reservation, scope)).charges;
  const stillThere = charges.find((c) => c.source === 'TOLL_MODULE' && c.id === tollCharge.id);
  assert.ok(!stillThere, 'voided toll charge must not be rebuilt');
  const anyActiveToll = charges.find((c) => c.source === 'TOLL_MODULE');
  assert.ok(!anyActiveToll, 'no active TOLL_MODULE charge should remain after the void sticks');
});

test('FIX 2b: adding a coversTolls package waives existing toll charges', async () => {
  const scope = { tenantId: ids.tenant };
  // Fresh chargeable toll.
  await makeMatchedToll(9.25, `${TAG}-B`);
  await reservationPricingService.getPricing(ids.reservation, scope, { allowClosed: true });
  let charges = (await reservationPricingService.listAgreementCharges(ids.reservation, scope)).charges;
  assert.ok(charges.find((c) => c.source === 'TOLL_MODULE'), 'a chargeable toll exists before the package');

  // Add the coversTolls package as a SELECTED ADDITIONAL_SERVICE charge, then re-sync.
  await prisma.reservationCharge.create({ data: {
    reservationId: ids.reservation, source:'ADDITIONAL_SERVICE', sourceRefId: ids.service,
    code:'SERVICE', name:'Toll Pass', rate:30, total:30, quantity:1, selected:true
  } });
  await tollsService.syncReservationCharges(ids.reservation, scope);

  charges = (await reservationPricingService.listAgreementCharges(ids.reservation, scope)).charges;
  const remainingToll = charges.find((c) => c.source === 'TOLL_MODULE');
  assert.ok(!remainingToll, 'TOLL_MODULE charges must be removed once a coversTolls package is selected');
});

test('FIX 3: credit via addManualCharge is visible, lowers balance, and is voidable (round-trip)', async () => {
  // Own isolated reservation/agreement so the shared toll-package state from the
  // earlier tests cannot perturb the balance delta we assert on.
  const scope = { tenantId: ids.tenant };
  const pickupAt = new Date(Date.now() - 5 * 86400e3), returnAt = new Date(Date.now() - 2 * 86400e3);
  const r2 = await prisma.reservation.create({ data: { reservationNumber:`R2-${TAG}`, tenantId:ids.tenant, customerId:ids.customer, vehicleId:ids.vehicle, pickupLocationId:ids.location, returnLocationId:ids.location, pickupAt, returnAt, status:'CHECKED_OUT', estimatedTotal:0 } });
  ids.reservation2 = r2.id;
  const ag2 = await prisma.rentalAgreement.create({ data: { agreementNumber:`RA2-${TAG}`, reservationId:r2.id, tenantId:ids.tenant, vehicleId:ids.vehicle, pickupAt, returnAt, pickupLocationId:ids.location, returnLocationId:ids.location, customerFirstName:'Cred', customerLastName:'Test', status:'FINALIZED', total:0, paidAmount:0, balance:0 } });
  ids.agreement2 = ag2.id;
  // A positive base charge so the credit visibly lowers a non-zero balance
  // (balance is floored at 0, so a credit on a $0 agreement would be invisible).
  await prisma.reservationCharge.create({ data: { reservationId:r2.id, source:'DAILY', code:'DAILY', name:'Base rental', rate:100, total:100, quantity:1, selected:true } });
  // Sync so the agreement total/balance reflects the base charge.
  await reservationPricingService.getPricing(r2.id, scope, { allowClosed: true });

  const before = Number((await reservationPricingService.listAgreementCharges(r2.id, scope)).balance);
  assert.ok(before >= 99.99, `base balance should be ~100 before the credit, got ${before}`);

  await reservationPricingService.addManualCharge(r2.id, { name:'Goodwill credit', amount:-25 }, { reason:'service recovery' }, scope);
  let listed = await reservationPricingService.listAgreementCharges(r2.id, scope);
  const credit = listed.charges.find((c) => c.source === 'ADMIN_CORRECTION' && Number(c.total) === -25);
  assert.ok(credit, 'credit must appear in listAgreementCharges');
  assert.ok(Math.abs(Number(listed.balance) - (before - 25)) < 0.01, `balance should drop by 25 (before=${before}, after=${listed.balance})`);

  // Void the credit → balance restored, row selected:false.
  await reservationPricingService.voidAgreementCharge(r2.id, credit.id, { reason:'reverse credit' }, scope);
  listed = await reservationPricingService.listAgreementCharges(r2.id, scope);
  const stillSelected = listed.charges.find((c) => c.id === credit.id);
  assert.ok(!stillSelected, 'voided credit must no longer be in the selected charges list');
  const row = await prisma.rentalAgreementCharge.findUnique({ where: { id: credit.id }, select: { selected: true } });
  assert.equal(row.selected, false, 'voided credit row should be selected:false (kept for history)');
  assert.ok(Math.abs(Number(listed.balance) - before) < 0.01, `balance should be restored to ${before}, got ${listed.balance}`);
});
