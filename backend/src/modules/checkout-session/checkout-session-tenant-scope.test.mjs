/**
 * Tenant-isolation regression tests for the checkout-session router. No DB.
 *
 * WHY THIS EXISTS (2026-08-17, raised by QA on fix/checkout-finalize-truth):
 * the router is mounted behind `requireAuth + requireModuleAccess('reservations')`
 * (main.js), and fourteen of its seventeen handlers took `req.params.id` and
 * acted on it WITHOUT resolving a tenant scope. Any authenticated user with the
 * reservations module could drive another tenant's checkout session by id:
 *
 *   - POST /:id/transition  -> CLOSED runs the whole finalize cascade on the
 *     other tenant: reservation to CHECKED_OUT, RentalAgreement FINALIZED,
 *     vehicle ON_RENT, and the signed contract emailed to THEIR customer.
 *   - POST /:id/charge-sale, /hold-deposit, /record-manual-{payment,deposit}
 *     -> real money against another tenant's agreement.
 *   - POST /:id/{terms,handoff}-token -> a token granting access to another
 *     tenant's customer data.
 *   - POST /:id/customer-signature -> a signature on someone else's contract.
 *
 * The fix is a single `router.param('id')` guard rather than fourteen
 * per-handler scope lookups, so these tests drive the REAL router end to end
 * (not an extracted handler): that is the only way to prove the guard actually
 * runs BEFORE each handler, and that it keeps covering routes added later.
 *
 * `everyIdRoute` below is the drift net -- it enumerates the `:id` routes off
 * the live router stack, so a new unguarded handler fails this file instead of
 * shipping. QA had only audited /transition.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// The routes module transitively imports lib/prisma.js, which constructs a
// PrismaClient at import time. Nothing here reaches the DB -- every prisma call
// the guard makes is mocked below.
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';

const { checkoutSessionRouter } = await import('./checkout-session.routes.js');
const { checkoutSessionService } = await import('./checkout-session.service.js');
const { vehicleSwapService } = await import('./vehicle-swap.service.js');
const { spinChargeService } = await import('./spin-charge.service.js');
// `/send-customer-inspection` imports this one dynamically inside the handler
// (routes.js). Importing it here puts it in the module cache so the tripwire's
// stub is the instance the handler resolves -- without it `handlerReached` would
// silently under-report for that one route.
const { customerInspectionService } = await import('../customer-inspection/customer-inspection.service.js');
const { prisma } = await import('../../lib/prisma.js');

const OWNER = 'tenant-owner';
const ATTACKER = 'tenant-attacker';
const SESSION_ID = 'cs-1';
const RESERVATION_ID = 'res-1';

const userOf = (tenantId, role = 'ADMIN') => ({ id: 'u-1', sub: 'u-1', role, tenantId });

/**
 * Drive the REAL router (param guard + handler chain) for one request.
 * Express matches on req.url, so this exercises exactly the production path.
 * The promise settles when the response is written or the chain falls through.
 */
function callRouter({ method, url, user, body = {} }) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: null, body: null };
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(res); } };

    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => {
      res.body = payload;
      if (res.statusCode === null) res.statusCode = 200;
      finish();
      return res;
    };

    const req = {
      method: method.toUpperCase(),
      url,
      originalUrl: `/api/checkout-sessions${url}`,
      baseUrl: '/api/checkout-sessions',
      params: {},
      query: {},
      body,
      user,
      ip: '127.0.0.1',
    };

    checkoutSessionRouter(req, res, (err) => {
      // Nothing on this router calls next() with an error today; if it ever
      // does, surface it rather than hanging the test.
      if (err) return reject(err);
      finish();
    });

    // Backstop so a silent hang fails loudly instead of timing out the suite.
    setTimeout(() => { if (!done) reject(new Error(`no response for ${method} ${url}`)); }, 2000).unref?.();
  });
}

// `prisma` is the `$extends()` result, whose model delegates are lazily built by
// a proxy rather than being own properties -- `mock.method` cannot see them. The
// repo's established workaround (fee-rates.routes.test.mjs, market-scrape-*.test.mjs)
// is to assign an own property that shadows the delegate, so that is what we do,
// restoring the originals after each test.
const ORIGINAL_DELEGATES = {
  checkoutSession: prisma.checkoutSession,
  reservation: prisma.reservation,
  // Shadowed by the create-path tests; restored with the rest so appending a
  // test later cannot inherit a stub (QA MINOR-4).
  rentalAgreement: prisma.rentalAgreement,
};

/** Trip-wire: set if any handler body runs. The guard must prevent this. */
let handlerReached = false;

/** Stub the session row the guard reads, plus the back-fill's update(). */
function stubSession({ tenantId, reservationId = RESERVATION_ID }) {
  prisma.checkoutSession = {
    findUnique: async () => ({ id: SESSION_ID, tenantId, reservationId }),
    // The guard back-fills a legacy null tenantId; harmless no-op here.
    update: async () => ({ id: SESSION_ID, tenantId, reservationId }),
  };
}

function armHandlerTripwire() {
  handlerReached = false;
  const trip = async () => { handlerReached = true; return {}; };
  for (const svc of [
    checkoutSessionService, vehicleSwapService, spinChargeService, customerInspectionService,
  ]) {
    for (const key of Object.keys(svc)) {
      if (typeof svc[key] === 'function') mock.method(svc, key, trip);
    }
  }
}

test.afterEach(() => {
  mock.restoreAll();
  Object.assign(prisma, ORIGINAL_DELEGATES);
});

// ---------------------------------------------------------------------------
// The reported hole: /transition
// ---------------------------------------------------------------------------

test('RED: a foreign tenant cannot transition another tenant’s checkout session', async () => {
  // Without the `:id` guard this reached transition() and, with toStep CLOSED,
  // ran the full finalize cascade on the other tenant.
  stubSession({ tenantId: OWNER });
  armHandlerTripwire();

  const res = await callRouter({
    method: 'post',
    url: `/${SESSION_ID}/transition`,
    user: userOf(ATTACKER),
    body: { toStep: 'CLOSED' },
  });

  assert.equal(handlerReached, false, 'the finalize cascade must never be reached cross-tenant');
  assert.equal(res.statusCode, 404, '404, not 403 -- a 403 confirms the id exists in another tenant');
});

test('the owning tenant still reaches transition (the guard is not a blanket refusal)', async () => {
  stubSession({ tenantId: OWNER });
  armHandlerTripwire();

  const res = await callRouter({
    method: 'post',
    url: `/${SESSION_ID}/transition`,
    user: userOf(OWNER),
    body: { toStep: 'CLOSED' },
  });

  assert.equal(handlerReached, true, 'the legitimate in-tenant checkout must be unaffected');
  assert.notEqual(res.statusCode, 404);
});

test('SUPER_ADMIN stays cross-tenant, matching getTenantScope', async () => {
  stubSession({ tenantId: OWNER });
  armHandlerTripwire();

  const res = await callRouter({
    method: 'post',
    url: `/${SESSION_ID}/transition`,
    user: userOf(ATTACKER, 'SUPER_ADMIN'),
    body: { toStep: 'CLOSED' },
  });

  assert.equal(handlerReached, true);
  assert.notEqual(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// The front door the `:id` guard cannot cover: POST /
//
// Found by Innovation review. Without the tenant gate in createForReservation,
// the guard above is decorative: an attacker POSTs a VICTIM's reservationId,
// the session is created stamped with the ATTACKER's tenantId, and from then on
// every `:id` route sees owner === caller and permits everything. The session is
// legitimately theirs; the reservation underneath it is not.
// ---------------------------------------------------------------------------

test('a foreign tenant cannot start a checkout session on another tenant’s reservation', async () => {
  const { checkoutSessionService: svc } = await import('./checkout-session.service.js');
  mock.restoreAll();

  let created = false;
  prisma.reservation = {
    findUnique: async () => ({
      id: RESERVATION_ID, tenantId: OWNER, vehicleId: 'veh-1',
      pickupAt: new Date(), returnAt: new Date(), workflowMode: 'RENTAL',
    }),
  };
  prisma.checkoutSession = {
    findUnique: async () => null,
    create: async () => { created = true; return {}; },
    update: async () => ({}),
  };

  await assert.rejects(
    () => svc.createForReservation({
      reservationId: RESERVATION_ID,
      tenantId: ATTACKER,
      actorUserId: 'u-1',
    }),
    (err) => {
      assert.equal(err.status, 404, '404, not 403 -- must not confirm the reservation exists elsewhere');
      return true;
    },
    'starting a checkout on another tenant’s reservation must be refused',
  );

  assert.equal(created, false, 'no session row may be minted over a foreign reservation');
});

test('the session is stamped with the RESERVATION’s tenant, not the caller’s', async () => {
  // Preferring the caller's tenantId is what allowed the mis-stamp above, and it
  // was also the ongoing source of the legacy tenantId=null rows the guard has
  // to tolerate. SUPER_ADMIN acting with no tenantId of their own is the case
  // that pins it.
  const { checkoutSessionService: svc } = await import('./checkout-session.service.js');
  mock.restoreAll();

  let stamped;
  prisma.reservation = {
    findUnique: async () => ({
      id: RESERVATION_ID, tenantId: OWNER, vehicleId: 'veh-1',
      pickupAt: new Date(), returnAt: new Date(), workflowMode: 'RENTAL',
    }),
    // ensureNoVehicleConflict's overlap + open-rental probes; no conflicts here.
    findFirst: async () => null,
    findMany: async () => [],
  };
  prisma.rentalAgreement = { findUnique: async () => ({ id: 'agr-1' }) };
  prisma.checkoutSession = {
    findUnique: async () => null,
    create: async ({ data }) => { stamped = data.tenantId; return { id: SESSION_ID, ...data }; },
    update: async () => ({}),
  };

  const session = await svc.createForReservation({
    reservationId: RESERVATION_ID,
    tenantId: null,
    actorUserId: 'u-1',
  });

  assert.equal(stamped, OWNER, 'the reservation is the source of truth for ownership');
  assert.equal(session.tenantId, OWNER);
});

test('a SUPER_ADMIN who HAS a tenantId can still start a checkout on another tenant', async () => {
  // QA MAJOR-1. backend/scripts/seed-dev.mjs:59 creates exactly this account
  // shape (SUPER_ADMIN *with* tenantId). getTenantScope falls back to that
  // tenant, so routing it into the create gate refused a super admin on every
  // other tenant's reservation -- with a 404 claiming the reservation does not
  // exist -- while the `:id` guard waved the same account through everywhere
  // else. This pins the two halves to the same meaning.
  let stamped;
  prisma.reservation = {
    findUnique: async () => ({
      id: RESERVATION_ID, tenantId: OWNER, vehicleId: 'veh-1',
      pickupAt: new Date(), returnAt: new Date(), workflowMode: 'RENTAL',
    }),
    findFirst: async () => null,
    findMany: async () => [],
  };
  prisma.rentalAgreement = { findUnique: async () => ({ id: 'agr-1' }) };
  prisma.checkoutSession = {
    findUnique: async () => null,
    create: async ({ data }) => { stamped = data.tenantId; return { id: SESSION_ID, ...data }; },
    update: async () => ({}),
  };

  const res = await callRouter({
    method: 'post',
    url: '/',
    // A super admin whose own tenant is ATTACKER, acting on an OWNER reservation.
    user: userOf(ATTACKER, 'SUPER_ADMIN'),
    body: { reservationId: RESERVATION_ID },
  });

  assert.notEqual(res.statusCode, 404, 'a super admin must not be refused cross-tenant');
  assert.equal(stamped, OWNER, 'and the session still belongs to the reservation’s tenant');
});

test('an existing session is not handed to a foreign caller via a null-tenant reservation', async () => {
  // QA MINOR-1. The create gate compares the RESERVATION's tenant; when that is
  // null the comparison passes for anyone, and this branch returned the
  // victim's live session verbatim (id, currentStep, agreementId, events log).
  const { checkoutSessionService: svc } = await import('./checkout-session.service.js');
  mock.restoreAll();

  prisma.reservation = {
    findUnique: async () => ({
      id: RESERVATION_ID, tenantId: null, vehicleId: 'veh-1',
      pickupAt: new Date(), returnAt: new Date(), workflowMode: 'RENTAL',
    }),
    findFirst: async () => null,
    findMany: async () => [],
  };
  prisma.checkoutSession = {
    findUnique: async () => ({
      id: 'cs-victim', tenantId: OWNER, currentStep: 'PAYMENT_PENDING', agreementId: 'agr-victim',
    }),
    create: async () => ({}),
    update: async () => ({}),
  };

  await assert.rejects(
    () => svc.createForReservation({
      reservationId: RESERVATION_ID, tenantId: ATTACKER, actorUserId: 'u-1',
    }),
    (err) => { assert.equal(err.status, 404); return true; },
    'a foreign caller must not adopt an existing session',
  );
});

// ---------------------------------------------------------------------------
// Drift net: EVERY `:id` route, not just the one that was reported
// ---------------------------------------------------------------------------

/** Enumerate every route on the live router stack, param or not. */
function everyRoute() {
  const out = [];
  for (const layer of checkoutSessionRouter.stack || []) {
    const route = layer.route;
    if (!route?.path) continue;
    for (const method of Object.keys(route.methods || {})) {
      if (route.methods[method]) out.push({ method, path: route.path });
    }
  }
  return out;
}

const everyIdRoute = () => everyRoute().filter((r) => r.path.includes(':id'));

/**
 * Routes that address a row by a param OTHER than `:id`, and so are outside the
 * `router.param('id')` guard. Each needs its own scoping, and adding one here is
 * a deliberate act — the test below fails on any new param name, rather than
 * silently ignoring it the way a `.includes(':id')` filter would.
 */
const NON_ID_PARAM_ROUTES = new Set([
  // Scoped by getTenantScope + the tenantless floor; covered by its own test above.
  '/by-reservation/:reservationId',
]);

test('no route addresses a row by a param the `:id` guard does not cover', async () => {
  const stray = everyRoute()
    .filter(({ path }) => path.includes(':') && !path.includes(':id'))
    .filter(({ path }) => !NON_ID_PARAM_ROUTES.has(path));

  assert.deepEqual(
    stray, [],
    'these routes take a param that router.param(\'id\') never fires for — scope them, '
    + 'then add them to NON_ID_PARAM_ROUTES with the reason',
  );
});

test('every `:id` route on the router refuses a foreign tenant', async () => {
  const routes = everyIdRoute();
  // Sanity: if this ever reads 0, the enumeration broke and the loop is vacuous.
  assert.ok(routes.length >= 14, `expected the router's :id surface, got ${routes.length}`);

  for (const { method, path } of routes) {
    stubSession({ tenantId: OWNER });
    armHandlerTripwire();

    const res = await callRouter({
      method,
      url: path.replace(':id', SESSION_ID),
      user: userOf(ATTACKER),
    });

    assert.equal(
      handlerReached, false,
      `${method.toUpperCase()} ${path} reached its handler cross-tenant -- not covered by the guard`,
    );
    assert.equal(res.statusCode, 404, `${method.toUpperCase()} ${path} must refuse a foreign tenant`);
    mock.restoreAll();
    Object.assign(prisma, ORIGINAL_DELEGATES);
  }
});

// ---------------------------------------------------------------------------
// Legacy Phase 1 sessions (CheckoutSession.tenantId = null)
// ---------------------------------------------------------------------------

test('a legacy null-tenant session is attributed via its reservation and still refuses a foreigner', async () => {
  stubSession({ tenantId: null });
  prisma.reservation = { findUnique: async () => ({ tenantId: OWNER }) };
  armHandlerTripwire();

  const res = await callRouter({
    method: 'post',
    url: `/${SESSION_ID}/transition`,
    user: userOf(ATTACKER),
    body: { toStep: 'CLOSED' },
  });

  assert.equal(handlerReached, false, 'a null tenantId must not be a way around the guard');
  assert.equal(res.statusCode, 404);
});

test('a legacy null-tenant session still works for its rightful owner (no mid-checkout 404)', async () => {
  // The reason this is a soft check and not `where: { id, tenantId }`: Phase 1
  // sessions ran with tenantId=null, and hard-scoping would strand a live
  // checkout. Mirrors the back-fill getByReservationId already does.
  stubSession({ tenantId: null });
  prisma.reservation = { findUnique: async () => ({ tenantId: OWNER }) };
  armHandlerTripwire();

  const res = await callRouter({
    method: 'post',
    url: `/${SESSION_ID}/transition`,
    user: userOf(OWNER),
    body: { toStep: 'CLOSED' },
  });

  assert.equal(handlerReached, true, 'the rightful owner must not be locked out of a legacy session');
});

// ---------------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------------

test('a non-super-admin with no tenantId addresses nothing (fail closed)', async () => {
  // Same posture as lib/tenant-scope.js's DENY_ALL_SCOPE. 403 rather than 404
  // because the router-level floor refuses this caller before any id is
  // resolved — there is no row whose existence a status could leak yet.
  stubSession({ tenantId: OWNER });
  armHandlerTripwire();

  const res = await callRouter({
    method: 'post',
    url: `/${SESSION_ID}/transition`,
    user: userOf(null),
    body: { toStep: 'CLOSED' },
  });

  assert.equal(handlerReached, false);
  assert.equal(res.statusCode, 403);
});

test('the tenantless floor also covers /by-reservation, which the `:id` guard cannot reach', async () => {
  // The regression Innovation caught: getTenantScope returns null for this
  // caller, and null means "no filter" downstream (getByReservationId skips its
  // ownership check entirely), so this route read across tenants.
  armHandlerTripwire();

  const res = await callRouter({
    method: 'get',
    url: `/by-reservation/${RESERVATION_ID}`,
    user: userOf(null),
  });

  assert.equal(handlerReached, false, 'a tenantless caller must not reach the service');
  assert.equal(res.statusCode, 403);
});

test('an unknown session id is a plain 404', async () => {
  prisma.checkoutSession = { findUnique: async () => null, update: async () => ({}) };
  armHandlerTripwire();

  const res = await callRouter({
    method: 'post',
    url: '/does-not-exist/transition',
    user: userOf(OWNER),
    body: { toStep: 'CLOSED' },
  });

  assert.equal(handlerReached, false);
  assert.equal(res.statusCode, 404);
});
