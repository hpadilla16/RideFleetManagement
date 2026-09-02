// Regression: Sentry 371e0617 (2026-09-02) — an agent typed 3,334,933,457 into
// an inspection odometer and the raw Number() rode it into an INT4
// ConnectorError 500. parseOdometerInput is now the single gate in front of
// every odometer write (saveInspection + checkin-close).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOdometerInput, ODOMETER_MAX } from './odometer-input.js';

test('absent / blank inputs stay null — the "not provided" contract', () => {
  assert.equal(parseOdometerInput(undefined), null);
  assert.equal(parseOdometerInput(null), null);
  assert.equal(parseOdometerInput(''), null);
});

test('normal readings pass through as numbers', () => {
  assert.equal(parseOdometerInput(0), 0);
  assert.equal(parseOdometerInput('41210'), 41210);
  assert.equal(parseOdometerInput(999999), 999999);
  assert.equal(parseOdometerInput(ODOMETER_MAX), ODOMETER_MAX);
});

test('the Sentry value is refused with an actionable message', () => {
  assert.throws(() => parseOdometerInput(3334933457), /odometer must be a whole number/);
  assert.throws(() => parseOdometerInput('3334933457'), /9,999,999/);
});

test('NaN, negatives, decimals and INT4-overflow all refuse', () => {
  for (const bad of ['garbage', '12e99', -1, 12.5, ODOMETER_MAX + 1, 2147483648]) {
    assert.throws(() => parseOdometerInput(bad), /odometer/, String(bad));
  }
});

test('field name customizes the message so the close endpoint says odometerIn', () => {
  assert.throws(
    () => parseOdometerInput(9e9, { field: 'odometerIn' }),
    /odometerIn must be/
  );
});

test('the message never echoes more than 24 chars of the garbage', () => {
  try {
    parseOdometerInput('x'.repeat(500));
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e.message.length < 160, e.message);
  }
});
