import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from './people.service.js';
const f = _internal.allowedRoleForPayload;

test('employee can be promoted to ADMIN (regression: used to silently downgrade to AGENT)', () => {
  assert.equal(f('EMPLOYEE', 'ADMIN'), 'ADMIN');
});
test('employee OPS/AGENT honored; default AGENT', () => {
  assert.equal(f('EMPLOYEE', 'OPS'), 'OPS');
  assert.equal(f('EMPLOYEE', 'AGENT'), 'AGENT');
  assert.equal(f('EMPLOYEE', undefined), 'AGENT');
});
test('personType ADMIN always ADMIN', () => {
  assert.equal(f('ADMIN', 'AGENT'), 'ADMIN');
});
test('hosts can never be ADMIN (capped to OPS/AGENT)', () => {
  assert.equal(f('HOST', 'ADMIN'), 'AGENT');
  assert.equal(f('HOST', 'OPS'), 'OPS');
});
test('SUPER_ADMIN is not assignable via the module', () => {
  assert.equal(f('EMPLOYEE', 'SUPER_ADMIN'), 'AGENT');
});
test('virtual agents are ALWAYS AGENT — the kind never grants authorization (LAX #4)', () => {
  assert.equal(f('VIRTUAL_AGENT', undefined), 'AGENT');
  assert.equal(f('VIRTUAL_AGENT', 'ADMIN'), 'AGENT');
  assert.equal(f('VIRTUAL_AGENT', 'OPS'), 'AGENT');
  assert.equal(f('VIRTUAL_AGENT', 'SUPER_ADMIN'), 'AGENT');
});

// Conversion within the employee family (2026-07-25) — the update-path
// decision. The invariant these pin: kind FOLLOWS an explicit type, so the
// QA-M2 hybrid (personKind VIRTUAL_AGENT + role ADMIN) is unrepresentable.
const g = _internal.resolveEmployeeTypePatch;

test('AGENT → VIRTUAL_AGENT conversion: kind flips, role forced AGENT', () => {
  assert.deepEqual(
    g({ storedKind: 'STANDARD', requestedType: 'VIRTUAL_AGENT', requestedRole: 'AGENT' }),
    { personKind: 'VIRTUAL_AGENT', role: 'AGENT' }
  );
});

test('VIRTUAL_AGENT → EMPLOYEE conversion: kind clears, requested role honored', () => {
  assert.deepEqual(
    g({ storedKind: 'VIRTUAL_AGENT', requestedType: 'EMPLOYEE', requestedRole: 'OPS' }),
    { personKind: 'STANDARD', role: 'OPS' }
  );
});

test('M2: no personType in the payload → stored VA kind governs, role stays AGENT', () => {
  assert.deepEqual(
    g({ storedKind: 'VIRTUAL_AGENT', requestedType: undefined, requestedRole: 'ADMIN' }),
    { role: 'AGENT' }
  );
});

test('the hybrid is unrepresentable: converting VA→ADMIN clears the kind WITH the promotion', () => {
  assert.deepEqual(
    g({ storedKind: 'VIRTUAL_AGENT', requestedType: 'ADMIN', requestedRole: 'ADMIN' }),
    { personKind: 'STANDARD', role: 'ADMIN' }
  );
});

test('unchanged type sends no personKind patch (no-op update stays a no-op)', () => {
  assert.deepEqual(
    g({ storedKind: 'STANDARD', requestedType: 'EMPLOYEE', requestedRole: 'AGENT' }),
    { role: 'AGENT' }
  );
  assert.deepEqual(
    g({ storedKind: 'VIRTUAL_AGENT', requestedType: 'VIRTUAL_AGENT', requestedRole: 'AGENT' }),
    { role: 'AGENT' }
  );
});

test('HOST is not a convertible type here — treated as no explicit type', () => {
  assert.deepEqual(
    g({ storedKind: 'STANDARD', requestedType: 'HOST', requestedRole: 'ADMIN' }),
    { role: 'ADMIN' }
  );
});
