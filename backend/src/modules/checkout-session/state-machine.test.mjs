/**
 * Tests for the checkout-session state machine.
 * Run: node --test backend/src/modules/checkout-session/state-machine.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  canCancelFrom,
  isTerminal,
  legalForwardTransitions,
  entryRequirement,
  appendEvent,
  readEvents,
} from './state-machine.js';

// ---------------------------------------------------------------------------
// canTransition
// ---------------------------------------------------------------------------

test('happy path: CONFIRMING → TC_PENDING → ... → CLOSED', () => {
  const path = [
    'CONFIRMING',
    'TC_PENDING',
    'TC_SIGNED',
    'PAYMENT_PENDING',
    'PAID',
    'INSPECTION_HANDOFF',
    'INSPECTION_IN_PROGRESS',
    'CUSTOMER_SIGN_PENDING',
    'FINALIZING',
    'CLOSED',
  ];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.ok(
      canTransition(path[i], path[i + 1]),
      `${path[i]} → ${path[i + 1]} should be legal`,
    );
  }
});

test('refuses jumping more than one step ahead', () => {
  assert.equal(canTransition('CONFIRMING', 'PAYMENT_PENDING'), false);
  assert.equal(canTransition('TC_PENDING', 'PAID'), false);
  assert.equal(canTransition('PAID', 'FINALIZING'), false);
});

test('refuses going backward', () => {
  assert.equal(canTransition('PAID', 'TC_SIGNED'), false);
  assert.equal(canTransition('FINALIZING', 'PAYMENT_PENDING'), false);
});

test('terminal states (CLOSED, CANCELLED) cannot transition out', () => {
  assert.equal(isTerminal('CLOSED'), true);
  assert.equal(isTerminal('CANCELLED'), true);
  assert.equal(canTransition('CLOSED', 'CONFIRMING'), false);
  assert.equal(canTransition('CANCELLED', 'CONFIRMING'), false);
});

test('CANCELLED is permitted from any non-terminal state', () => {
  assert.equal(canTransition('CONFIRMING', 'CANCELLED'), true);
  assert.equal(canTransition('TC_PENDING', 'CANCELLED'), true);
  assert.equal(canTransition('PAID', 'CANCELLED'), true);
  assert.equal(canTransition('FINALIZING', 'CANCELLED'), true);
  // Not from already-terminal.
  assert.equal(canTransition('CLOSED', 'CANCELLED'), false);
});

test('same-step transition refused', () => {
  assert.equal(canTransition('PAID', 'PAID'), false);
});

test('canCancelFrom mirrors isTerminal logic', () => {
  assert.equal(canCancelFrom('CONFIRMING'), true);
  assert.equal(canCancelFrom('PAID'), true);
  assert.equal(canCancelFrom('CLOSED'), false);
  assert.equal(canCancelFrom('CANCELLED'), false);
});

test('legalForwardTransitions returns array (never undefined)', () => {
  assert.deepEqual(legalForwardTransitions('CONFIRMING'), ['TC_PENDING']);
  assert.deepEqual(legalForwardTransitions('CLOSED'), []);
  assert.deepEqual(legalForwardTransitions('UNKNOWN_STATE'), []);
});

// ---------------------------------------------------------------------------
// entryRequirement
// ---------------------------------------------------------------------------

test('TC_SIGNED requires tcCompletedAt to be stamped', () => {
  assert.equal(entryRequirement('TC_SIGNED'), 'tcCompletedAt');
});

test('PAID requires paymentCompletedAt', () => {
  assert.equal(entryRequirement('PAID'), 'paymentCompletedAt');
});

test('CUSTOMER_SIGN_PENDING requires inspectionCompletedAt', () => {
  assert.equal(entryRequirement('CUSTOMER_SIGN_PENDING'), 'inspectionCompletedAt');
});

test('CLOSED requires customerSignedAt', () => {
  assert.equal(entryRequirement('CLOSED'), 'customerSignedAt');
});

test('steps without entry guards return null', () => {
  assert.equal(entryRequirement('CONFIRMING'), null);
  assert.equal(entryRequirement('TC_PENDING'), null);
  assert.equal(entryRequirement('PAYMENT_PENDING'), null);
});

// ---------------------------------------------------------------------------
// events JSON helpers
// ---------------------------------------------------------------------------

test('appendEvent grows the events array', () => {
  const after1 = appendEvent('[]', { kind: 'SESSION_STARTED' });
  const arr1 = readEvents(after1);
  assert.equal(arr1.length, 1);
  assert.equal(arr1[0].kind, 'SESSION_STARTED');
  assert.ok(arr1[0].at, 'auto-stamps timestamp');

  const after2 = appendEvent(after1, { kind: 'TRANSITION', from: 'CONFIRMING', to: 'TC_PENDING' });
  const arr2 = readEvents(after2);
  assert.equal(arr2.length, 2);
  assert.equal(arr2[1].kind, 'TRANSITION');
});

test('appendEvent tolerates corrupted events string', () => {
  const after = appendEvent('not valid json', { kind: 'TRANSITION' });
  const arr = readEvents(after);
  assert.equal(arr.length, 1, 'starts fresh when JSON is broken');
});

test('appendEvent uses provided at, falls back to now', () => {
  const explicit = appendEvent('[]', { kind: 'X', at: '2026-01-01T00:00:00Z' });
  assert.equal(readEvents(explicit)[0].at, '2026-01-01T00:00:00Z');

  const auto = appendEvent('[]', { kind: 'X' });
  assert.ok(readEvents(auto)[0].at.startsWith('20'));
});
