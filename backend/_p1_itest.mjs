import { prisma } from './src/lib/prisma.js';
import { loanerAgreementService as LA } from './src/modules/dealership-loaner/loaner-agreement.service.js';
import { dealershipLoanerService as DL } from './src/modules/dealership-loaner/dealership-loaner.service.js';
let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++;console.log('  PASS',m);} else {fail++;console.log('  FAIL',m);} };

const t=await prisma.tenant.create({data:{name:'T',slug:'t-'+Date.now(),status:'ACTIVE'}});
const cust=await prisma.customer.create({data:{tenantId:t.id,firstName:'Ana',lastName:'Diaz',phone:'7875550101'}});
const loc=await prisma.location.create({data:{tenantId:t.id,code:'KEN',name:'Kennedy'}});
const resv=await prisma.reservation.create({data:{
  tenant:{connect:{id:t.id}}, reservationNumber:'R-'+Date.now(), customer:{connect:{id:cust.id}},
  status:'CHECKED_OUT', workflowMode:'DEALERSHIP_LOANER', repairOrderNumber:'RO-REQ',
  serviceAdvisorName:'Bob', serviceAdvisorPhone:'7875559000', serviceAdvisorEmail:'bob@dealer.test',
  pickupAt:new Date('2026-06-27T10:00:00Z'), returnAt:new Date('2026-07-01T10:00:00Z'),
  pickupLocation:{connect:{id:loc.id}}, returnLocation:{connect:{id:loc.id}} }});
const agr=await prisma.loanerAgreement.create({data:{
  tenantId:t.id, agreementNumber:'LA-'+Date.now(), status:'ACTIVE',
  reservationId:resv.id, pickupAt:resv.pickupAt, returnAt:resv.returnAt,
  customerFirstName:'Ana', customerLastName:'Diaz', customerPhone:'7875550101',
  portalToken:'tok_'+Date.now() }});

// 1) borrower requests an extension (notify is best-effort; no creds -> silent)
const newDate='2026-07-04T10:00:00Z';
const r=await LA.requestExtensionByToken(agr.portalToken,{requestedReturnAt:newDate, note:'need 3 more days'});
ok(r.ok,'requestExtensionByToken ok');
const a1=await prisma.loanerAgreement.findUnique({where:{id:agr.id}});
ok(a1.portalRequestAt && a1.portalRequestKind==='EXTENSION' && a1.portalRequestHandledAt===null,'request stamped EXTENSION + unhandled');

// 2) appears in the Customer Requests queue (super-admin sees all)
let q=await DL.listCustomerRequests({role:'SUPER_ADMIN',tenantId:null});
ok(q.requests.length===1 && q.requests[0].kind==='EXTENSION' && q.requests[0].repairOrderNumber==='RO-REQ','queue shows the pending extension');
ok(q.requests[0].note==='need 3 more days','queue carries the note');

// 3) tenant scoping: a different tenant admin sees nothing
let q2=await DL.listCustomerRequests({role:'ADMIN',tenantId:'other'});
ok(q2.requests.length===0,'cross-tenant admin sees no requests');

// 4) resolve with apply -> reservation.returnAt updated, queue clears
const res=await DL.resolveCustomerRequest({role:'SUPER_ADMIN',tenantId:null}, agr.id, {apply:true});
ok(res.ok && res.applied,'resolve applied');
const resv2=await prisma.reservation.findUnique({where:{id:resv.id}});
ok(new Date(resv2.returnAt).toISOString()===new Date(newDate).toISOString(),'reservation.returnAt pushed to requested date');
let q3=await DL.listCustomerRequests({role:'SUPER_ADMIN',tenantId:null});
ok(q3.requests.length===0,'queue clears after resolve');

// 5) scheduleReturn also stamps RETURN + re-queues
await LA.scheduleReturnByToken(agr.portalToken,{returnScheduledAt:'2026-07-02T16:00:00Z'});
let q4=await DL.listCustomerRequests({role:'SUPER_ADMIN',tenantId:null});
ok(q4.requests.length===1 && q4.requests[0].kind==='RETURN','scheduleReturn re-queues as RETURN');

console.log(`\nP1 integration: ${pass} passed, ${fail} failed`);
await prisma.$disconnect(); process.exit(fail?1:0);
