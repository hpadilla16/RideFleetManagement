import { prisma } from './src/lib/prisma.js';
import { checkoutSessionService as CS } from './src/modules/checkout-session/checkout-session.service.js';
import { checkinCloseService } from './src/modules/rental-agreements/checkin-close.service.js';
import { loanerAgreementService as LA } from './src/modules/dealership-loaner/loaner-agreement.service.js';
let pass=0,fail=0;const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};

const t=await prisma.tenant.create({data:{name:'T',slug:'t-'+Date.now(),status:'ACTIVE'}});
const cust=await prisma.customer.create({data:{tenantId:t.id,firstName:'Ana',lastName:'D',email:'a@x.com',phone:'7875550101'}});
const loc=await prisma.location.create({data:{tenantId:t.id,code:'K',name:'Kennedy'}});
const vt=await prisma.vehicleType.create({data:{tenantId:t.id,code:'SSUV',name:'Standard SUV'}});
const veh=await prisma.vehicle.create({data:{tenantId:t.id,internalNumber:'L1',vehicleTypeId:vt.id,plate:'P1',programCategory:'BOTH',status:'AVAILABLE',year:2025,make:'Hyundai',model:'Tucson'}});
const resv=await prisma.reservation.create({data:{tenant:{connect:{id:t.id}},reservationNumber:'R-'+Date.now(),customer:{connect:{id:cust.id}},status:'CONFIRMED',workflowMode:'DEALERSHIP_LOANER',loanerBillingMode:'COURTESY',pickupAt:new Date('2026-06-27T10:00:00Z'),returnAt:new Date('2026-07-01T10:00:00Z'),pickupLocation:{connect:{id:loc.id}},returnLocation:{connect:{id:loc.id}},vehicle:{connect:{id:veh.id}}}});
const la=await prisma.loanerAgreement.create({data:{tenantId:t.id,agreementNumber:'LA-'+Date.now(),status:'DRAFT',reservationId:resv.id,vehicleId:veh.id,pickupAt:resv.pickupAt,returnAt:resv.returnAt,customerFirstName:'Ana',customerLastName:'D',customerEmail:'a@x.com',portalToken:'tok_'+Date.now(),signatureDataUrl:'data:image/png;base64,iVBOR',signedAt:new Date()}});

ok(la.status==='DRAFT','self-service LoanerAgreement starts DRAFT');

// checkout to CLOSED
const s0=await CS.createForReservation({reservationId:resv.id,tenantId:t.id});
const T_=(toStep)=>CS.transition({id:s0.id,toStep});
await T_('TC_PENDING'); await CS.stampSideEffect({id:s0.id,field:'tcCompletedAt',value:new Date()});
await T_('TC_SIGNED'); await T_('PAYMENT_PENDING'); await T_('PAID'); await T_('INSPECTION_HANDOFF'); await T_('INSPECTION_IN_PROGRESS');
await CS.stampSideEffect({id:s0.id,field:'inspectionCompletedAt',value:new Date()});
await T_('CUSTOMER_SIGN_PENDING'); await CS.stampSideEffect({id:s0.id,field:'customerSignedAt',value:new Date()});
await T_('FINALIZING'); await T_('CLOSED');
let laNow=await prisma.loanerAgreement.findUnique({where:{id:la.id}});
ok(laNow.status==='ACTIVE','LoanerAgreement -> ACTIVE after unified checkout (was stuck DRAFT before fix)');

// check-in (close $0 companion)
await checkinCloseService.closeAgreementWithCheckinFees(s0.agreementId, {}, null, null);
const resvAfter=await prisma.reservation.findUnique({where:{id:resv.id}});
laNow=await prisma.loanerAgreement.findUnique({where:{id:la.id}});
ok(resvAfter.status==='CHECKED_IN','reservation -> CHECKED_IN');
ok(laNow.status==='CLOSED','LoanerAgreement -> CLOSED after check-in');

// post-return portal request rejected
let code=null; try{ await LA.requestExtensionByToken(la.portalToken,{requestedReturnAt:'2026-07-05T10:00:00Z'}); }catch(e){ code=e.statusCode; }
ok(code===404,`post-return extension request rejected (404), got ${code}`);

console.log(`\nC1 lifecycle: ${pass} passed, ${fail} failed`);
await prisma.$disconnect(); process.exit(fail?1:0);
