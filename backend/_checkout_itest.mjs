import { prisma } from './src/lib/prisma.js';
import { reservationsService } from './src/modules/reservations/reservations.service.js';
let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++;console.log('  PASS',m);} else {fail++;console.log('  FAIL',m);} };

const t=await prisma.tenant.create({data:{name:'T',slug:'t-'+Date.now(),status:'ACTIVE'}});
const scope={tenantId:t.id};
const cust=await prisma.customer.create({data:{tenantId:t.id,firstName:'Ana',lastName:'D',email:'a@x.com',phone:'7875551234'}});
const vt=await prisma.vehicleType.create({data:{tenantId:t.id,code:'ECON',name:'Economy'}});
// Location CLOSED on 2026-06-28
const locClosed=await prisma.location.create({data:{tenantId:t.id,code:'KENN',name:'Kennedy',locationConfig:JSON.stringify({closedDates:['2026-06-28']})}});
// Location OPEN (no closed config)
const locOpen=await prisma.location.create({data:{tenantId:t.id,code:'MAYA',name:'Mayaguez',locationConfig:JSON.stringify({})}});

// Case 1: pickup on a CLOSED date -> must throw with statusCode 400 (was an untagged 500)
let err=null;
try {
  await reservationsService.create({
    reservationNumber:'R-CLOSED-'+Date.now(), customerId:cust.id, vehicleTypeId:vt.id,
    pickupLocationId:locClosed.id, returnLocationId:locClosed.id,
    pickupAt:'2026-06-28T15:00:00Z', returnAt:'2026-07-02T15:00:00Z', status:'CONFIRMED'
  }, scope);
} catch(e){ err=e; }
ok(err && err.statusCode===400, `closed-date create throws statusCode=400 (got ${err&&err.statusCode})`);
ok(err && /closed for 2026-06-28/.test(err.message), `message names the closed date (got: ${err&&err.message})`);

// Case 2: pickup on an OPEN date/location -> passes location validation (proceeds to create)
let err2=null, created=null;
try {
  created = await reservationsService.create({
    reservationNumber:'R-OPEN-'+Date.now(), customerId:cust.id, vehicleTypeId:vt.id,
    pickupLocationId:locOpen.id, returnLocationId:locOpen.id,
    pickupAt:'2026-06-28T15:00:00Z', returnAt:'2026-07-02T15:00:00Z', status:'CONFIRMED'
  }, scope);
} catch(e){ err2=e; }
ok(!err2 && created && created.id, `open location books fine (err=${err2&&err2.message})`);

// Case 3: simulate the route classifier on a tagged error
function classify(error){ const code=Number(error?.statusCode||error?.status); if(code>=400&&code<500) return code; if(/required|available|sold out|not found|not enabled|after|closed|outside|operating hours|must be/i.test(String(error?.message||''))) return 400; return 500; }
ok(classify(err)===400, 'route classifier -> 400 for the closed-date error (no more 500)');
ok(classify(new Error('searchType must be RENTAL or CAR_SHARING'))===400, 'route classifier -> 400 for searchType message');
ok(classify(new Error('Cannot read properties of undefined'))===500, 'route classifier -> 500 for a genuinely unexpected error');

console.log(`\nCheckout-fix integration: ${pass} passed, ${fail} failed`);
await prisma.$disconnect(); process.exit(fail?1:0);
