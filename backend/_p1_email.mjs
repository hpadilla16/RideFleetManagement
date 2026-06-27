import { parseLocationConfig } from './src/lib/location-config.js';
let pass=0,fail=0;const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
const cfg = parseLocationConfig(JSON.stringify({ locationEmail:'kennedy@vph.test', gracePeriodMin:60 }));
ok(cfg.locationEmail==='kennedy@vph.test','location email parsed from locationConfig');
ok(parseLocationConfig(null).locationEmail===undefined,'no config -> no email (safe)');
console.log(`email-source: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
