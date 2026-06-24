import test from 'node:test';
import assert from 'node:assert/strict';
import { userAllowedLocationIds } from './tenant-scope.js';

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
