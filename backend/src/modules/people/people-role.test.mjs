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
