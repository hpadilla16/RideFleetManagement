import { api, login, summary } from './_api.mjs';

const SA = await login('superadmin@fleetbeta.local');
const A = await login('admin+a@fleetbeta.local');
const B = await login('admin+b@fleetbeta.local');

const custA = (await api('GET', '/customers', A.token)).data.find((x) => x.phone === '+1555000101');
const custB = (await api('GET', '/customers', B.token)).data.find((x) => x.phone === '+1555000202');

const saCustomers = await api('GET', '/customers', SA.token);
const saLocations = await api('GET', '/locations', SA.token);
const seesA = (saCustomers.data || []).some((x) => x.id === custA.id);
const seesB = (saCustomers.data || []).some((x) => x.id === custB.id);

const saUpdateB = await api('PATCH', `/customers/${custB.id}`, SA.token, { notes: 'super-admin-update-v5' });
const bReadAfter = await api('GET', `/customers/${custB.id}`, B.token);

const results = [
  { test: 'Super admin can login', pass: !!SA.token },
  { test: 'Super admin sees tenant A customer', pass: seesA },
  { test: 'Super admin sees tenant B customer', pass: seesB },
  { test: 'Super admin can update tenant B customer', pass: saUpdateB.ok },
  { test: 'Tenant B sees super-admin change on own record', pass: String(bReadAfter.data?.notes || '').includes('super-admin-update-v5') },
  { test: 'Super admin can list locations across tenants', pass: (saLocations.data || []).some((x) => x.code === 'LOC-A') && (saLocations.data || []).some((x) => x.code === 'LOC-B') }
];

console.log(JSON.stringify(summary('V5', results), null, 2));