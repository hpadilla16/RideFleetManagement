import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRIORITY_HIGH,
  PRIORITY_NORMAL,
  PRIORITY_LOW,
  AUTOCHARGE_PRIORITY,
  EMAIL_INVOICE_PRIORITY,
  SCRAPER_PRIORITY
} from './priorities.js';

test('priority constants have expected numeric values', () => {
  assert.equal(PRIORITY_HIGH, 1);
  assert.equal(PRIORITY_NORMAL, 5);
  assert.equal(PRIORITY_LOW, 10);
});

test('lane aliases match their base priority constant', () => {
  assert.equal(AUTOCHARGE_PRIORITY, PRIORITY_HIGH);
  assert.equal(EMAIL_INVOICE_PRIORITY, PRIORITY_NORMAL);
  assert.equal(SCRAPER_PRIORITY, PRIORITY_LOW);
});

test('all priority values are positive integers', () => {
  const values = [
    PRIORITY_HIGH,
    PRIORITY_NORMAL,
    PRIORITY_LOW,
    AUTOCHARGE_PRIORITY,
    EMAIL_INVOICE_PRIORITY,
    SCRAPER_PRIORITY
  ];
  for (const v of values) {
    assert.equal(typeof v, 'number', `expected number, got ${typeof v}`);
    assert.ok(Number.isInteger(v), `expected integer, got ${v}`);
    assert.ok(v > 0, `expected positive, got ${v}`);
  }
});
