import { api, login, summary } from './_api.mjs';

// V8b — VehicleClassStopSale tenant isolation. Tenant A creates a stop
// sale on one of their vehicle types; tenant B must be unable to read,
// patch, or delete that stop sale, and B's list endpoint must not leak it.
//
// (Originally tracked as a follow-up to v0.9.0-beta.6, folded into V8
// because it's the same file/pattern as the addendum isolation case.)

function daysAheadAtHour(daysAhead, hourUtc) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

const A = await login('admin+a@fleetbeta.local');
const B = await login('admin+b@fleetbeta.local');

const vtA = (await api('GET', '/vehicle-types', A.token)).data?.[0];
const vtB = (await api('GET', '/vehicle-types', B.token)).data?.[0];

const seed = Date.now();

// Setup: A creates a stop-sale on their own vehicle type.
const stopSaleA = await api('POST', '/stop-sales', A.token, {
  vehicleTypeId: vtA.id,
  startDate: daysAheadAtHour(7, 0),
  endDate: daysAheadAtHour(10, 0),
  reason: `V8b isolation test ${seed}`,
  isActive: true
});
const stopSaleIdA = stopSaleA.data?.id || null;

// (Optional) B creates a sibling stop-sale on their own VT, to verify A
// can't see B's stop-sale either.
const stopSaleB = vtB?.id
  ? await api('POST', '/stop-sales', B.token, {
      vehicleTypeId: vtB.id,
      startDate: daysAheadAtHour(7, 0),
      endDate: daysAheadAtHour(10, 0),
      reason: `V8b sibling B ${seed}`,
      isActive: true
    })
  : { ok: false, status: 0 };
const stopSaleIdB = stopSaleB.data?.id || null;

// --- Tenant A own access (positive control) ---
const ownList = await api('GET', '/stop-sales', A.token);
const ownGet = stopSaleIdA ? await api('GET', `/stop-sales/${stopSaleIdA}`, A.token) : { ok: false, status: 0 };

// --- Tenant B's view of /stop-sales — must NOT include A's row ---
const bList = await api('GET', '/stop-sales', B.token);
const bSeesA = Array.isArray(bList.data) && bList.data.some((x) => x.id === stopSaleIdA);
const bSeesOnlyOwn = Array.isArray(bList.data)
  && (stopSaleIdB ? bList.data.some((x) => x.id === stopSaleIdB) : true)
  && !bSeesA;

// --- Tenant B cross-tenant attempts on A's stop-sale (all 404) ---
const crossGet = stopSaleIdA ? await api('GET', `/stop-sales/${stopSaleIdA}`, B.token) : { ok: false, status: 0 };
const crossPatch = stopSaleIdA
  ? await api('PATCH', `/stop-sales/${stopSaleIdA}`, B.token, { isActive: false })
  : { ok: false, status: 0 };
const crossDelete = stopSaleIdA
  ? await api('DELETE', `/stop-sales/${stopSaleIdA}`, B.token, null)
  : { ok: false, status: 0 };

// --- Symmetric sanity: A cannot see B's stop-sale either ---
const aListAfter = await api('GET', '/stop-sales', A.token);
const aSeesB = Array.isArray(aListAfter.data) && stopSaleIdB && aListAfter.data.some((x) => x.id === stopSaleIdB);

const results = [
  { test: 'A creates stop-sale', pass: stopSaleA.ok && !!stopSaleIdA },
  { test: 'A reads own stop-sale list (contains own)', pass: ownList.ok && Array.isArray(ownList.data) && ownList.data.some((x) => x.id === stopSaleIdA) },
  { test: 'A reads own stop-sale by id', pass: ownGet.ok && ownGet.data?.id === stopSaleIdA },
  { test: 'B list does not include A stop-sale', pass: bList.ok && !bSeesA },
  { test: 'B list shows their own stop-sale (positive control)', pass: !stopSaleIdB || bSeesOnlyOwn },
  { test: 'B cannot read A stop-sale by id (404)', pass: crossGet.status === 404 },
  { test: 'B cannot patch A stop-sale (404)', pass: crossPatch.status === 404 },
  { test: 'B cannot delete A stop-sale (404)', pass: crossDelete.status === 404 },
  { test: 'A list does not include B stop-sale (symmetric)', pass: !stopSaleIdB || !aSeesB }
];

// Cleanup (best-effort)
if (stopSaleIdA) await api('DELETE', `/stop-sales/${stopSaleIdA}`, A.token, null);
if (stopSaleIdB) await api('DELETE', `/stop-sales/${stopSaleIdB}`, B.token, null);

console.log(JSON.stringify(summary('V8b', results, {
  stopSaleIdA,
  stopSaleIdB,
  stopSaleAStatus: stopSaleA.status,
  stopSaleBStatus: stopSaleB.status,
  bListLen: Array.isArray(bList.data) ? bList.data.length : null,
  ownListLen: Array.isArray(ownList.data) ? ownList.data.length : null
}), null, 2));
