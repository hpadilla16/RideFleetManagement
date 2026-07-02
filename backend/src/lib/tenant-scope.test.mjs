import test from 'node:test';
import assert from 'node:assert/strict';
import { userAllowedLocationIds, userProgramScope, scopeVisibilityCacheSegment } from './tenant-scope.js';

// Location scoping (Fase 2). null = ALL locations (no restriction).
test('SUPER_ADMIN bypasses → null (all)', () => {
  assert.equal(userAllowedLocationIds({ role: 'SUPER_ADMIN', locationIds: ['A'] }), null);
});

test('ADMIN bypasses → null (all) even with locationIds set', () => {
  assert.equal(userAllowedLocationIds({ role: 'ADMIN', locationIds: ['A', 'B'] }), null);
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
