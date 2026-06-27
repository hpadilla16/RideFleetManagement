import { prisma } from './src/lib/prisma.js';
import { dealershipLoanerService as S } from './src/modules/dealership-loaner/dealership-loaner.service.js';
let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++;console.log('  PASS',m);} else {fail++;console.log('  FAIL',m);} };

const tA=await prisma.tenant.create({data:{name:'A',slug:'a-'+Date.now(),status:'ACTIVE'}});
const tB=await prisma.tenant.create({data:{name:'B',slug:'b-'+Date.now(),status:'ACTIVE'}});
await prisma.loanerRequest.create({data:{tenantId:tA.id,name:'Ana Diaz',phone:'7875550101',repairOrderNumber:'RO-A1',status:'RECEIVED'}});
await prisma.loanerRequest.create({data:{tenantId:tA.id,name:'Beto Cruz',phone:'7875550102',status:'CONTACTED'}});
const bReq=await prisma.loanerRequest.create({data:{tenantId:tB.id,name:'Other Tenant',phone:'7875559999',status:'RECEIVED'}});

const adminA={role:'ADMIN',tenantId:tA.id};
const adminB={role:'ADMIN',tenantId:tB.id};
const superA={role:'SUPER_ADMIN',tenantId:null};

let r=await S.listLoanerRequests(adminA,{});
ok(r.requests.length===2 && r.requests.every(x=>x.tenantId===tA.id),'tenant admin sees only own tenant requests (2)');
r=await S.listLoanerRequests(adminA,{status:'RECEIVED'});
ok(r.requests.length===1 && r.requests[0].status==='RECEIVED','filter by status works');
r=await S.listLoanerRequests(adminA,{query:'Beto'});
ok(r.requests.length===1 && r.requests[0].name==='Beto Cruz','search by name works');
r=await S.listLoanerRequests(adminA,{query:'RO-A1'});
ok(r.requests.length===1,'search by RO works');
r=await S.listLoanerRequests(superA,{});
ok(r.requests.length===3,'super-admin sees all tenants (3)');

const target=(await S.listLoanerRequests(adminA,{query:'Ana'})).requests[0];
const upd=await S.updateLoanerRequest(adminA,target.id,{status:'closed'});
ok(upd.status==='CLOSED','update normalizes + sets CLOSED');

let code=null; try{ await S.updateLoanerRequest(adminA,target.id,{status:'BOGUS'}); }catch(e){code=e.statusCode;}
ok(code===400,'invalid status -> 400');
let code2=null; try{ await S.updateLoanerRequest(adminB,target.id,{status:'CLOSED'}); }catch(e){code2=e.statusCode;}
ok(code2===404,'cross-tenant update -> 404 (fail-closed)');

console.log(`\nLoanerRequest queue: ${pass} passed, ${fail} failed`);
await prisma.$disconnect(); process.exit(fail?1:0);
