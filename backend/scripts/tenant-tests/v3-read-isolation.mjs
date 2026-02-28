import { api, login, summary } from './_api.mjs';

const A = await login('admin+a@fleetbeta.local');
const B = await login('admin+b@fleetbeta.local');

const feeSuffix = Date.now();
const feeA = await api('POST', '/fees', A.token, { name: `Fee A V3 ${feeSuffix}`, mode: 'FIXED', amount: 5 });
const feeB = await api('POST', '/fees', B.token, { name: `Fee B V3 ${feeSuffix}`, mode: 'FIXED', amount: 7 });
const svcA = await api('POST', '/additional-services', A.token, { name: `Svc A V3 ${feeSuffix}`, rate: 3 });
const svcB = await api('POST', '/additional-services', B.token, { name: `Svc B V3 ${feeSuffix}`, rate: 4 });
const rateA = await api('POST', '/rates', A.token, { rateCode: `RATE-A-V3-${feeSuffix}`, name: `Rate A V3 ${feeSuffix}` });
const rateB = await api('POST', '/rates', B.token, { rateCode: `RATE-B-V3-${feeSuffix}`, name: `Rate B V3 ${feeSuffix}` });

const custListA = await api('GET', '/customers', A.token);
const custListB = await api('GET', '/customers', B.token);
const locListA = await api('GET', '/locations', A.token);
const locListB = await api('GET', '/locations', B.token);
const feeListA = await api('GET', '/fees', A.token);

const custB = (custListB.data || []).find((x) => x.phone === '+1555000202');
const locB = (locListB.data || []).find((x) => x.code === 'LOC-B');

const crossCust = await api('GET', `/customers/${custB?.id}`, A.token);
const crossLoc = await api('GET', `/locations/${locB?.id}`, A.token);
const crossSvc = await api('GET', `/additional-services/${svcB.data?.id}`, A.token);
const crossRate = await api('PATCH', `/rates/${rateB.data?.id}`, A.token, { name: 'HACK' });

const results = [
  { test: 'A customer list excludes B', pass: !(custListA.data || []).some((x) => x.phone === '+1555000202') },
  { test: 'B customer list excludes A', pass: !(custListB.data || []).some((x) => x.phone === '+1555000101') },
  { test: 'A cannot read B customer by id', pass: crossCust.status === 404 },
  { test: 'A cannot read B location by id', pass: crossLoc.status === 404 },
  { test: 'A fee list excludes B fee', pass: !(feeListA.data || []).some((x) => x.id === feeB.data?.id) },
  { test: 'A cannot read B additional service by id', pass: crossSvc.status === 404 },
  { test: 'A cannot update B rate', pass: crossRate.status === 404 || crossRate.status === 400 },
  { test: 'Rate creates succeed per tenant', pass: rateA.ok && rateB.ok },
];

console.log(JSON.stringify(summary('V3', results), null, 2));