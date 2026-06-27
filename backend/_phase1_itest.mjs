import { prisma } from './src/lib/prisma.js';
import { loanerRateService } from './src/modules/dealership-loaner/loaner-rate.service.js';
import { ratesService } from './src/modules/rates/rates.service.js';

let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  PASS',m);} else {fail++;console.log('  FAIL',m);} };

const t = await prisma.tenant.create({ data: { name:'T', slug:'t-'+Date.now(), status:'ACTIVE' } });
const scope = { tenantId: t.id };
const vtEcon = await prisma.vehicleType.create({ data:{ tenantId:t.id, code:'ECON', name:'Economy' } });
const vtMini = await prisma.vehicleType.create({ data:{ tenantId:t.id, code:'MINI', name:'Minivan' } });

// set loaner rates via the service
await loanerRateService.upsertRates(scope, [
  { vehicleTypeId: vtEcon.id, dailyRate: 30 },
  { vehicleTypeId: vtMini.id, dailyRate: 55 },
]);
const map = await loanerRateService.getLoanerRateMap(t.id);
ok(map[vtEcon.id]===30 && map[vtMini.id]===55, 'loaner rate map returns set rates (30/55)');
ok((await loanerRateService.getLoanerClassRate(t.id, vtMini.id))===55, 'getLoanerClassRate(Minivan)=55');
const admin = await loanerRateService.listForAdmin(scope);
ok(admin.rates.length===2 && admin.rates.every(r=>r.dailyRate!=null), 'admin grid lists both classes with rates');

// ISOLATION: only a LOANER rate exists for Economy -> rental quote must be null
const pickupAt='2026-07-01T10:00:00.000Z', returnAt='2026-07-03T10:00:00.000Z';
const q1 = await ratesService.resolveForRental({ vehicleTypeId: vtEcon.id, pickupLocationId:null, pickupAt, returnAt }, scope);
ok(q1===null, 'ISOLATION: loaner-only class yields NO rental quote (null)');

// add a real RENTAL rate for Economy daily=50
const rr = await prisma.rate.create({ data:{ tenantId:t.id, rateCode:'STD', name:'Std', purpose:'RENTAL', daily:50 } });
await prisma.rateItem.create({ data:{ rateId:rr.id, vehicleTypeId:vtEcon.id, daily:50 } });
const q2 = await ratesService.resolveForRental({ vehicleTypeId: vtEcon.id, pickupLocationId:null, pickupAt, returnAt }, scope);
ok(q2 && Number(q2.dailyRate)===50, `rental quote uses RENTAL rate (50), not loaner (30): got ${q2 && q2.dailyRate}`);

// rental admin list excludes loaner price book
const list = await ratesService.list({}, scope);
ok(list.every(r=>r.purpose!=='LOANER') && list.some(r=>r.rateCode==='STD'), 'rental rates list excludes LOANER, includes STD');

console.log(`\nPhase1 integration: ${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail?1:0);
