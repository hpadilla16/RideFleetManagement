import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDob, isImplausibleAge, DOB_MAX_AGE_YEARS } from './dob.js';

test('accepts a normal birth date (ISO string)', () => {
  const d = normalizeDob('1990-04-01');
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCFullYear(), 1990);
});

test('accepts a Date instance', () => {
  const d = normalizeDob(new Date('1985-12-15'));
  assert.equal(d.getUTCFullYear(), 1985);
});

test('rejects the incident value 0959-04-01 (year < 1900) → null', () => {
  assert.equal(normalizeDob('0959-04-01'), null);
});

test('rejects the incident value 2800-04-01 (future) → null', () => {
  assert.equal(normalizeDob('2800-04-01'), null);
});

test('rejects an unparseable string → null', () => {
  assert.equal(normalizeDob('not-a-date'), null);
  assert.equal(normalizeDob('99/99/9999'), null);
});

test('rejects null / undefined / empty → null', () => {
  assert.equal(normalizeDob(null), null);
  assert.equal(normalizeDob(undefined), null);
  assert.equal(normalizeDob(''), null);
});

test('rejects ages over 120', () => {
  const tooOld = `${new Date().getUTCFullYear() - (DOB_MAX_AGE_YEARS + 5)}-01-01`;
  assert.equal(normalizeDob(tooOld), null);
});

test('accepts an edge-old-but-plausible date (110 years ago)', () => {
  const ok = `${new Date().getUTCFullYear() - 110}-06-01`;
  assert.ok(normalizeDob(ok) instanceof Date);
});

test('isImplausibleAge flags negatives and >120, not normal ages', () => {
  assert.equal(isImplausibleAge(1067), true);
  assert.equal(isImplausibleAge(-774), true);
  assert.equal(isImplausibleAge(36), false);
  assert.equal(isImplausibleAge(null), false);
});
