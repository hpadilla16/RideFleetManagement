/**
 * Unit tests for the tolls tenant-wide-operation guard. No DB.
 *
 * WHY THIS EXISTS: `rejectLocationScopedUsers` is the only thing standing
 * between a location-restricted account and tenant-wide toll operations —
 * bulk-auto-match (rewrites vehicleId/reservationId/status across every pending
 * row) and the provider-account/sync/manual-import routes (which run the same
 * import pipeline and create TOLL_MODULE charges on reservations at every
 * branch). Those operations cannot be meaningfully narrowed to one branch, so
 * they are refused rather than scoped.
 *
 * `requireRole('ADMIN','OPS')` does NOT cover this: since 2026-07-23 an ADMIN
 * WITH locationIds is a LOCATION admin and passes the role check. That is the
 * case test 2 pins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The routes module transitively imports lib/prisma.js, which constructs a
// PrismaClient at import time. Nothing here touches the DB — the guard is pure.
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';
const { rejectLocationScopedUsers } = await import('./tolls.routes.js');

function runGuard(user) {
  const calls = { status: null, json: null, nextCalled: false };
  const res = {
    status(code) { calls.status = code; return this; },
    json(body) { calls.json = body; return this; },
  };
  rejectLocationScopedUsers({ user }, res, () => { calls.nextCalled = true; });
  return calls;
}

test('a location-restricted OPS user is refused with 403', () => {
  const out = runGuard({ role: 'OPS', tenantId: 'T1', locationIds: ['LOC-A'] });
  assert.equal(out.nextCalled, false, 'the request must NOT reach the tenant-wide operation');
  assert.equal(out.status, 403);
  assert.match(out.json.error, /location-restricted/i);
});

test('an ADMIN WITH locationIds is a LOCATION admin — also refused', () => {
  // The case requireRole cannot see. Before 2026-07-23 ADMIN bypassed location
  // scoping unconditionally; now an admin assigned explicit locations is the
  // admin OF that branch and must not run tenant-wide toll operations.
  const out = runGuard({ role: 'ADMIN', tenantId: 'T1', locationIds: ['LOC-A'] });
  assert.equal(out.nextCalled, false);
  assert.equal(out.status, 403);
});

test('an ordinary tenant ADMIN (no locationIds) passes through', () => {
  const out = runGuard({ role: 'ADMIN', tenantId: 'T1', locationIds: [] });
  assert.equal(out.nextCalled, true);
  assert.equal(out.status, null);
});

test('SUPER_ADMIN is never location-restricted', () => {
  const out = runGuard({ role: 'SUPER_ADMIN', locationIds: ['LOC-A'] });
  assert.equal(out.nextCalled, true);
});

test('falsy location ids do not trip the guard', () => {
  // `[null]` means unrestricted, matching scopeAllowedLocationIds. Tripping here
  // would lock a user out of toll sync with a message that explains nothing.
  const out = runGuard({ role: 'OPS', tenantId: 'T1', locationIds: [null, ''] });
  assert.equal(out.nextCalled, true);
});

test('a program-restricted (but not location-restricted) user still passes', () => {
  // This guard is about LOCATION only — program scoping is a separate axis and
  // is not a reason to refuse a tenant-wide toll operation.
  const out = runGuard({ role: 'OPS', tenantId: 'T1', programScope: 'RENTAL_ONLY' });
  assert.equal(out.nextCalled, true);
});
