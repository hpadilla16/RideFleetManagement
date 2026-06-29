/**
 * DB-backed tests for reservationPricingService.voidPaymentNoRefund (admin void
 * of an erroneous payment record — bookkeeping only, no gateway/refund).
 * Requires DATABASE_URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationPricingService } from './reservation-pricing.service.js';

const prisma = new PrismaClient();
const TAG = `VP-${Date.now()}`;
const ids = { tenant:null, location:null, vehicleType:null, vehicle:null, customer:null, reservation:null, agreement:null, payCard:null, payHold:null, agPay:null };

test.after(async () => {
  if (ids.reservation) {
    await prisma.reservationPayment.deleteMany({ where:{ reservationId: ids.reservation } }).catch(()=>{});
    await prisma.auditLog.deleteMany({ where:{ reservationId: ids.reservation } }).catch(()=>{});
  }
  if (ids.agreement) {
    await prisma.rentalAgreementPayment.deleteMany({ where:{ rentalAgreementId: ids.agreement } }).catch(()=>{});
    await prisma.rentalAgreementCharge.deleteMany({ where:{ rentalAgreementId: ids.agreement } }).catch(()=>{});
    await prisma.rentalAgreement.delete({ where:{ id: ids.agreement } }).catch(()=>{});
  }
  if (ids.reservation) await prisma.reservation.delete({ where:{ id: ids.reservation } }).catch(()=>{});
  if (ids.vehicle) await prisma.vehicle.delete({ where:{ id: ids.vehicle } }).catch(()=>{});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where:{ id: ids.vehicleType } }).catch(()=>{});
  if (ids.customer) await prisma.customer.delete({ where:{ id: ids.customer } }).catch(()=>{});
  if (ids.location) await prisma.location.delete({ where:{ id: ids.location } }).catch(()=>{});
  if (ids.tenant) await prisma.tenant.delete({ where:{ id: ids.tenant } }).catch(()=>{});
  await prisma.$disconnect();
});

async function seed() {
  const t = await prisma.tenant.create({ data:{ name:`T ${TAG}`, slug:`t-${TAG}`.toLowerCase() } }); ids.tenant=t.id;
  const loc = await prisma.location.create({ data:{ code:`L-${TAG}`.slice(0,12), name:'Loc', tenantId:t.id } }); ids.location=loc.id;
  const vt = await prisma.vehicleType.create({ data:{ tenantId:t.id, code:`VT-${TAG}`.slice(0,10), name:'Compact SUV' } }); ids.vehicleType=vt.id;
  const veh = await prisma.vehicle.create({ data:{ tenant:{connect:{id:t.id}}, internalNumber:`V-${TAG}`.slice(0,18), vehicleType:{connect:{id:vt.id}} } }); ids.vehicle=veh.id;
  const cust = await prisma.customer.create({ data:{ firstName:'Void', lastName:'Pay', phone:'7875550000', email:`c-${TAG}@x.com`, tenantId:t.id } }); ids.customer=cust.id;
  const pickupAt=new Date(Date.now()-5*86400e3), returnAt=new Date(Date.now()-2*86400e3);
  const r = await prisma.reservation.create({ data:{ reservationNumber:`R-${TAG}`, tenantId:t.id, customerId:cust.id, vehicleId:veh.id, pickupLocationId:loc.id, returnLocationId:loc.id, pickupAt, returnAt, status:'CHECKED_OUT', estimatedTotal:9 } }); ids.reservation=r.id;
  const ag = await prisma.rentalAgreement.create({ data:{ agreementNumber:`RA-${TAG}`, reservationId:r.id, tenantId:t.id, vehicleId:veh.id, pickupAt, returnAt, pickupLocationId:loc.id, returnLocationId:loc.id, customerFirstName:'Void', customerLastName:'Pay', status:'FINALIZED', total:9, paidAmount:9, balance:0 } }); ids.agreement=ag.id;
  // one toll charge ($9) selected so syncAgreementCharges sees a $9 total
  await prisma.reservationCharge.create({ data:{ reservationId:r.id, source:'TOLL', name:'Toll', rate:9, total:9, quantity:1, selected:true } });
  // a $9 CARD payment on both ledgers (linked), + a $250 AUTH_HOLD
  const agPay = await prisma.rentalAgreementPayment.create({ data:{ rentalAgreementId:ag.id, method:'CARD', amount:9, status:'PAID' } }); ids.agPay=agPay.id;
  const payCard = await prisma.reservationPayment.create({ data:{ reservationId:r.id, method:'CARD', amount:9, status:'PAID', reference:'****1234', rentalAgreementPaymentId:agPay.id } }); ids.payCard=payCard.id;
  const payHold = await prisma.reservationPayment.create({ data:{ reservationId:r.id, method:'AUTH_HOLD', amount:250, status:'PAID', reference:'HOLD' } }); ids.payHold=payHold.id;
  return { scope:{ tenantId:t.id } };
}

test('voidPaymentNoRefund requires a reason', async () => {
  const { scope } = await seed();
  await assert.rejects(() => reservationPricingService.voidPaymentNoRefund(ids.reservation, ids.payCard, {}, scope), /reason/i);
});

test('refuses AUTH_HOLD (use deposit release)', async () => {
  await assert.rejects(() => reservationPricingService.voidPaymentNoRefund(ids.reservation, ids.payHold, { reason:'x' }, { tenantId: ids.tenant }), /deposit|hold/i);
});

test('voids the payment on BOTH ledgers, no money moved, balance recomputes', async () => {
  const out = await reservationPricingService.voidPaymentNoRefund(ids.reservation, ids.payCard, { reason:'cobro duplicado erroneo' }, { tenantId: ids.tenant });
  assert.equal(out.ok, true);
  const rp = await prisma.reservationPayment.findUnique({ where:{ id: ids.payCard } });
  const ap = await prisma.rentalAgreementPayment.findUnique({ where:{ id: ids.agPay } });
  assert.equal(rp.status, 'VOID', 'reservation payment voided');
  assert.equal(ap.status, 'VOID', 'linked agreement payment voided');
  // balance should rise from 0 to 9 (the $9 no longer counts as collected)
  const ag = await prisma.rentalAgreement.findUnique({ where:{ id: ids.agreement }, select:{ balance:true } });
  assert.ok(Math.abs(Number(ag.balance) - 9) < 0.01, `balance should be 9 after void, got ${ag.balance}`);
  // AUTH_HOLD untouched
  const hold = await prisma.reservationPayment.findUnique({ where:{ id: ids.payHold } });
  assert.equal(hold.status, 'PAID', 'deposit hold not voided');
  // audit written
  const audit = await prisma.auditLog.findFirst({ where:{ reservationId: ids.reservation, action:'ADMIN_OVERRIDE' } });
  assert.ok(audit, 'audit written');
});

test('idempotent — second void is rejected', async () => {
  await assert.rejects(() => reservationPricingService.voidPaymentNoRefund(ids.reservation, ids.payCard, { reason:'again' }, { tenantId: ids.tenant }), /already/i);
});
