import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTollBillingPolicy } from './tolls-billing-policy.service.js';

test('evaluateTollBillingPolicy returns usage-only when prepaid toll package covers charges', () => {
  const decision = evaluateTollBillingPolicy({
    prepaidTollServiceCount: 1,
    transactions: [{ id: 'tx1' }, { id: 'tx2' }]
  });

  assert.deepEqual(decision, {
    coveredByTollPackage: true,
    tollPassthrough: false,
    billingMode: 'USAGE_ONLY',
    usageOnlyCount: 2,
    chargeableCount: 0,
    shouldCreateChargeRows: false,
    shouldApplyPolicyFee: false
  });
});

test('evaluateTollBillingPolicy returns chargeable mode when no toll package applies', () => {
  const decision = evaluateTollBillingPolicy({
    prepaidTollServiceCount: 0,
    transactions: [{ id: 'tx1' }]
  });

  assert.deepEqual(decision, {
    coveredByTollPackage: false,
    tollPassthrough: false,
    billingMode: 'CHARGEABLE',
    usageOnlyCount: 0,
    chargeableCount: 1,
    shouldCreateChargeRows: true,
    shouldApplyPolicyFee: true
  });
});

// ── LAX #10 (2026-07-28) — Toll Activation: tolls at cost, NO policy fee ────

test('pass-through: charges rows YES, policy fee NO', () => {
  const decision = evaluateTollBillingPolicy({
    prepaidTollServiceCount: 0,
    tollPassthroughServiceCount: 1,
    transactions: [{ id: 'tx1' }, { id: 'tx2' }]
  });

  assert.deepEqual(decision, {
    coveredByTollPackage: false,
    tollPassthrough: true,
    billingMode: 'PASSTHROUGH_NO_FEE',
    usageOnlyCount: 0,
    chargeableCount: 2,
    shouldCreateChargeRows: true,
    shouldApplyPolicyFee: false
  });
});

test('precedence: a prepaid coverage package WINS over pass-through (no double-dip)', () => {
  const decision = evaluateTollBillingPolicy({
    prepaidTollServiceCount: 1,
    tollPassthroughServiceCount: 1,
    transactions: [{ id: 'tx1' }]
  });

  assert.equal(decision.billingMode, 'USAGE_ONLY');
  assert.equal(decision.tollPassthrough, false);
  assert.equal(decision.shouldCreateChargeRows, false);
  assert.equal(decision.shouldApplyPolicyFee, false);
});

test('pass-through with zero tolls: nothing to bill, fee still off', () => {
  const decision = evaluateTollBillingPolicy({
    tollPassthroughServiceCount: 2,
    transactions: []
  });
  assert.equal(decision.billingMode, 'PASSTHROUGH_NO_FEE');
  assert.equal(decision.chargeableCount, 0);
  assert.equal(decision.shouldApplyPolicyFee, false);
});
