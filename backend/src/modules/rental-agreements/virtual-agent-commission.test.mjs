// Virtual-agent commission math (2026-07-25, LAX #4). MONEY.
// Hector's rule: a virtual agent earns the plan's percent of EVERYTHING they
// sell — additional services (all four source spellings) + insurance —
// excluding taxes, fees and deposits. These pin: the sold-item inclusion
// list, the exclusions, the 1% math, and that the flat-rate catalog can
// never leak into a VA plan (the fn only ever emits PERCENT lines).
process.env.JWT_SECRET = 'test-secret-for-va-commission-tests-0123456789';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@127.0.0.1:5/x';

import test from 'node:test';
import assert from 'node:assert/strict';
import { virtualAgentCommissionLines } from './rental-agreements.service.js';
import { isSoldItemCharge, SOLD_ITEM_SOURCES, SERVICE_CHARGE_SOURCES } from '../../lib/sold-items.js';

const VA_PLAN = { defaultValueType: 'PERCENT', defaultPercentValue: 1 };

const CHARGES = [
  { id: 'c1', name: 'Daily', chargeType: 'DAILY', source: 'DAILY', total: 200, quantity: 4 },
  { id: 'c2', name: 'Toll Pass', chargeType: 'UNIT', source: 'ADDITIONAL_SERVICE', sourceRefId: 'svc-1', total: 40, quantity: 4 },
  { id: 'c3', name: 'GPS', chargeType: 'UNIT', source: 'SERVICE', total: 20, quantity: 1 },
  { id: 'c4', name: 'Child Seat', chargeType: 'UNIT', source: 'ADDITIONAL_SERVICE_PRECHECKIN', total: 30, quantity: 1 },
  { id: 'c5', name: 'Prepaid Fuel', chargeType: 'UNIT', source: 'KIOSK_UPSELL', total: 85, quantity: 1 },
  { id: 'c6', name: 'CDW Zero', chargeType: 'DAILY', source: 'INSURANCE', sourceRefId: 'CDW0', total: 120, quantity: 4 },
  { id: 'c7', name: 'Tax', chargeType: 'TAX', source: 'TAX', total: 45, quantity: 1 },
  { id: 'c8', name: 'Airport Fee', chargeType: 'UNIT', source: 'MANDATORY_FEE', total: 15, quantity: 1 },
  { id: 'c9', name: 'Fuel refill', chargeType: 'UNIT', source: 'FEE_ENGINE_CHECKIN', total: 25, quantity: 1 },
  { id: 'c10', name: 'Security Deposit', chargeType: 'DEPOSIT', source: 'SECURITY_DEPOSIT', total: 1000, quantity: 1 },
  { id: 'c11', name: 'Unselected upsell', chargeType: 'UNIT', source: 'ADDITIONAL_SERVICE', total: 50, quantity: 1, selected: false },
  { id: 'c12', name: 'Comped service', chargeType: 'UNIT', source: 'SERVICE', total: 0, quantity: 1 }
];

test('sold items = services (4 spellings) + insurance; never daily/tax/fees/deposits/unselected/zero', () => {
  const sold = CHARGES.filter(isSoldItemCharge).map((c) => c.id);
  assert.deepEqual(sold, ['c2', 'c3', 'c4', 'c5', 'c6']);
  for (const src of SERVICE_CHARGE_SOURCES) assert.ok(SOLD_ITEM_SOURCES.includes(src));
  assert.ok(SOLD_ITEM_SOURCES.includes('INSURANCE'));
});

test('1% of everything sold: services + insurance, cent-exact', () => {
  const lines = virtualAgentCommissionLines(CHARGES, VA_PLAN);
  assert.equal(lines.length, 5);
  // 40 + 20 + 30 + 85 + 120 = 295 → 1% = 2.95
  const total = lines.reduce((s, l) => s + l.commissionAmount, 0);
  assert.equal(Number(total.toFixed(2)), 2.95);
  for (const line of lines) {
    assert.equal(line.valueType, 'PERCENT');
    assert.equal(line.percentValue, 1);
  }
});

test('serviceId carried only for ADDITIONAL_SERVICE rows (matches the ledger convention)', () => {
  const lines = virtualAgentCommissionLines(CHARGES, VA_PLAN);
  assert.equal(lines.find((l) => l.rentalAgreementChargeId === 'c2').serviceId, 'svc-1');
  assert.equal(lines.find((l) => l.rentalAgreementChargeId === 'c6').serviceId, null);
});

test('no plan / non-percent plan / zero percent → NO lines (fail-closed, never catalog fallback)', () => {
  assert.deepEqual(virtualAgentCommissionLines(CHARGES, null), []);
  assert.deepEqual(virtualAgentCommissionLines(CHARGES, { defaultValueType: 'FIXED_PER_AGREEMENT', defaultFixedAmount: 3 }), []);
  assert.deepEqual(virtualAgentCommissionLines(CHARGES, { defaultValueType: 'PERCENT', defaultPercentValue: 0 }), []);
  assert.deepEqual(virtualAgentCommissionLines(CHARGES, { defaultValueType: 'PERCENT', defaultPercentValue: 'x' }), []);
});

test('rounding is per line, portal-style (toFixed 2)', () => {
  const lines = virtualAgentCommissionLines(
    [{ id: 'x', name: 'Odd', chargeType: 'UNIT', source: 'SERVICE', total: 33.335, quantity: 1 }],
    VA_PLAN
  );
  assert.equal(lines[0].commissionAmount, 0.33);
});
