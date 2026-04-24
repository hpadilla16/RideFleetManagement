import { api, login, summary } from './_api.mjs';

// V7 — website-only mandatory fees: public endpoint must enforce tenant
// isolation. Tenant A creates a fee with displayOnline=true; the public
// /website-fees endpoint (unauthenticated, tenantSlug query) must return
// that fee for tenant A and zero fees for tenant B.

const A = await login('admin+a@fleetbeta.local');
const B = await login('admin+b@fleetbeta.local');

const tenantSlugA = A.user?.tenant?.slug || A.user?.tenantSlug || 'beta-a';
const tenantSlugB = B.user?.tenant?.slug || B.user?.tenantSlug || 'beta-b';

const n = Date.now();

// Setup: tenant A creates a website-display fee. Tenant B gets a
// mandatory fee WITHOUT displayOnline to confirm that flag (not just
// mandatory) is what gates visibility.
const feeA = await api('POST', '/fees', A.token, {
  name: `Website Fee V7 ${n}`,
  mode: 'FIXED',
  amount: 5,
  mandatory: true,
  displayOnline: true
});
const feeAHidden = await api('POST', '/fees', A.token, {
  name: `Hidden Fee V7 ${n}`,
  mode: 'FIXED',
  amount: 3,
  mandatory: true,
  displayOnline: false
});
const feeB = await api('POST', '/fees', B.token, {
  name: `B Mandatory Fee V7 ${n}`,
  mode: 'FIXED',
  amount: 7,
  mandatory: true,
  displayOnline: false
});

// Public endpoint calls (no token)
const publicA = await api('GET', `/public/booking/website-fees?tenantSlug=${encodeURIComponent(tenantSlugA)}`);
const publicB = await api('GET', `/public/booking/website-fees?tenantSlug=${encodeURIComponent(tenantSlugB)}`);
const publicMissing = await api('GET', '/public/booking/website-fees');
const publicUnknown = await api('GET', '/public/booking/website-fees?tenantSlug=does-not-exist-v7');

const feesFromA = (publicA.data?.fees || []);
const feesFromB = (publicB.data?.fees || []);

const results = [
  {
    test: 'tenant A public fetch returns only their displayOnline=true fee',
    pass: publicA.ok && feesFromA.length === 1 && feesFromA[0].id === feeA.data?.id
  },
  {
    test: 'tenant A hidden fee (displayOnline=false) is NOT returned',
    pass: publicA.ok && !feesFromA.some((f) => f.id === feeAHidden.data?.id)
  },
  {
    test: 'tenant B public fetch returns zero (no displayOnline=true fee for B)',
    pass: publicB.ok && feesFromB.length === 0
  },
  {
    test: 'tenant B cannot see tenant A fees via their own slug',
    pass: publicB.ok && !feesFromB.some((f) => f.id === feeA.data?.id)
  },
  {
    test: 'missing tenantSlug + tenantId returns 400',
    pass: publicMissing.status === 400
  },
  {
    test: 'unknown tenantSlug returns 400 (Tenant not found)',
    pass: publicUnknown.status === 400
  }
];

// Cleanup (best-effort)
if (feeA.data?.id) await api('DELETE', `/fees/${feeA.data.id}`, A.token);
if (feeAHidden.data?.id) await api('DELETE', `/fees/${feeAHidden.data.id}`, A.token);
if (feeB.data?.id) await api('DELETE', `/fees/${feeB.data.id}`, B.token);

console.log(JSON.stringify(summary('V7', results, {
  tenantSlugA,
  tenantSlugB,
  publicAStatus: publicA.status,
  publicBStatus: publicB.status,
  publicMissingStatus: publicMissing.status,
  publicUnknownStatus: publicUnknown.status,
  feesFromACount: feesFromA.length,
  feesFromBCount: feesFromB.length
}), null, 2));
