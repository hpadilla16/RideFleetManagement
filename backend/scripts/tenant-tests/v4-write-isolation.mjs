import { api, login, summary } from './_api.mjs';

const A = await login('admin+a@fleetbeta.local');
const B = await login('admin+b@fleetbeta.local');

const customersA = await api('GET', '/customers', A.token);
const customersB = await api('GET', '/customers', B.token);
const locationsA = await api('GET', '/locations', A.token);
const locationsB = await api('GET', '/locations', B.token);

const custA = (customersA.data || []).find((x) => x.phone === '+1555000101');
const custB = (customersB.data || []).find((x) => x.phone === '+1555000202');
const locA = (locationsA.data || []).find((x) => x.code === 'LOC-A');
const locB = (locationsB.data || []).find((x) => x.code === 'LOC-B');

const n = Date.now();
const feeA = await api('POST', '/fees', A.token, { name: `Fee A V4 ${n}`, mode: 'FIXED', amount: 10 });
const feeB = await api('POST', '/fees', B.token, { name: `Fee B V4 ${n}`, mode: 'FIXED', amount: 11 });
const svcA = await api('POST', '/additional-services', A.token, { name: `Svc A V4 ${n}`, rate: 2 });
const svcB = await api('POST', '/additional-services', B.token, { name: `Svc B V4 ${n}`, rate: 3 });
const rateA = await api('POST', '/rates', A.token, { rateCode: `RATE-A-V4-${n}`, name: `Rate A V4 ${n}` });
const rateB = await api('POST', '/rates', B.token, { rateCode: `RATE-B-V4-${n}`, name: `Rate B V4 ${n}` });

const crossCustUpdate = await api('PATCH', `/customers/${custB?.id}`, A.token, { notes: 'A trying to modify B' });
const crossLocUpdate = await api('PATCH', `/locations/${locB?.id}`, A.token, { name: 'HACK LOC B' });
const crossFeeDelete = await api('DELETE', `/fees/${feeB.data?.id}`, A.token);
const crossSvcDelete = await api('DELETE', `/additional-services/${svcB.data?.id}`, A.token);
const crossRateUpdate = await api('PATCH', `/rates/${rateB.data?.id}`, A.token, { name: 'HACK RATE B' });

const ownCustUpdate = await api('PATCH', `/customers/${custA?.id}`, A.token, { notes: 'A own update ok' });
const ownLocUpdate = await api('PATCH', `/locations/${locA?.id}`, A.token, { name: `Location A Updated ${n}` });
const ownFeeDelete = await api('DELETE', `/fees/${feeA.data?.id}`, A.token);
const ownSvcDelete = await api('DELETE', `/additional-services/${svcA.data?.id}`, A.token);
const ownRateUpdate = await api('PATCH', `/rates/${rateA.data?.id}`, A.token, { name: `Rate A Updated ${n}` });

const newFeeA = await api('POST', '/fees', A.token, { name: `Fee A Stamp V4 ${n}`, mode: 'FIXED', amount: 9 });
const newSvcA = await api('POST', '/additional-services', A.token, { name: `Svc A Stamp V4 ${n}`, rate: 1 });
const feeListB = await api('GET', '/fees', B.token);
const svcListB = await api('GET', '/additional-services', B.token);

const results = [
  { test: 'A cannot update B customer', pass: crossCustUpdate.status === 404 },
  { test: 'A cannot update B location', pass: crossLocUpdate.status === 404 },
  { test: 'A cannot delete B fee', pass: crossFeeDelete.status === 404 },
  { test: 'A cannot delete B service', pass: crossSvcDelete.status === 404 },
  { test: 'A cannot update B rate', pass: crossRateUpdate.status === 404 },
  { test: 'A can update own customer', pass: ownCustUpdate.ok },
  { test: 'A can update own location', pass: ownLocUpdate.ok },
  { test: 'A can delete own fee', pass: ownFeeDelete.status === 204 },
  { test: 'A can delete own service', pass: ownSvcDelete.status === 204 },
  { test: 'A can update own rate', pass: ownRateUpdate.ok },
  { test: 'B cannot see A newly created fee', pass: !(feeListB.data || []).some((x) => x.id === newFeeA.data?.id) },
  { test: 'B cannot see A newly created service', pass: !(svcListB.data || []).some((x) => x.id === newSvcA.data?.id) }
];

console.log(JSON.stringify(summary('V4', results, { ownRateUpdate }), null, 2));