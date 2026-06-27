import { prisma } from './src/lib/prisma.js';
import { loanerAgreementService } from './src/modules/dealership-loaner/loaner-agreement.service.js';
import { publicLoanerService } from './src/modules/dealership-loaner/public-loaner.service.js';
let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++;console.log('  PASS',m);} else {fail++;console.log('  FAIL',m);} };

const t=await prisma.tenant.create({data:{name:'T',slug:'t-'+Date.now(),status:'ACTIVE'}});
const cust=await prisma.customer.create({data:{tenantId:t.id,firstName:'Ana',lastName:'Diaz',phone:'7875550101'}});
const loc=await prisma.location.create({data:{tenantId:t.id,code:'KEN',name:'Kennedy'}});
const vt=await prisma.vehicleType.create({data:{tenantId:t.id,code:'SSUV',name:'Standard SUV'}});
const veh=await prisma.vehicle.create({data:{tenantId:t.id,internalNumber:'L1',vehicleTypeId:vt.id,plate:'ABC123',year:2025,make:'Hyundai',model:'Tucson',programCategory:'BOTH',status:'AVAILABLE'}});
const resv=await prisma.reservation.create({data:{
  tenant:{connect:{id:t.id}}, reservationNumber:'R-'+Date.now(), customer:{connect:{id:cust.id}},
  status:'CHECKED_OUT', workflowMode:'DEALERSHIP_LOANER', repairOrderNumber:'RO-PORTAL',
  pickupAt:new Date('2026-06-27T10:00:00Z'), returnAt:new Date('2026-07-01T10:00:00Z'),
  pickupLocation:{connect:{id:loc.id}}, returnLocation:{connect:{id:loc.id}},
  vehicle:{connect:{id:veh.id}} }});
const agr=await prisma.loanerAgreement.create({data:{
  tenantId:t.id, agreementNumber:'LA-'+Date.now(), status:'DRAFT',
  reservationId:resv.id, vehicleId:veh.id,
  pickupAt:resv.pickupAt, returnAt:resv.returnAt,
  customerFirstName:'Ana', customerLastName:'Diaz',
  portalToken:'tok_'+Date.now() }});

// Fix A: getByPortalToken must NOT 500 and returns vehicle.plate
let dto=null, err=null;
try { dto = await loanerAgreementService.getByPortalToken(agr.portalToken); } catch(e){ err=e; }
ok(!err, `getByPortalToken does not throw (was 500). err=${err&&err.message}`);
ok(dto && dto.vehicle && dto.vehicle.plate==='ABC123', `portal DTO returns vehicle.plate (got ${dto&&dto.vehicle&&dto.vehicle.plate})`);
ok(dto && dto.service && dto.service.reservationStatus==='CHECKED_OUT','portal DTO includes reservationStatus');

// Fix B: lookup — CHECKED_OUT shows agreement available; CANCELLED hides it
let lk=await publicLoanerService.lookup({tenantId:t.id, repairOrderNumber:'RO-PORTAL'});
ok(lk.appointment.agreement.available===true,'CHECKED_OUT: agreement.available=true (happy path)');
await prisma.reservation.update({where:{id:resv.id},data:{status:'CANCELLED'}});
lk=await publicLoanerService.lookup({tenantId:t.id, repairOrderNumber:'RO-PORTAL'});
ok(lk.appointment.agreement.available===false && lk.appointment.agreement.url===null,'CANCELLED: agreement.available=false (no dead-end button)');

console.log(`\nPortal-fix integration: ${pass} passed, ${fail} failed`);
await prisma.$disconnect(); process.exit(fail?1:0);
