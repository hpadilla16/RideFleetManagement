import { prisma } from './src/lib/prisma.js';
import { checkoutSessionService as CS } from './src/modules/checkout-session/checkout-session.service.js';
let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++;console.log('  PASS',m);} else {fail++;console.log('  FAIL',m);} };

const t=await prisma.tenant.create({data:{name:'T',slug:'t-'+Date.now(),status:'ACTIVE'}});
const cust=await prisma.customer.create({data:{tenantId:t.id,firstName:'Ana',lastName:'Diaz',phone:'7875550101',email:'ana@x.com'}});
const loc=await prisma.location.create({data:{tenantId:t.id,code:'KEN',name:'Kennedy'}});
const vt=await prisma.vehicleType.create({data:{tenantId:t.id,code:'SSUV',name:'Standard SUV'}});
const veh=await prisma.vehicle.create({data:{tenantId:t.id,internalNumber:'L1',vehicleTypeId:vt.id,plate:'ABC1',programCategory:'BOTH',status:'AVAILABLE',year:2025,make:'Hyundai',model:'Tucson'}});
const resv=await prisma.reservation.create({data:{
  tenant:{connect:{id:t.id}}, reservationNumber:'R-'+Date.now(), customer:{connect:{id:cust.id}},
  status:'CONFIRMED', workflowMode:'DEALERSHIP_LOANER', loanerBillingMode:'COURTESY',
  pickupAt:new Date('2026-06-27T10:00:00Z'), returnAt:new Date('2026-07-01T10:00:00Z'),
  pickupLocation:{connect:{id:loc.id}}, returnLocation:{connect:{id:loc.id}}, vehicle:{connect:{id:veh.id}} }});

// 1) start the unified checkout-session for a loaner
const s0=await CS.createForReservation({reservationId:resv.id, tenantId:t.id, actorUserId:null});
ok(s0 && s0.currentStep==='CONFIRMING','checkout-session created at CONFIRMING');
ok(!!s0.agreementId,'companion agreement bound to the session');
ok(!!s0.paymentCompletedAt,'payment pre-stamped (loaner bypass)');
const ag=await prisma.rentalAgreement.findUnique({where:{id:s0.agreementId}});
ok(ag && Number(ag.total||0)===0 && Number(ag.balance||0)===0,`companion agreement is $0 (total ${ag&&ag.total})`);

// 2) drive the SAME state machine to CLOSED (stamp the wizard side-effects)
const T=async(toStep)=>CS.transition({id:s0.id, toStep, actorUserId:null});
await T('TC_PENDING');
await CS.stampSideEffect({id:s0.id, field:'tcCompletedAt', value:new Date()});
await T('TC_SIGNED'); await T('PAYMENT_PENDING'); await T('PAID');  // PAID passes via pre-stamped paymentCompletedAt
ok(true,'reached PAID without an online payment (loaner bypass works)');
await T('INSPECTION_HANDOFF'); await T('INSPECTION_IN_PROGRESS');
await CS.stampSideEffect({id:s0.id, field:'inspectionCompletedAt', value:new Date()});
await T('CUSTOMER_SIGN_PENDING');
await CS.stampSideEffect({id:s0.id, field:'customerSignedAt', value:new Date()});
await T('FINALIZING');
const closed=await T('CLOSED');
ok(closed.currentStep==='CLOSED','session reached CLOSED');

// 3) finalize cascade applied to the loaner
const resvAfter=await prisma.reservation.findUnique({where:{id:resv.id}});
const agAfter=await prisma.rentalAgreement.findUnique({where:{id:s0.agreementId}});
ok(resvAfter.status==='CHECKED_OUT','reservation -> CHECKED_OUT via unified finalize');
ok(agAfter.status==='FINALIZED','companion agreement -> FINALIZED');
const vehAfter=await prisma.vehicle.findUnique({where:{id:veh.id}});
ok(vehAfter.status && vehAfter.status!=='AVAILABLE',`vehicle status synced out (${vehAfter.status})`);

console.log(`\nP2 unified-checkout integration: ${pass} passed, ${fail} failed`);
await prisma.$disconnect(); process.exit(fail?1:0);
