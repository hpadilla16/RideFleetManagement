import { prisma } from './src/lib/prisma.js';
import { checkoutSessionService as CS } from './src/modules/checkout-session/checkout-session.service.js';
import { checkinCloseService } from './src/modules/rental-agreements/checkin-close.service.js';
let pass=0,fail=0;const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};

const t=await prisma.tenant.create({data:{name:'TR',slug:'tr-'+Date.now(),status:'ACTIVE'}});
const cust=await prisma.customer.create({data:{tenantId:t.id,firstName:'Bob',lastName:'R',email:'b@x.com',phone:'7875550102'}});
const loc=await prisma.location.create({data:{tenantId:t.id,code:'K2',name:'Kennedy2'}});
const vt=await prisma.vehicleType.create({data:{tenantId:t.id,code:'ECON',name:'Economy'}});
const veh=await prisma.vehicle.create({data:{tenantId:t.id,internalNumber:'R1',vehicleTypeId:vt.id,plate:'PR1',programCategory:'RENTAL_ONLY',status:'AVAILABLE',year:2025,make:'Kia',model:'Rio'}});
// PURE RENTAL: no LoanerAgreement, default workflow
const resv=await prisma.reservation.create({data:{tenant:{connect:{id:t.id}},reservationNumber:'RR-'+Date.now(),customer:{connect:{id:cust.id}},status:'CONFIRMED',pickupAt:new Date('2026-06-27T10:00:00Z'),returnAt:new Date('2026-07-01T10:00:00Z'),pickupLocation:{connect:{id:loc.id}},returnLocation:{connect:{id:loc.id}},vehicle:{connect:{id:veh.id}}}});

const laBefore=await prisma.loanerAgreement.count({where:{reservationId:resv.id}});
ok(laBefore===0,'pure rental has zero LoanerAgreements');

const s0=await CS.createForReservation({reservationId:resv.id,tenantId:t.id});
const T_=(toStep)=>CS.transition({id:s0.id,toStep});
await T_('TC_PENDING'); await CS.stampSideEffect({id:s0.id,field:'tcCompletedAt',value:new Date()});
await T_('TC_SIGNED'); await T_('PAYMENT_PENDING'); await CS.stampSideEffect({id:s0.id,field:'paymentCompletedAt',value:new Date()}); await T_('PAID'); await T_('INSPECTION_HANDOFF'); await T_('INSPECTION_IN_PROGRESS');
await CS.stampSideEffect({id:s0.id,field:'inspectionCompletedAt',value:new Date()});
await T_('CUSTOMER_SIGN_PENDING'); await CS.stampSideEffect({id:s0.id,field:'customerSignedAt',value:new Date()});
await T_('FINALIZING'); await T_('CLOSED');

const sess=await prisma.checkoutSession.findUnique({where:{id:s0.id}});
const ag=await prisma.rentalAgreement.findUnique({where:{id:s0.agreementId}});
ok(sess.currentStep==='CLOSED','checkout session reaches CLOSED (no-op updateMany did not break finalize)');
ok(ag.status==='FINALIZED','RentalAgreement FINALIZED');
const resvCO=await prisma.reservation.findUnique({where:{id:resv.id}});
ok(resvCO.status==='CHECKED_OUT','reservation CHECKED_OUT after rental checkout');

await checkinCloseService.closeAgreementWithCheckinFees(s0.agreementId, {}, null, null);
const resvCI=await prisma.reservation.findUnique({where:{id:resv.id}});
ok(resvCI.status==='CHECKED_IN','reservation CHECKED_IN after rental check-in (paid-in-full path unchanged)');
const laAfter=await prisma.loanerAgreement.count({where:{reservationId:resv.id}});
ok(laAfter===0,'still zero LoanerAgreements (updateMany was a true no-op)');

console.log(`\nPure rental: ${pass} passed, ${fail} failed`);
await prisma.$disconnect(); process.exit(fail?1:0);
