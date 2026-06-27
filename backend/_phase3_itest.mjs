import { prisma } from './src/lib/prisma.js';
import { loanerRateService } from './src/modules/dealership-loaner/loaner-rate.service.js';
import { publicLoanerService } from './src/modules/dealership-loaner/public-loaner.service.js';

let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++;console.log('  PASS',m);} else {fail++;console.log('  FAIL',m);} };
const SIG='data:image/png;base64,iVBORw0KGgo=';

const t=await prisma.tenant.create({data:{name:'T',slug:'t-'+Date.now(),status:'ACTIVE'}});
const tid=t.id;
const econ=await prisma.vehicleType.create({data:{tenantId:tid,code:'ECON',name:'Economy'}});
const mini=await prisma.vehicleType.create({data:{tenantId:tid,code:'MINI',name:'Minivan'}});
await loanerRateService.upsertRates({tenantId:tid},[{vehicleTypeId:econ.id,dailyRate:30},{vehicleTypeId:mini.id,dailyRate:55}]);
const vMini=await prisma.vehicle.create({data:{tenantId:tid,internalNumber:'L-100',vehicleTypeId:mini.id,plate:'MINI1',programCategory:'BOTH',status:'AVAILABLE',year:2022,make:'Chrysler',model:'Pacifica'}});
const vEcon=await prisma.vehicle.create({data:{tenantId:tid,internalNumber:'L-101',vehicleTypeId:econ.id,plate:'ECON1',programCategory:'BOTH',status:'AVAILABLE',year:2021,make:'Toyota',model:'Corolla'}});
const cust=await prisma.customer.create({data:{tenantId:tid,firstName:'Ana',lastName:'Diaz',email:'a@x.com',phone:'7875551234'}});
const loc=await prisma.location.create({data:{tenantId:tid,code:'MAYA',name:'Mayaguez'}});
const mkResv=async(ro,status)=>prisma.reservation.create({data:{
  tenant:{connect:{id:tid}}, reservationNumber:'R-'+ro+'-'+Date.now(), customer:{connect:{id:cust.id}},
  status, workflowMode:'DEALERSHIP_LOANER', repairOrderNumber:ro,
  serviceVehicleType:{connect:{id:econ.id}}, serviceVehicleYear:2021, serviceVehicleMake:'Toyota', serviceVehicleModel:'Corolla',
  pickupAt:new Date('2026-07-01T10:00:00Z'), returnAt:new Date('2026-07-03T10:00:00Z'), loanerBillingStatus:'DRAFT',
  pickupLocation:{connect:{id:loc.id}}, returnLocation:{connect:{id:loc.id}} }});

// --- lookup before reserve ---
const r1=await mkResv('RO-1','CONFIRMED');
const lk=await publicLoanerService.lookup({tenantId:tid, repairOrderNumber:'RO-1'});
ok(lk.appointment && lk.appointment.status==='CONFIRMED','lookup returns appointment.status=CONFIRMED');
ok(lk.appointment.entitledClassLabel==='Economy' && lk.appointment.serviceVehicle.classLabel==='Economy','entitledClassLabel + serviceVehicle.classLabel = Economy');
ok(lk.appointment.agreement.available===false && lk.appointment.agreement.url===null,'agreement not available pre-reserve');
const optMini=lk.loaners.find(o=>o.classLabel==='Minivan'); const optEcon=lk.loaners.find(o=>o.classLabel==='Economy');
ok(optMini && optMini.dailyRate===55 && optMini.upgradeDeltaPerDay===25,`Minivan dailyRate 55 / delta 25 (got ${optMini&&optMini.dailyRate}/${optMini&&optMini.upgradeDeltaPerDay})`);
ok(optEcon && optEcon.upgradeDeltaPerDay===0,'Economy (entitled) delta 0');

// --- reserve an UPGRADE (Minivan) ---
const rv=await publicLoanerService.reserve({tenantId:tid, appointmentId:r1.id, loanerId:vMini.id, signature:SIG, ip:'1.2.3.4'});
ok(rv.upgradeDeltaPerDay===25 && rv.estimatedUpgradeTotal===50,`reserve upgrade: delta 25, total 50 over 2 days (got ${rv.upgradeDeltaPerDay}/${rv.estimatedUpgradeTotal})`);
const after=await prisma.reservation.findUnique({where:{id:r1.id},select:{loanerBillingMode:true,loanerBillingStatus:true,estimatedTotal:true,vehicleId:true}});
ok(after.loanerBillingMode==='CUSTOMER_PAY' && after.loanerBillingStatus==='PENDING_APPROVAL' && Number(after.estimatedTotal)===50,'reservation flagged CUSTOMER_PAY/PENDING_APPROVAL/estimatedTotal=50');
ok(after.vehicleId===vMini.id,'assigned loaner = Minivan');
const agr=await prisma.loanerAgreement.findFirst({where:{reservationId:r1.id},select:{status:true,portalToken:true,signatureDataUrl:true}});
ok(agr && agr.status==='DRAFT' && !!agr.portalToken && agr.signatureDataUrl===SIG,'LoanerAgreement DRAFT created w/ portalToken + signature');

// lookup after reserve -> agreement available + assignedLoaner
const lk2=await publicLoanerService.lookup({tenantId:tid, repairOrderNumber:'RO-1'});
ok(lk2.appointment.agreement.available===true && /\/customer\/loaner-status\?token=/.test(lk2.appointment.agreement.url||''),'agreement available + portal url after reserve');
ok(lk2.appointment.assignedLoaner && lk2.appointment.assignedLoaner.classLabel==='Minivan','assignedLoaner=Minivan after reserve');

// --- GUARD: checked-out cannot change -> 409 ---
await prisma.reservation.update({where:{id:r1.id},data:{status:'CHECKED_OUT'}});
let code=null; try{ await publicLoanerService.reserve({tenantId:tid, appointmentId:r1.id, loanerId:vEcon.id, signature:SIG}); }catch(e){ code=e.statusCode; }
ok(code===409,`reserve on CHECKED_OUT -> 409 (got ${code})`);

// --- same/lower class -> delta 0, no billing change ---
const r2=await mkResv('RO-2','CONFIRMED');
const rvE=await publicLoanerService.reserve({tenantId:tid, appointmentId:r2.id, loanerId:vEcon.id, signature:SIG});
ok(rvE.upgradeDeltaPerDay===0 && rvE.estimatedUpgradeTotal===0,'entitled-class reserve -> $0 differential');
const after2=await prisma.reservation.findUnique({where:{id:r2.id},select:{loanerBillingMode:true,estimatedTotal:true}});
ok((after2.loanerBillingMode===null) && (after2.estimatedTotal===null||Number(after2.estimatedTotal)===0),'no billing flag set for covered (entitled) class');

console.log(`\nPhase2+3 integration: ${pass} passed, ${fail} failed`);
await prisma.$disconnect(); process.exit(fail?1:0);
