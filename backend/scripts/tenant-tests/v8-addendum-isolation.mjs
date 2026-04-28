import { api, login, summary } from './_api.mjs';

// V8a — Rental Agreement Addendum tenant isolation (BUG-001).
// Tenant A creates a reservation → agreement → addendum. Tenant B must
// be denied access to that addendum on every endpoint:
//   GET    /rental-agreements/:id/addendums                   → 404
//   GET    /rental-agreements/:id/addendums/:addendumId        → 404
//   POST   /rental-agreements/:id/addendums/:addendumId/sign   → 404
//   POST   /rental-agreements/:id/addendums/:addendumId/void   → 404
//   GET    /rental-agreements/:id/addendums/:addendumId/print  → 404
// All cross-tenant 404s are produced before any service work happens —
// `ensureAccessible` / `getAddendumById` are tenant-scoped and short-
// circuit before the per-route logic runs.

function daysAheadAtHour(daysAhead, hourUtc) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

const A = await login('admin+a@fleetbeta.local');
const B = await login('admin+b@fleetbeta.local');

// Setup tenant A: customer/location/vehicleType + reservation + agreement.
const custA = (await api('GET', '/customers', A.token)).data.find((x) => x.phone === '+1555000101');
const locA = (await api('GET', '/locations', A.token)).data.find((x) => x.code === 'LOC-A');
const vtA = (await api('GET', '/vehicle-types', A.token)).data?.[0];

const seed = Date.now();
const resA = await api('POST', '/reservations', A.token, {
  reservationNumber: `RES-V8A-${seed}`,
  customerId: custA.id,
  vehicleTypeId: vtA.id,
  pickupLocationId: locA.id,
  returnLocationId: locA.id,
  pickupAt: daysAheadAtHour(7, 16),
  returnAt: daysAheadAtHour(8, 16),
  dailyRate: 20,
  estimatedTotal: 40,
  status: 'CONFIRMED',
  paymentStatus: 'PENDING'
});

const startA = resA.ok
  ? await api('POST', `/rental-agreements/start-from-reservation/${resA.data.id}`, A.token, {})
  : { ok: false, status: 0 };
const agreementIdA = startA.data?.id || null;

const addendumA = agreementIdA
  ? await api('POST', `/rental-agreements/${agreementIdA}/addendums`, A.token, {
      newPickupAt: daysAheadAtHour(10, 16),
      newReturnAt: daysAheadAtHour(11, 16),
      reason: 'V8a isolation test addendum',
      reasonCategory: 'admin_correction'
    })
  : { ok: false, status: 0 };
const addendumIdA = addendumA.data?.id || null;

// --- Tenant A own access (positive controls) ---
const ownList = agreementIdA
  ? await api('GET', `/rental-agreements/${agreementIdA}/addendums`, A.token)
  : { ok: false, status: 0 };
const ownGet = (agreementIdA && addendumIdA)
  ? await api('GET', `/rental-agreements/${agreementIdA}/addendums/${addendumIdA}`, A.token)
  : { ok: false, status: 0 };
const ownPrint = (agreementIdA && addendumIdA)
  ? await api('GET', `/rental-agreements/${agreementIdA}/addendums/${addendumIdA}/print`, A.token)
  : { ok: false, status: 0 };

// --- Tenant B cross-tenant attempts (all should 404) ---
const crossList = agreementIdA
  ? await api('GET', `/rental-agreements/${agreementIdA}/addendums`, B.token)
  : { ok: false, status: 0 };
const crossGet = (agreementIdA && addendumIdA)
  ? await api('GET', `/rental-agreements/${agreementIdA}/addendums/${addendumIdA}`, B.token)
  : { ok: false, status: 0 };
const crossSign = (agreementIdA && addendumIdA)
  ? await api('POST', `/rental-agreements/${agreementIdA}/addendums/${addendumIdA}/signature`, B.token, {
      signatureDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      signatureSignedBy: 'B-Attacker'
    })
  : { ok: false, status: 0 };
const crossVoid = (agreementIdA && addendumIdA)
  ? await api('POST', `/rental-agreements/${agreementIdA}/addendums/${addendumIdA}/void`, B.token, {
      reason: 'cross-tenant attack'
    })
  : { ok: false, status: 0 };
const crossPrint = (agreementIdA && addendumIdA)
  ? await api('GET', `/rental-agreements/${agreementIdA}/addendums/${addendumIdA}/print`, B.token)
  : { ok: false, status: 0 };

// --- Date-edit gate cross-check: tenant A trying to PATCH the parent
// reservation's dates while a PENDING_SIGNATURE addendum exists must be
// blocked with 409. This is the BUG-001 gate working end-to-end.
// Send BOTH pickupAt + returnAt so validateReservationPatch (which runs
// BEFORE the gate) doesn't 400 on the orphaned-pickup case where the new
// pickup ends up after the unchanged returnAt. ---
const gatePatch = (resA.ok && addendumIdA)
  ? await api('PATCH', `/reservations/${resA.data.id}`, A.token, {
      pickupAt: daysAheadAtHour(12, 16),
      returnAt: daysAheadAtHour(13, 16)
    })
  : { ok: false, status: 0 };

const results = [
  { test: 'A creates reservation', pass: resA.ok },
  { test: 'A starts rental → agreement created', pass: startA.ok && !!agreementIdA },
  { test: 'A creates addendum', pass: addendumA.ok && !!addendumIdA },
  { test: 'A reads list of own addendums', pass: ownList.ok && Array.isArray(ownList.data) && ownList.data.some((x) => x.id === addendumIdA) },
  { test: 'A reads own addendum by id', pass: ownGet.ok && ownGet.data?.id === addendumIdA },
  { test: 'A renders own addendum print HTML', pass: ownPrint.ok },
  { test: 'B cannot list A addendums (404)', pass: crossList.status === 404 },
  { test: 'B cannot read A addendum by id (404)', pass: crossGet.status === 404 },
  { test: 'B cannot sign A addendum (404)', pass: crossSign.status === 404 },
  { test: 'B cannot void A addendum (404)', pass: crossVoid.status === 404 },
  { test: 'B cannot print A addendum (404)', pass: crossPrint.status === 404 },
  { test: 'BUG-001 gate: A cannot PATCH reservation dates while PENDING_SIGNATURE addendum exists (409)', pass: gatePatch.status === 409 }
];

// Cleanup (best-effort): void the addendum so the reservation is editable again.
if (addendumIdA && agreementIdA) {
  await api('POST', `/rental-agreements/${agreementIdA}/addendums/${addendumIdA}/void`, A.token, {
    reason: 'V8a cleanup'
  });
}

console.log(JSON.stringify(summary('V8a', results, {
  resAStatus: resA.status,
  startAStatus: startA.status,
  addendumAStatus: addendumA.status,
  agreementIdA,
  addendumIdA,
  gatePatchStatus: gatePatch.status,
  gatePatchCode: gatePatch.data?.code || null
}), null, 2));
