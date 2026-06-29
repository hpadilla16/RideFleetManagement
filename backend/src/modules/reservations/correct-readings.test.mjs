/**
 * DB-backed tests for reservationPricingService.correctInspectionValues (admin
 * fuel/odometer correction → re-run fee engine + soft-void prior fees + audit).
 * Requires DATABASE_URL. Seeds its own tenant/vehicle/customer/location/reservation/agreement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationPricingService } from './reservation-pricing.service.js';

const prisma = new PrismaClient();
const TAG = `CR-${Date.now()}`;
const ids = { tenant:null, location:null, vehicleType:null, vehicle:null, customer:null, reservation:null, agreement:null };

test.after(async () => {
  if (ids.agreement) await prisma.rentalAgreementCharge.deleteMany({ where:{ rentalAgreementId: ids.agreement } }).catch(()=>{});
  if (ids.agreement) await prisma.rentalAgreement.delete({ where:{ id: ids.agreement } }).catch(()=>{});
  if (ids.reservation) await prisma.auditLog.deleteMany({ where:{ reservationId: ids.reservation } }).catch(()=>{});
  if (ids.reservation) await prisma.reservation.delete({ where:{ id: ids.reservation } }).catch(()=>{});
  if (ids.vehicle) { await prisma.vehicleMileageEntry.deleteMany({ where:{ vehicleId: ids.vehicle } }).catch(()=>{}); await prisma.vehicleFuelReading.deleteMany({ where:{ vehicleId: ids.vehicle } }).catch(()=>{}); await prisma.vehicle.delete({ where:{ id: ids.vehicle } }).catch(()=>{}); }
  if (ids.customer) await prisma.customer.delete({ where:{ id: ids.customer } }).catch(()=>{});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where:{ id: ids.vehicleType } }).catch(()=>{});
  if (ids.location) await prisma.location.delete({ where:{ id: ids.location } }).catch(()=>{});
  if (ids.tenant) await prisma.tenant.delete({ where:{ id: ids.tenant } }).catch(()=>{});
  await prisma.$disconnect();
});

async function seed({ status='CHECKED_IN' } = {}) {
  const t = await prisma.tenant.create({ data:{ name:`T ${TAG}`, slug:`t-${TAG}`.toLowerCase() } }); ids.tenant=t.id;
  const loc = await prisma.location.create({ data:{ code:`L-${TAG}`.slice(0,12), name:'Loc', tenantId:t.id } }); ids.location=loc.id;
  const vt = await prisma.vehicleType.create({ data:{ tenantId:t.id, code:`VT-${TAG}`.slice(0,10), name:'Compact SUV' } }); ids.vehicleType=vt.id;
  const veh = await prisma.vehicle.create({ data:{ tenant:{ connect:{ id: t.id } }, internalNumber:`V-${TAG}`.slice(0,18), fuelTankCapacityGallons:14, vehicleType:{ connect:{ id: vt.id } } } }); ids.vehicle=veh.id;
  const cust = await prisma.customer.create({ data:{ firstName:'Cor', lastName:'Rect', phone:'7875550000', email:`c-${TAG}@x.com`, tenantId:t.id } }); ids.customer=cust.id;
  const pickupAt = new Date(Date.now()-5*86400e3), returnAt = new Date(Date.now()-2*86400e3);
  const r = await prisma.reservation.create({ data:{ reservationNumber:`R-${TAG}`, tenantId:t.id, customerId:cust.id, vehicleId:veh.id, pickupLocationId:loc.id, returnLocationId:loc.id, pickupAt, returnAt, status } }); ids.reservation=r.id;
  const ag = await prisma.rentalAgreement.create({ data:{
    agreementNumber:`RA-${TAG}`, reservationId:r.id, tenantId:t.id, vehicleId:veh.id,
    pickupAt, returnAt, pickupLocationId:loc.id, returnLocationId:loc.id,
    customerFirstName:'Cor', customerLastName:'Rect', status: status==='CANCELLED'?'CANCELLED':'CLOSED',
    fuelOut:1.0, fuelIn:0.25, odometerOut:41000, odometerIn:41200,
    total:398.90, paidAmount:0, balance:398.90
  }}); ids.agreement=ag.id;
  // pre-existing (wrong) fuel refill fee row + UNRELATED smoking & late fees that MUST survive a fuel correction
  await prisma.rentalAgreementCharge.create({ data:{ rentalAgreementId:ag.id, source:'FEE_ENGINE_CHECKIN', sourceRefId:'FUEL_REFILL', name:'Fuel refill', rate:7, total:98.90, quantity:1, selected:true } });
  await prisma.rentalAgreementCharge.create({ data:{ rentalAgreementId:ag.id, source:'FEE_ENGINE_CHECKIN', sourceRefId:'SMOKING', name:'Smoking fee', rate:250, total:250, quantity:1, selected:true } });
  await prisma.rentalAgreementCharge.create({ data:{ rentalAgreementId:ag.id, source:'FEE_ENGINE_CHECKIN', sourceRefId:'LATE_RETURN', name:'Late return', rate:25, total:50, quantity:2, selected:true } });
  return { scope:{ tenantId:t.id } };
}

test('reason required when not dryRun', async () => {
  const { scope } = await seed();
  await assert.rejects(() => reservationPricingService.correctInspectionValues(ids.reservation, { fuelOut:0.25 }, scope), /reason is required/i);
});

test('dryRun returns preview shape and writes nothing', async () => {
  const before = await prisma.rentalAgreementCharge.findMany({ where:{ rentalAgreementId: ids.agreement, selected:true } });
  const out = await reservationPricingService.correctInspectionValues(ids.reservation, { fuelOut:0.25, dryRun:true }, { tenantId: ids.tenant });
  assert.equal(out.ok, true);
  assert.ok(out.preview && out.preview.before && out.preview.after);
  assert.equal(typeof out.preview.balanceDelta, 'number');
  const after = await prisma.rentalAgreementCharge.findMany({ where:{ rentalAgreementId: ids.agreement, selected:true } });
  assert.equal(after.length, before.length, 'dryRun must not change charges');
});

test('real correction soft-voids prior FEE_ENGINE rows + writes ADMIN_OVERRIDE audit', async () => {
  const out = await reservationPricingService.correctInspectionValues(ids.reservation, { fuelOut:0.25, reason:'checkout fuel was actually 1/4', actorUserId:null }, { tenantId: ids.tenant });
  assert.equal(out.ok, true);
  // After correcting checkout fuel to equal check-in (no fuel used), there must be
  // NO live (selected) fuel-refill fee left — the stale $98.90 is gone from the balance.
  const liveFuelRows = await prisma.rentalAgreementCharge.findMany({ where:{ rentalAgreementId: ids.agreement, source:'FEE_ENGINE_CHECKIN', sourceRefId:'FUEL_REFILL', selected:true } });
  const liveFuelTotal = liveFuelRows.reduce((s,r)=>s+Number(r.total||0),0);
  assert.equal(liveFuelTotal, 0, 'no live fuel refill total after correcting to equal levels');
  // preview reflects the drop from 98.90 -> 0
  assert.equal(out.preview.before.fuelRefill, 98.90);
  assert.equal(out.preview.after.fuelRefill, 0);
  // FINANCIAL SAFETY: unrelated smoking + late fees must survive a fuel correction.
  const smoking = await prisma.rentalAgreementCharge.findFirst({ where:{ rentalAgreementId: ids.agreement, sourceRefId:'SMOKING' } });
  const late = await prisma.rentalAgreementCharge.findFirst({ where:{ rentalAgreementId: ids.agreement, sourceRefId:'LATE_RETURN' } });
  assert.equal(smoking?.selected, true, 'smoking fee preserved');
  assert.equal(late?.selected, true, 'late fee preserved');
  // B1: persisted agreement balance must drop by the removed fuel ($98.90), leaving smoking+late ($300).
  const ag = await prisma.rentalAgreement.findUnique({ where:{ id: ids.agreement }, select:{ balance:true } });
  assert.ok(Math.abs(Number(ag.balance) - 300) < 0.01, `balance should be 300 (smoking+late), got ${ag.balance}`);
  const audit = await prisma.auditLog.findFirst({ where:{ reservationId: ids.reservation, action:'ADMIN_OVERRIDE' } });
  assert.ok(audit, 'ADMIN_OVERRIDE audit written');
});

test('refuses a cancelled agreement', async () => {
  // mutate to cancelled and assert refusal
  await prisma.rentalAgreement.update({ where:{ id: ids.agreement }, data:{ status:'CANCELLED' } });
  await assert.rejects(() => reservationPricingService.correctInspectionValues(ids.reservation, { fuelOut:0.5, reason:'x' }, { tenantId: ids.tenant }), /cancel/i);
});
