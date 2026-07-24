import test from 'node:test';
import assert from 'node:assert/strict';
import {
  userAllowedLocationIds,
  userProgramScope,
  scopeVisibilityCacheSegment,
  effectiveLocationIds,
  scopeAllowedLocationIds,
  reservationLocationWhere,
  systemScope,
} from './tenant-scope.js';

// Location scoping (Fase 2). null = ALL locations (no restriction).
test('SUPER_ADMIN bypasses → null (all)', () => {
  assert.equal(userAllowedLocationIds({ role: 'SUPER_ADMIN', locationIds: ['A'] }), null);
});

// ADMIN (2026-07-23): a plain tenant admin (no locationIds) still sees everything,
// but an admin assigned explicit locations is a LOCATION admin and is scoped to them.
// Before this, assigning locationIds to an ADMIN silently did nothing — the
// assignment looked applied in the UI while the user still saw the whole tenant.
test('ADMIN with NO locationIds → null (tenant-wide, unchanged)', () => {
  assert.equal(userAllowedLocationIds({ role: 'ADMIN' }), null);
  assert.equal(userAllowedLocationIds({ role: 'ADMIN', locationIds: [] }), null);
});

test('ADMIN WITH locationIds → scoped to them (location admin)', () => {
  assert.deepEqual(userAllowedLocationIds({ role: 'ADMIN', locationIds: ['A', 'B'] }), ['A', 'B']);
  assert.deepEqual(userAllowedLocationIds({ role: 'ADMIN', locationIds: ['LAX'] }), ['LAX']);
});

test('OPS restricted to its assigned locations', () => {
  assert.deepEqual(userAllowedLocationIds({ role: 'OPS', locationIds: ['A', 'B'] }), ['A', 'B']);
});

test('AGENT with a single location', () => {
  assert.deepEqual(userAllowedLocationIds({ role: 'AGENT', locationIds: ['L1'] }), ['L1']);
});

test('empty locationIds → null (all)', () => {
  assert.equal(userAllowedLocationIds({ role: 'OPS', locationIds: [] }), null);
});

test('null/absent locationIds → null (all)', () => {
  assert.equal(userAllowedLocationIds({ role: 'OPS', locationIds: null }), null);
  assert.equal(userAllowedLocationIds({ role: 'OPS' }), null);
});

test('falsy ids are filtered out', () => {
  assert.deepEqual(userAllowedLocationIds({ role: 'AGENT', locationIds: ['A', '', null, 'B'] }), ['A', 'B']);
});

test('missing user → null (all)', () => {
  assert.equal(userAllowedLocationIds(null), null);
});

// Program scoping (2026-07-02). null = no restriction. Mirrors the location
// bypass matrix above: ADMIN/SUPER_ADMIN always bypass, BOTH is a no-op.
test('programScope: SUPER_ADMIN bypasses → null even with RENTAL_ONLY set', () => {
  assert.equal(userProgramScope({ role: 'SUPER_ADMIN', programScope: 'RENTAL_ONLY' }), null);
});

test('programScope: ADMIN bypasses → null even with LOANER_ONLY set', () => {
  assert.equal(userProgramScope({ role: 'ADMIN', programScope: 'LOANER_ONLY' }), null);
});

test('programScope: OPS restricted to RENTAL_ONLY', () => {
  assert.equal(userProgramScope({ role: 'OPS', programScope: 'RENTAL_ONLY' }), 'RENTAL_ONLY');
});

test('programScope: AGENT restricted to LOANER_ONLY', () => {
  assert.equal(userProgramScope({ role: 'AGENT', programScope: 'LOANER_ONLY' }), 'LOANER_ONLY');
});

test('programScope: BOTH (default) → null (no restriction)', () => {
  assert.equal(userProgramScope({ role: 'AGENT', programScope: 'BOTH' }), null);
});

test('programScope: absent/null/unknown values → null (fail-open like BOTH)', () => {
  assert.equal(userProgramScope({ role: 'AGENT' }), null);
  assert.equal(userProgramScope({ role: 'AGENT', programScope: null }), null);
  assert.equal(userProgramScope({ role: 'AGENT', programScope: 'GARBAGE' }), null);
});

test('programScope: missing user → null', () => {
  assert.equal(userProgramScope(null), null);
});

test('programScope: also resolves an already-resolved scope shape (no role)', () => {
  // rental-agreements passes req.user OR a resolved scope; both must work.
  assert.equal(userProgramScope({ programScope: 'RENTAL_ONLY' }), 'RENTAL_ONLY');
  assert.equal(userProgramScope({ programScope: 'LOANER_ONLY' }), 'LOANER_ONLY');
});

// Cache-key visibility segment (2026-07-02) — used by reservations list/summary
// cache keys so a program/location-scoped employee never shares an entry with
// an admin.
test('scopeVisibilityCacheSegment: unrestricted scope → ALL:ALL', () => {
  assert.equal(scopeVisibilityCacheSegment({}), 'ALL:ALL');
  assert.equal(scopeVisibilityCacheSegment(null), 'ALL:ALL');
  assert.equal(scopeVisibilityCacheSegment({ programScope: null, allowedLocationIds: null }), 'ALL:ALL');
});

test('scopeVisibilityCacheSegment: program + locations folded in, locations sorted', () => {
  assert.equal(
    scopeVisibilityCacheSegment({ programScope: 'RENTAL_ONLY', allowedLocationIds: ['B', 'A'] }),
    'RENTAL_ONLY:A,B'
  );
  // Deterministic regardless of input ordering.
  assert.equal(
    scopeVisibilityCacheSegment({ programScope: 'RENTAL_ONLY', allowedLocationIds: ['A', 'B'] }),
    scopeVisibilityCacheSegment({ programScope: 'RENTAL_ONLY', allowedLocationIds: ['B', 'A'] })
  );
});

test('scopeVisibilityCacheSegment: unknown program values collapse to ALL, empty/falsy locations to ALL', () => {
  assert.equal(scopeVisibilityCacheSegment({ programScope: 'GARBAGE', allowedLocationIds: [] }), 'ALL:ALL');
  assert.equal(scopeVisibilityCacheSegment({ programScope: 'LOANER_ONLY', allowedLocationIds: ['', null, 'L1'] }), 'LOANER_ONLY:L1');
});

// effectiveLocationIds (2026-07-23) — the allowed ∩ requested intersection every
// location-filtered service composes into its `where`. Pure; the whole point of
// hoisting it out of the modules was to be able to pin the invariant here.
test('effectiveLocationIds: unrestricted caller → null, or the requested filter verbatim', () => {
  assert.equal(effectiveLocationIds({}, {}), null, 'no scope, no filter = no restriction');
  assert.equal(effectiveLocationIds({}, { allowedLocationIds: [] }), null);
  assert.equal(effectiveLocationIds({}, { allowedLocationIds: null }), null);
  assert.deepEqual(effectiveLocationIds({ locationId: 'L1' }, {}), ['L1'], 'plain filter still honored');
});

test('effectiveLocationIds: scoped caller with no filter → their own locations', () => {
  assert.deepEqual(effectiveLocationIds({}, { allowedLocationIds: ['A', 'B'] }), ['A', 'B']);
});

test('effectiveLocationIds: a filter INSIDE the allowed set narrows to it', () => {
  assert.deepEqual(effectiveLocationIds({ locationId: 'B' }, { allowedLocationIds: ['A', 'B'] }), ['B']);
});

test('effectiveLocationIds: a filter OUTSIDE the allowed set never widens the scope', () => {
  // THE security invariant: ?locationId=<someone else's branch> must not be
  // honored — the caller falls back to their own locations, never to the
  // requested one and never to null.
  assert.deepEqual(effectiveLocationIds({ locationId: 'Z' }, { allowedLocationIds: ['A'] }), ['A']);
});

test('effectiveLocationIds: falsy ids are stripped, not treated as a restriction', () => {
  // [null] must read as "unrestricted", not as a filter matching nothing —
  // half-normalized input is how a scoped caller ends up reading whole-tenant
  // rollups while their live query returns zero rows.
  assert.equal(effectiveLocationIds({}, { allowedLocationIds: [null, ''] }), null);
  assert.deepEqual(effectiveLocationIds({}, { allowedLocationIds: [null, 'A'] }), ['A']);
});

test('effectiveLocationIds: non-string ids are coerced, missing args are safe', () => {
  assert.deepEqual(effectiveLocationIds({ locationId: 7 }, {}), ['7']);
  assert.equal(effectiveLocationIds(undefined, undefined), null);
});

// scopeAllowedLocationIds (2026-07-24) — the `scope` half of
// effectiveLocationIds, split out for callers that must NOT intersect with a
// ?locationId (planner's reservation filter ORs the selection across three
// columns and ANDs the restriction on top). Pinned separately because the four
// inline copies it replaced had all dropped the .filter(Boolean).
test('scopeAllowedLocationIds: unrestricted shapes all collapse to null', () => {
  assert.equal(scopeAllowedLocationIds({}), null);
  assert.equal(scopeAllowedLocationIds(undefined), null);
  assert.equal(scopeAllowedLocationIds({ allowedLocationIds: null }), null);
  assert.equal(scopeAllowedLocationIds({ allowedLocationIds: [] }), null);
  assert.equal(scopeAllowedLocationIds({ allowedLocationIds: 'A' }), null, 'a non-array is not a restriction');
});

test('scopeAllowedLocationIds: falsy ids are stripped', () => {
  // THE drift the hoist fixed. `[null]` must mean "unrestricted", not a
  // `{ in: [null] }` filter — that shape matches only rows whose location is
  // NULL, so a scoped user would see an empty screen with no error to explain it.
  assert.equal(scopeAllowedLocationIds({ allowedLocationIds: [null, '', undefined] }), null);
  assert.deepEqual(scopeAllowedLocationIds({ allowedLocationIds: [null, 'A'] }), ['A']);
});

test('scopeAllowedLocationIds: a real restriction passes through', () => {
  assert.deepEqual(scopeAllowedLocationIds({ allowedLocationIds: ['A', 'B'] }), ['A', 'B']);
});

test('scopeAllowedLocationIds: does not mutate the caller scope', () => {
  const scope = { allowedLocationIds: [null, 'A'] };
  scopeAllowedLocationIds(scope);
  assert.deepEqual(scope.allowedLocationIds, [null, 'A'], 'filter() must return a new array');
});

test('effectiveLocationIds with no selection === scopeAllowedLocationIds', () => {
  // The two must not drift again: with no ?locationId, "effective" IS "allowed".
  for (const ids of [null, [], ['A'], ['A', 'B'], [null, 'A']]) {
    const scope = { allowedLocationIds: ids };
    assert.deepEqual(effectiveLocationIds({}, scope), scopeAllowedLocationIds(scope));
  }
});

// reservationLocationWhere (2026-07-24) — the reservation-shaped gate. It is the
// SOLE authorization check for listReservationTolls and for confirmMatch's target
// reservation, so its shape is pinned here.
test('reservationLocationWhere: unrestricted callers get an EMPTY fragment', () => {
  assert.deepEqual(reservationLocationWhere({}), {});
  assert.deepEqual(reservationLocationWhere({ allowedLocationIds: null }), {});
  assert.deepEqual(reservationLocationWhere({ allowedLocationIds: [] }), {});
  assert.deepEqual(reservationLocationWhere({ allowedLocationIds: [null, ''] }), {});
});

test('reservationLocationWhere: EITHER endpoint matching is enough', () => {
  // OR, not AND. A one-way rental belongs to both the branch that hands the car
  // out and the branch that takes it back; an AND here would hide every one-way
  // from both of them.
  assert.deepEqual(reservationLocationWhere({ allowedLocationIds: ['A'] }), {
    OR: [{ pickupLocationId: { in: ['A'] } }, { returnLocationId: { in: ['A'] } }],
  });
});

test('reservationLocationWhere: does NOT reach through the vehicle', () => {
  // Which branch a car is garaged at says nothing about who rented it out.
  const frag = JSON.stringify(reservationLocationWhere({ allowedLocationIds: ['A'] }));
  assert.ok(!frag.includes('homeLocationId'), 'must not use the vehicle home hop');
  assert.ok(!frag.includes('vehicle'), 'must not join the vehicle at all');
});

// systemScope (2026-07-24) — a DELIBERATE privilege elevation. If a future edit
// made this return {} unconditionally, every hydration/reconciliation site would
// silently go CROSS-TENANT. That is the failure these tests exist to catch.
test('systemScope: keeps the tenant boundary — never returns a bare {}', () => {
  assert.deepEqual(systemScope({ tenantId: 'T1', allowedLocationIds: ['A'] }), { tenantId: 'T1' });
  assert.deepEqual(systemScope({ tenantId: 'T1' }), { tenantId: 'T1' });
});

test('systemScope: strips location AND program restrictions, nothing else', () => {
  const out = systemScope({ tenantId: 'T1', allowedLocationIds: ['A'], programScope: 'RENTAL_ONLY', allowCrossTenant: false });
  assert.deepEqual(Object.keys(out), ['tenantId'], 'exactly one key');
  assert.equal(out.allowedLocationIds, undefined);
  assert.equal(out.programScope, undefined);
});

test('systemScope: a SUPER_ADMIN scope ({}) stays tenant-less, not cross-tenant-by-accident', () => {
  // scopeFor returns {} for a super-admin with no ?tenantId. tenantId:null then
  // makes `tenantWhereForScope` emit NO tenant filter — which is correct for a
  // cross-tenant caller and must not be "fixed" into a deny-all.
  assert.deepEqual(systemScope({}), { tenantId: null });
  assert.deepEqual(systemScope(undefined), { tenantId: null });
  assert.deepEqual(systemScope(null), { tenantId: null });
});

test('systemScope: the deny-all sentinel is PRESERVED, not elevated away', () => {
  // A non-super-admin with no tenantId gets { tenantId: '__no_tenant__' } from
  // resolveTenantScopedUser. Elevation must never turn a fail-closed scope into
  // an unfiltered one.
  assert.deepEqual(systemScope({ tenantId: '__no_tenant__', allowedLocationIds: ['A'] }), { tenantId: '__no_tenant__' });
});
