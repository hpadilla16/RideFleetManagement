/**
 * Regression tests: a service error carrying an explicit 4xx `statusCode` must be
 * returned as that status, NOT swallowed into a 500.
 *
 * BUG (Sentry -1P x2: the reservations PATCH and pre-check-in staff-complete):
 * `ensureNoVehicleConflict` has TWO guards and both set `err.statusCode = 409`.
 * The date-overlap guard's message ("Vehicle conflict with reservation …") happens
 * to match the route's `/vehicle conflict/i` string test, so it mapped to 409. The
 * open-rental guard (added 2026-06-04) throws "Vehicle is still out on open rental
 * … — complete its check-in (or swap vehicles) first", which does NOT match that
 * regex — so it fell through to `next(e)` and surfaced as a 500. staff-complete had
 * no mapping at all, and `reservationsService.update` re-validates the assigned
 * vehicle on EVERY patch, so completing pre-check-in on a car still out on an open
 * rental 500'd too.
 *
 * FIX: `sendExplicitStatusError(res, e)` in reservations.routes.js — honor an
 * explicit 4xx statusCode set by the service layer, ahead of any message matching.
 *
 * Handler-level, no DB and no app boot: pull the real handler out of the router
 * stack (same introspection pattern as route-handlers-defined.test.mjs) and invoke
 * it with a mock req/res while stubbing the service to throw the real guard error.
 * Both throw paths bail before any DB write, so nothing here touches Postgres.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { reservationsRouter } from './reservations.routes.js';
import { reservationsService } from './reservations.service.js';

/** Pull the terminal handler for a method+path out of the Express router stack. */
function handlerFor(method, path) {
  for (const layer of reservationsRouter.stack || []) {
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

/** The exact error ensureNoVehicleConflict's open-rental guard throws. */
function openRentalError() {
  const err = new Error(
    'Vehicle is still out on open rental RES-819679 — complete its check-in (or swap vehicles) first'
  );
  err.statusCode = 409;
  return err;
}

const USER = { sub: 'user-1', tenantId: 'tenant-1', role: 'ADMIN', email: 'a@x.com' };
const CURRENT = {
  id: 'res-1',
  tenantId: 'tenant-1',
  customerId: 'cust-1',
  status: 'CONFIRMED',
  notes: null,
  pickupAt: new Date(Date.now() + 86400e3),
  returnAt: new Date(Date.now() + 2 * 86400e3),
  // LAX #5 (2026-07-28): staff-complete now enforces the pre-check-in
  // completeness bar on the merged customer state BEFORE reaching the service.
  // These fixtures carry a COMPLETE customer so the 409-mapping tests still
  // exercise the service-throw path; the incompleteness path has its own test.
  customer: {
    firstName: 'Open', lastName: 'Rental', email: 'a@x.com', phone: '7875550100',
    dateOfBirth: new Date('1990-01-15'), licenseNumber: 'L-123', licenseState: 'PR',
    address1: '1 Main St', city: 'San Juan', state: 'PR', zip: '00901', country: 'US',
    hasIdPhoto: true
  }
};

test.afterEach(() => mock.restoreAll());

test('the open-rental guard error is exposed by the router (regex would not match it)', () => {
  // Pins the root cause: the message the guard throws does NOT match the string
  // test the route relied on, so message-matching alone can never map it to 409.
  assert.equal(/vehicle conflict/i.test(openRentalError().message), false);
});

test('PATCH /:id returns 409 (not 500) when the service throws statusCode 409', async () => {
  const handler = handlerFor('patch', '/:id');
  assert.ok(handler, 'PATCH /:id handler must be registered');

  mock.method(reservationsService, 'getById', async () => CURRENT);
  mock.method(reservationsService, 'update', async () => { throw openRentalError(); });

  const res = mockRes();
  let nextErr = 'NOT_CALLED';
  await handler(
    { params: { id: 'res-1' }, body: { vehicleId: 'veh-b' }, query: {}, user: USER },
    res,
    (e) => { nextErr = e; }
  );

  assert.equal(res.statusCode, 409, 'open-rental conflict must surface as 409, not fall through to a 500');
  assert.match(res.body?.error || '', /still out on open rental/);
  assert.equal(nextErr, 'NOT_CALLED', 'must not fall through to next(e) (that is what produced the 500)');
});

test('POST /:id/precheckin/staff-complete returns 409 (not 500) when the service throws statusCode 409', async () => {
  const handler = handlerFor('post', '/:id/precheckin/staff-complete');
  assert.ok(handler, 'staff-complete handler must be registered');

  mock.method(reservationsService, 'getById', async () => CURRENT);
  mock.method(reservationsService, 'update', async () => { throw openRentalError(); });

  const res = mockRes();
  let nextErr = 'NOT_CALLED';
  await handler(
    { params: { id: 'res-1' }, body: {}, query: {}, user: USER },
    res,
    (e) => { nextErr = e; }
  );

  assert.equal(res.statusCode, 409, 'staff-complete must surface the guard as 409, not a 500');
  assert.match(res.body?.error || '', /still out on open rental/);
  assert.equal(nextErr, 'NOT_CALLED', 'must not fall through to next(e) (that is what produced the 500)');
});

test('an error code, when present, rides along with the 4xx', async () => {
  const handler = handlerFor('post', '/:id/precheckin/staff-complete');
  mock.method(reservationsService, 'getById', async () => CURRENT);
  mock.method(reservationsService, 'update', async () => {
    const err = new Error('Nope');
    err.statusCode = 422;
    err.code = 'NO_VEHICLE_ASSIGNED';
    throw err;
  });

  const res = mockRes();
  await handler({ params: { id: 'res-1' }, body: {}, query: {}, user: USER }, res, () => {});

  assert.equal(res.statusCode, 422);
  assert.equal(res.body?.code, 'NO_VEHICLE_ASSIGNED');
});

test('LAX #5: an incomplete customer profile → 400 PRECHECKIN_FIELDS_MISSING before the service is reached', async () => {
  const handler = handlerFor('post', '/:id/precheckin/staff-complete');
  const incomplete = { ...CURRENT, customer: { firstName: 'Only', lastName: 'Name', hasIdPhoto: false } };
  mock.method(reservationsService, 'getById', async () => incomplete);
  let serviceHit = false;
  mock.method(reservationsService, 'update', async () => { serviceHit = true; return incomplete; });

  const res = mockRes();
  await handler({ params: { id: 'res-1' }, body: {}, query: {}, user: USER }, res, () => {});

  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.code, 'PRECHECKIN_FIELDS_MISSING');
  assert.ok(Array.isArray(res.body?.missing) && res.body.missing.includes('email'));
  assert.equal(serviceHit, false, 'completeness gate must fire before any write');
});

test('5xx and code-less errors still fall through to next(e) (error middleware keeps its job)', async () => {
  const handler = handlerFor('post', '/:id/precheckin/staff-complete');
  mock.method(reservationsService, 'getById', async () => CURRENT);
  const boom = new Error('database exploded');
  boom.statusCode = 500;
  mock.method(reservationsService, 'update', async () => { throw boom; });

  const res = mockRes();
  let nextErr = null;
  await handler({ params: { id: 'res-1' }, body: {}, query: {}, user: USER }, res, (e) => { nextErr = e; });

  assert.equal(res.statusCode, null, 'a genuine 500 must not be rewritten by the 4xx mapper');
  assert.equal(nextErr, boom, 'genuine failures still reach the error middleware');
});
