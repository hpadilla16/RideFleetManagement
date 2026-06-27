import { prisma } from './src/lib/prisma.js';
import { loanerAgreementService as LA } from './src/modules/dealership-loaner/loaner-agreement.service.js';
import { dealershipLoanerService as DL } from './src/modules/dealership-loaner/dealership-loaner.service.js';
let pass=0,fail=0;const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};

const t=await prisma.tenant.create({data:{name:'TH',slug:'th-'+Date.now(),status:'ACTIVE'}});
const veh=await prisma.vehicle.create({data:{tenantId:t.id,internalNumber:'H1',vehicleTypeId:(await prisma.vehicleType.create({data:{tenantId:t.id,code:'X',name:'X'}})).id,plate:'PH1',status:'AVAILABLE',year:2025,make:'Kia',model:'Rio'}});
const cust=await prisma.customer.create({data:{tenantId:t.id,firstName:'C',lastName:'H',email:'c@x.com',phone:'7875559999'}});
const loc=await prisma.location.create({data:{tenantId:t.id,code:'LH',name:'LocH'}});

async function mk(resvStatus, laStatus, extra={}){
  const resv=await prisma.reservation.create({data:{tenant:{connect:{id:t.id}},reservationNumber:'RH-'+Math.random().toString(36).slice(2),customer:{connect:{id:cust.id}},status:resvStatus,workflowMode:'DEALERSHIP_LOANER',pickupAt:new Date(),returnAt:new Date(Date.now()+86400000),vehicle:{connect:{id:veh.id}},pickupLocation:{connect:{id:loc.id}},returnLocation:{connect:{id:loc.id}}}});
  const la=await prisma.loanerAgreement.create({data:{tenantId:t.id,agreementNumber:'LH-'+Math.random().toString(36).slice(2),status:laStatus,reservationId:resv.id,vehicleId:veh.id,pickupAt:resv.pickupAt,returnAt:resv.returnAt,customerFirstName:'C',customerLastName:'H',customerEmail:'c@x.com',portalToken:'tk_'+Math.random().toString(36).slice(2),...extra}});
  return {resv,la};
}

// H1: terminal reservation statuses rejected on portal ACTION
for (const st of ['CHECKED_IN','CHECKED_IN_UNPAID','CANCELLED','NO_SHOW']){
  const {la}=await mk(st,'ACTIVE');
  let code=null; try{ await LA.requestExtensionByToken(la.portalToken,{requestedReturnAt:new Date(Date.now()+2*86400000).toISOString()}); }catch(e){code=e.statusCode;}
  ok(code===404,`H1 portal action rejected (404) for reservation ${st}`);
}
// H1: non-terminal statuses ALLOWED
for (const st of ['NEW','CONFIRMED','CHECKED_OUT']){
  const {la}=await mk(st,'ACTIVE');
  let okFlag=false; try{ const r=await LA.requestExtensionByToken(la.portalToken,{requestedReturnAt:new Date(Date.now()+2*86400000).toISOString()}); okFlag=!!r?.ok; }catch(e){okFlag='THREW:'+e.statusCode;}
  ok(okFlag===true,`H1 portal action ALLOWED for reservation ${st} (got ${okFlag})`);
}
// H1: getByPortalToken (READ) still works for terminal reservation (CHECKED_IN) + closed loaner view
{
  const {la}=await mk('CHECKED_IN','CLOSED');
  let view=null,threw=null; try{ view=await LA.getByPortalToken(la.portalToken); }catch(e){threw=e.statusCode;}
  ok(view && view.status==='CLOSED' && !threw,`H1 getByPortalToken READ still works for returned/CHECKED_IN loaner (status=${view?.status}, threw=${threw})`);
}

// H2: agreementSigned true when signedAt set even though status DRAFT
{
  const {resv}=await mk('CONFIRMED','DRAFT',{signedAt:new Date(),signatureDataUrl:'data:image/png;base64,iVBOR'});
  const user={role:'ADMIN',tenantId:t.id};
  const found = await DL.getReservation(user, resv.id);
  ok(found && found.agreementSigned===true && found.loanerAgreementStatus==='DRAFT',`H2 agreementSigned=true when signedAt set even though LA status DRAFT (signed=${found?.agreementSigned}, status=${found?.loanerAgreementStatus})`);
  const {resv:resv2}=await mk('CONFIRMED','DRAFT',{});
  const found2 = await DL.getReservation(user, resv2.id);
  ok(found2 && found2.agreementSigned===false,`H2 agreementSigned=false when DRAFT and no signedAt (got ${found2?.agreementSigned})`);
}

console.log(`\nH1/H2: ${pass} passed, ${fail} failed`);
await prisma.$disconnect(); process.exit(fail?1:0);
