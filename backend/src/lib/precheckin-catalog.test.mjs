import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichPrecheckinCatalog, makeDiscountFn } from './precheckin-catalog.js';

test('percentage discount applied to plans + services for display', () => {
  const out = enrichPrecheckinCatalog({
    insurancePlans: [{ code: 'FULL', name: 'Full', amount: 20, isActive: true }],
    additionalServices: [{ id: 's1', name: 'Pre-paid fuel', rate: 50, dailyRate: 0 }, { id: 's2', name: 'Toll pass', rate: 0, dailyRate: 9 }],
    existingCharges: [],
    precheckinDiscount: { enabled: true, type: 'PERCENTAGE', value: 10 },
  });
  assert.equal(out.insurancePlans[0].discountedAmount, 18);
  assert.equal(out.insurancePlans[0].discounted, true);
  assert.equal(out.additionalServices[0].discountedRate, 45);
  assert.equal(out.additionalServices[1].discountedDailyRate, 8.1);
});

test('fixed discount + no discount when disabled', () => {
  const f = makeDiscountFn({ enabled: true, type: 'FIXED', value: 5 });
  assert.equal(f(20), 15);
  assert.equal(f(3), 0);
  const off = makeDiscountFn({ enabled: false, type: 'FIXED', value: 5 });
  assert.equal(off(20), 20);
});

test('flags add-ons already on the reservation; insurance present hides plans', () => {
  const out = enrichPrecheckinCatalog({
    insurancePlans: [{ code: 'FULL', name: 'Full', amount: 20, isActive: true }],
    additionalServices: [{ id: 's1', name: 'Fuel', rate: 50 }, { id: 's2', name: 'Toll', dailyRate: 9 }],
    existingCharges: [
      { source: 'INSURANCE', sourceRefId: 'FULL', selected: true },
      { source: 'ADDITIONAL_SERVICE_PRECHECKIN', sourceRefId: 's1', selected: true },
      { source: 'ADDITIONAL_SERVICE_PRECHECKIN', sourceRefId: 's2', selected: false },
    ],
    precheckinDiscount: null,
  });
  assert.equal(out.insurancePlans[0].alreadyOnReservation, true, 'insurance already present');
  assert.equal(out.additionalServices[0].alreadyOnReservation, true, 's1 selected');
  assert.equal(out.additionalServices[1].alreadyOnReservation, false, 's2 not selected');
});

test('inactive plans filtered out', () => {
  const out = enrichPrecheckinCatalog({ insurancePlans: [{ code: 'X', amount: 1, isActive: false }], precheckinDiscount: null });
  assert.equal(out.insurancePlans.length, 0);
});
