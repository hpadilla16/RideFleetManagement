import test from 'node:test';
import assert from 'node:assert/strict';

import { computeChargeSection } from './incident-report-charges.js';

// Real-world regression: TL-ZE40809640BA (RA-20260625164420-1763).
// Checkout collected tolls + their tax ($101.39). A $200 Cleaning Fee Level 3
// was added post check-in; the aggregated TAX row got recomputed over the
// WHOLE contract ($33.46). The incident report for the cleaning fee rendered
// $233.46 (fee + full-contract tax) instead of $223.00 (fee + $23.00
// attributable tax).
const TL_ROWS = [
  { id: 'c1', name: 'Daily', chargeType: 'DAILY', total: '0.00', taxable: true, selected: true },
  { id: 'c2', name: 'Service: Pre-Paid Tolls (N)', chargeType: 'UNIT', total: '90.93', taxable: true, selected: true },
  { id: 'c3', name: 'Fee: Cleaning Fee Level 3', chargeType: 'UNIT', total: '200.00', taxable: true, selected: true },
  { id: 'c4', name: 'Sales Tax (11.50%)', chargeType: 'TAX', total: '33.46', taxable: false, selected: true },
  { id: 'c5', name: 'Security Deposit', chargeType: 'DEPOSIT', total: '250.00', taxable: false, selected: true }
];

test('TL-ZE40809640BA — picked cleaning fee gets ONLY its attributable tax ($223.00, not $233.46)', () => {
  const out = computeChargeSection({ rows: TL_ROWS, pickedIds: new Set(['c3']), depositApplied: null });
  assert.deepEqual(out.lines, [
    { name: 'Fee: Cleaning Fee Level 3', total: 200 },
    { name: 'Sales Tax (11.50%)', total: 23 }
  ]);
  assert.equal(out.total, 223);
  assert.equal(out.feeNames.length, 1);
});

test('picking the TAX row explicitly cannot drag the full-contract tax in', () => {
  const out = computeChargeSection({ rows: TL_ROWS, pickedIds: new Set(['c3', 'c4']), depositApplied: null });
  assert.equal(out.total, 223); // identical — TAX rows are never report lines
});

test('DEPOSIT rows never appear as lines (handled via depositApplied)', () => {
  const out = computeChargeSection({ rows: TL_ROWS, pickedIds: new Set(['c3', 'c5']), depositApplied: 250 });
  assert.ok(out.lines.every((l) => l.name !== 'Security Deposit'));
  assert.equal(out.total, 223);
  assert.equal(out.balanceDue, 0); // 223 − 250 floors at 0
});

test('default pick (all selected) reproduces the full-contract tax exactly', () => {
  const out = computeChargeSection({ rows: TL_ROWS, pickedIds: null, depositApplied: null });
  // taxable base 290.93 at the derived rate → same 33.46 the agreement carries
  const tax = out.lines.find((l) => l.name === 'Sales Tax (11.50%)');
  assert.equal(tax.total, 33.46);
  assert.equal(out.total, 324.39);
});

test('non-taxable picked lines produce no tax line', () => {
  const rows = [
    { id: 'a', name: 'Toll admin (exempt)', chargeType: 'UNIT', total: '25.00', taxable: false, selected: true },
    { id: 't', name: 'Sales Tax (11.50%)', chargeType: 'TAX', total: '10.00', taxable: false, selected: true },
    { id: 'b', name: 'Taxed line', chargeType: 'UNIT', total: '86.96', taxable: true, selected: true }
  ];
  const out = computeChargeSection({ rows, pickedIds: new Set(['a']), depositApplied: null });
  assert.deepEqual(out.lines, [{ name: 'Toll admin (exempt)', total: 25 }]);
  assert.equal(out.total, 25);
});

test('rate falls back to the "(NN.NN%)" in the TAX row name when the base is zero', () => {
  const rows = [
    { id: 'z', name: 'Daily', chargeType: 'DAILY', total: '0.00', taxable: true, selected: true },
    { id: 't', name: 'Sales Tax (11.50%)', chargeType: 'TAX', total: '0.00', taxable: false, selected: true },
    { id: 'f', name: 'Fee: Smoking', chargeType: 'UNIT', total: '500.00', taxable: true, selected: false }
  ];
  // Smoking fee is deselected on the agreement but explicitly picked for the report.
  const out = computeChargeSection({ rows, pickedIds: new Set(['f']), depositApplied: null });
  assert.equal(out.total, 557.5); // 500 + 11.5%
});

test('agreement without a TAX row → lines pass through untouched', () => {
  const rows = [
    { id: 'f', name: 'Fee: Cleaning', chargeType: 'UNIT', total: '150.00', taxable: true, selected: true }
  ];
  const out = computeChargeSection({ rows, pickedIds: null, depositApplied: 100 });
  assert.equal(out.total, 150);
  assert.equal(out.balanceDue, 50);
});

test('no picked lines → empty section, null balanceDue', () => {
  const out = computeChargeSection({ rows: TL_ROWS, pickedIds: new Set(['nope']), depositApplied: 250 });
  assert.equal(out.lines.length, 0);
  assert.equal(out.balanceDue, null);
});
