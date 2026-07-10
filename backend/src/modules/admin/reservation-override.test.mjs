// Reservation status override — access-control contract (round 26; role widened
// 2026-07-10). The router is mounted with requireRole('ADMIN','SUPER_ADMIN'), and
// requireRole's isSuperAdmin bypass means SUPER_ADMIN always passes. This test
// pins that contract: ADMIN + SUPER_ADMIN are accepted, AGENT/OPS get 403. It also
// asserts the router actually exposes PATCH /:id/status + GET /:id/override-preview
// so the gate is guarding the routes we think it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { requireRole } from '../../middleware/auth.js';
import { reservationOverrideRouter } from './reservation-override.routes.js';

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// Exercise the exact mount gate used in main.js.
const gate = requireRole('ADMIN', 'SUPER_ADMIN');
function runGate(user) {
  let nextCalled = false;
  const res = fakeRes();
  gate({ user }, res, () => { nextCalled = true; });
  return { nextCalled, res };
}

test('mount gate: SUPER_ADMIN passes (isSuperAdmin bypass)', () => {
  const r = runGate({ role: 'SUPER_ADMIN' });
  assert.equal(r.nextCalled, true);
});

test('mount gate: ADMIN now passes (widened 2026-07-10)', () => {
  const r = runGate({ role: 'ADMIN' });
  assert.equal(r.nextCalled, true);
});

test('mount gate: AGENT is 403', () => {
  const r = runGate({ role: 'AGENT' });
  assert.equal(r.nextCalled, false);
  assert.equal(r.res.statusCode, 403);
});

test('mount gate: OPS is 403', () => {
  const r = runGate({ role: 'OPS' });
  assert.equal(r.nextCalled, false);
  assert.equal(r.res.statusCode, 403);
});

test('mount gate: unauthenticated is 401', () => {
  const r = runGate(undefined);
  assert.equal(r.nextCalled, false);
  assert.equal(r.res.statusCode, 401);
});

test('router exposes the guarded status-override routes', () => {
  const paths = reservationOverrideRouter.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`);
  assert.ok(paths.includes('PATCH /:id/status'), `missing PATCH /:id/status (got ${paths.join(' | ')})`);
  assert.ok(paths.includes('GET /:id/override-preview'), `missing GET /:id/override-preview (got ${paths.join(' | ')})`);
});
