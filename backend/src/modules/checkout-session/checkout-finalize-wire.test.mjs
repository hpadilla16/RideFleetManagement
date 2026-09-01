/**
 * FINALIZE_INCOMPLETE, as it appears ON THE WIRE (2026-08-17).
 * Run: npm run test:checkout-finalize-truth (same script — both files).
 *
 * checkout-finalize-truth.test.mjs drives the SERVICE, so it can assert that a
 * failed finalize throws `{ code: 'FINALIZE_INCOMPLETE', reason: 'VEHICLE_CONFLICT' }`
 * — and would keep passing if the router stopped serializing `reason`.
 *
 * That matters more than a missing-coverage note usually does. Folding four
 * distinct guard failures (VEHICLE_CONFLICT, NO_VEHICLE_ASSIGNED,
 * PRECHECKIN_REQUIRED, AGE_RULES_*) into ONE code is only defensible because
 * the specific reason survives in an additive member. `reason` is that member,
 * `handleError` is its only serialization point, and RideOps is supposed to
 * branch on it. Delete the spread and every other test in the tree still
 * passes while the granularity silently disappears.
 *
 * Handler-level, no DB and no app boot: pull the real handler out of the router
 * stack and invoke it with a mock req/res, stubbing the service to throw. Same
 * introspection pattern as reservations/open-rental-409.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutSessionRouter } from './checkout-session.routes.js';
import { checkoutSessionService, CheckoutSessionError } from './checkout-session.service.js';

/** Pull the terminal handler for a method+path out of the Express router stack. */
function handlerFor(method, path) {
  for (const layer of checkoutSessionRouter.stack || []) {
    const route = layer.route;
    if (!route || route.path !== path) continue;
    if (!route.methods?.[method]) continue;
    const handlers = (route.stack || []).map((h) => h.handle).filter((h) => typeof h === 'function');
    return handlers[handlers.length - 1];
  }
  return null;
}

/** Minimal Express res double that records status + body. */
function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

const USER = { sub: 'user-1', tenantId: 'tenant-1', role: 'ADMIN', email: 'a@x.com' };

async function postTransition(thrown) {
  const handler = handlerFor('post', '/:id/transition');
  assert.ok(handler, 'the transition route is still POST /:id/transition');

  const orig = checkoutSessionService.transition;
  checkoutSessionService.transition = async () => { throw thrown; };
  try {
    const res = mockRes();
    await handler(
      { params: { id: 'cs1' }, body: { toStep: 'CLOSED' }, user: USER, headers: {}, query: {} },
      res,
      (err) => { throw err; },
    );
    return res;
  } finally {
    checkoutSessionService.transition = orig;
  }
}

test('FINALIZE_INCOMPLETE serializes its reason to the client', async () => {
  const err = new CheckoutSessionError(
    'Checkout is closed but its finalize did not complete: Vehicle is still out on open rental R-2',
    409,
    'FINALIZE_INCOMPLETE',
  );
  err.reason = 'VEHICLE_CONFLICT';

  const res = await postTransition(err);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'FINALIZE_INCOMPLETE');
  // The assertion the service-level suite structurally cannot make.
  assert.equal(res.body.reason, 'VEHICLE_CONFLICT');
  assert.match(res.body.error, /still out on open rental R-2/);
});

test('the reason member is ADDITIVE — absent on every error that does not set it', async () => {
  // The contract promised to existing clients (same shape as `session`, added
  // by M2-P2 yesterday): a caller that has never heard of `reason` sees exactly
  // the body it saw before.
  const res = await postTransition(
    new CheckoutSessionError('Illegal transition PAID → TC_PENDING', 409, 'ILLEGAL_TRANSITION'),
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'ILLEGAL_TRANSITION');
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error']);
});
