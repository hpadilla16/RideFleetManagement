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
    billingMode: 'CHARGEABLE',
    usageOnlyCount: 0,
    chargeableCount: 1,
    shouldCreateChargeRows: true,
    shouldApplyPolicyFee: true
  });
});
