/** A recorded payment on a CLOSED agreement must create the agreement-ledger row and
 *  recompute the balance (regression for: $9 cash on closed reservation didn't move balance). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationPricingService } from './reservation-pricing.service.js';
const prisma = new PrismaClient();
const TAG=`PPC-${Date.now()}`;
const ids={tenant:null,location:null,vehicleType:null,vehicle:null,customer:null,reservation:null,agreement:null};
test.after(async()=>{
  if(ids.agreement){await prisma.rentalAgreementPayment.deleteMany({where:{rentalAgreementId:ids.agreement}}).catch(()=>{});await prisma.rentalAgreementCharge.deleteMany({where:{rentalAgreementId:ids.agreement}}).catch(()=>{});await prisma.rentalAgreement.delete({where:{id:ids.agreement}}).catch(()=>{});}
  if(ids.reservation){await prisma.reservationPayment.deleteMany({where:{reservationId:ids.reservation}}).catch(()=>{});await prisma.reservation.delete({where:{id:ids.reservation}}).catch(()=>{});}
  if(ids.vehicle)await prisma.vehicle.delete({where:{id:ids.vehicle}}).catch(()=>{});
  if(ids.vehicleType)await prisma.vehicleType.delete({where:{id:ids.vehicleType}}).catch(()=>{});
  if(ids.customer)await prisma.customer.delete({where:{id:ids.customer}}).catch(()=>{});
  if(ids.location)await prisma.location.delete({where:{id:ids.location}}).catch(()=>{});
  if(ids.tenant)await prisma.tenant.delete({where:{id:ids.tenant}}).catch(()=>{});
  await prisma.$disconnect();
});
async function seed(status){
  const t=await prisma.tenant.create({data:{name:`T ${TAG}`,slug:`t-${TAG}-${status}`.toLowerCase()}});ids.tenant=t.id;
  const loc=await prisma.location.create({data:{code:`L-${TAG}`.slice(0,12),name:'L',tenantId:t.id}});ids.location=loc.id;
  const vt=await prisma.vehicleType.create({data:{tenantId:t.id,code:`VT-${TAG}`.slice(0,10),name:'SUV'}});ids.vehicleType=vt.id;
  const veh=await prisma.vehicle.create({data:{tenant:{connect:{id:t.id}},internalNumber:`V-${TAG}`.slice(0,18),vehicleType:{connect:{id:vt.id}}}});ids.vehicle=veh.id;
  const c=await prisma.customer.create({data:{firstName:'P',lastName:'C',phone:'7870000000',email:`p-${TAG}@x.com`,tenantId:t.id}});ids.customer=c.id;
  const p=new Date(Date.now()-5*86400e3),r2=new Date(Date.now()-2*86400e3);
  const r=await prisma.reservation.create({data:{reservationNumber:`R-${TAG}`,tenantId:t.id,customerId:c.id,vehicleId:veh.id,pickupLocationId:loc.id,returnLocationId:loc.id,pickupAt:p,returnAt:r2,status:'CHECKED_OUT',estimatedTotal:9}});ids.reservation=r.id;
  const ag=await prisma.rentalAgreement.create({data:{agreementNumber:`RA-${TAG}`,reservationId:r.id,tenantId:t.id,vehicleId:veh.id,pickupAt:p,returnAt:r2,pickupLocationId:loc.id,returnLocationId:loc.id,customerFirstName:'P',customerLastName:'C',status,total:9,paidAmount:0,balance:9}});ids.agreement=ag.id;
  return {tenantId:t.id};
}
test('CLOSED agreement: recorded $9 payment creates agreement-ledger row + balance -> 0', async()=>{
  const scope=await seed('CLOSED');
  await reservationPricingService.postPayment(ids.reservation,{amount:9,method:'CASH',reference:'1234'},scope,null);
  const agPays=await prisma.rentalAgreementPayment.findMany({where:{rentalAgreementId:ids.agreement}});
  assert.equal(agPays.length,1,'agreement payment created on CLOSED');
  const ag=await prisma.rentalAgreement.findUnique({where:{id:ids.agreement},select:{balance:true,paidAmount:true}});
  assert.ok(Math.abs(Number(ag.balance))<0.01,`balance should be 0, got ${ag.balance}`);
  assert.ok(Math.abs(Number(ag.paidAmount)-9)<0.01,`paidAmount should be 9, got ${ag.paidAmount}`);
});
