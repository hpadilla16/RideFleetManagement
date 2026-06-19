import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  vendorKey, normalizeVendorName, excludeSetFor, isExcludedVendor, DEFAULT_EXCLUDE_KEYS,
} from './market-vendor.js';

test('vendorKey merges spelling variants of the same brand', () => {
  // pairs that must collapse to the same key
  const pairs = [
    ['U-Save', 'U-Save Car Rental'],
    ['ACE', 'ACE Rent A Car'],
    ['NÜ Car Rentals', 'NU'],
    ['Nextcar', 'NextCar'],
    ['Thrifty', 'Thrifty Car Rental'],
    ['Dollar', 'Dollar Rent A Car'],
    ['Alamo', 'Alamo Rent A Car'],
    ['National', 'National Car Rental'],
    ['Priceless', 'Priceless Car Rental'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(vendorKey(a), vendorKey(b), `${a} vs ${b}`);
  }
});

test('vendorKey keeps distinct brands distinct', () => {
  assert.notEqual(vendorKey('Payless'), vendorKey('Priceless'));
  assert.notEqual(vendorKey('Budget'), vendorKey('Avis'));
  assert.notEqual(vendorKey('Sixt'), vendorKey('Fox'));
});

test('normalizeVendorName strips the trailing descriptor', () => {
  assert.equal(normalizeVendorName('U-Save Car Rental'), 'U-Save');
  assert.equal(normalizeVendorName('Thrifty Car Rental'), 'Thrifty');
  assert.equal(normalizeVendorName('Alamo Rent A Car'), 'Alamo');
  assert.equal(normalizeVendorName('Payless'), 'Payless');
  assert.equal(normalizeVendorName('NÜ Car Rentals'), 'NÜ');
});

test('no brand is excluded by default (config-driven, per tenant)', () => {
  const set = excludeSetFor(); // no tenant config
  assert.equal(DEFAULT_EXCLUDE_KEYS.length, 0);
  assert.equal(isExcludedVendor('ZezGo', set), false);
  assert.equal(isExcludedVendor('Payless', set), false);
});

test('excludeSetFor excludes the tenant-configured names, in any spelling', () => {
  const set = excludeSetFor(['ZezGo', 'Routes', 'Carwiz']);
  assert.equal(isExcludedVendor('ZezGo', set), true);
  assert.equal(isExcludedVendor('ZEZGO', set), true);
  assert.equal(isExcludedVendor('Zezgo Car Rental', set), true); // spelling variant collapses
  assert.equal(isExcludedVendor('Routes', set), true);
  assert.equal(isExcludedVendor('Carwiz', set), true);
  assert.equal(isExcludedVendor('Sixt', set), false);
});

test('empty/blank vendors never throw', () => {
  assert.equal(vendorKey(''), '');
  assert.equal(vendorKey(null), '');
  assert.equal(normalizeVendorName(null), '');
  assert.equal(isExcludedVendor(null, excludeSetFor()), false);
});
