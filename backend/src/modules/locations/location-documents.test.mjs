/**
 * Business-document expiry (2026-07-28). PURE — no DB, no network, no clock
 * dependence (every test pins `now`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  daysUntilExpiry, documentExpiryStatus, needsAttention, sortByUrgency,
  normalizeDocType, DOC_STATUS, DEFAULT_WARN_DAYS,
} from './location-documents.js';

const NOW = new Date('2026-07-28T15:00:00Z'); // mid-afternoon, deliberately

test('the warning window is 30 days (Hector\'s ask)', () => {
  assert.equal(DEFAULT_WARN_DAYS, 30);
});

test('daysUntilExpiry counts whole DAYS and ignores the time of day', () => {
  // Expiring "today" is 0 days left even though `now` is mid-afternoon — a
  // permit is valid for the whole of its final day.
  assert.equal(daysUntilExpiry('2026-07-28', NOW), 0);
  assert.equal(daysUntilExpiry('2026-07-29', NOW), 1);
  assert.equal(daysUntilExpiry('2026-08-27', NOW), 30);
  assert.equal(daysUntilExpiry('2026-07-27', NOW), -1);
  assert.equal(daysUntilExpiry(null, NOW), null);
  assert.equal(daysUntilExpiry('not a date', NOW), null);
});

test('status: valid / expiring / expired around the 30-day boundary', () => {
  assert.equal(documentExpiryStatus('2026-08-28', { now: NOW }).status, DOC_STATUS.VALID, '31 days out');
  assert.equal(documentExpiryStatus('2026-08-27', { now: NOW }).status, DOC_STATUS.EXPIRING, 'exactly 30 days');
  assert.equal(documentExpiryStatus('2026-07-29', { now: NOW }).status, DOC_STATUS.EXPIRING, 'tomorrow');
  assert.equal(documentExpiryStatus('2026-07-28', { now: NOW }).status, DOC_STATUS.EXPIRING, 'expires today, still usable');
  assert.equal(documentExpiryStatus('2026-07-27', { now: NOW }).status, DOC_STATUS.EXPIRED, 'yesterday');
});

test('a document with NO expiry is perpetual and never chased', () => {
  for (const empty of [null, undefined, '']) {
    const r = documentExpiryStatus(empty, { now: NOW });
    assert.equal(r.status, DOC_STATUS.NO_EXPIRY);
    assert.equal(r.daysLeft, null);
    assert.equal(needsAttention(empty, { now: NOW }), false);
  }
});

test('the warning window is configurable without changing the semantics', () => {
  assert.equal(documentExpiryStatus('2026-08-15', { now: NOW, warnDays: 7 }).status, DOC_STATUS.VALID);
  assert.equal(documentExpiryStatus('2026-08-15', { now: NOW, warnDays: 60 }).status, DOC_STATUS.EXPIRING);
});

test('needsAttention covers expiring AND already-expired, nothing else', () => {
  assert.equal(needsAttention('2026-08-01', { now: NOW }), true, 'expiring soon');
  assert.equal(needsAttention('2026-07-01', { now: NOW }), true, 'already lapsed');
  assert.equal(needsAttention('2027-01-01', { now: NOW }), false, 'comfortably valid');
});

test('sortByUrgency: lapsed first, then nearest date; perpetual docs excluded', () => {
  const docs = [
    { id: 'valid', expiresAt: '2027-01-01' },
    { id: 'in-10', expiresAt: '2026-08-07' },
    { id: 'perpetual', expiresAt: null },
    { id: 'lapsed-30', expiresAt: '2026-06-28' },
    { id: 'in-2', expiresAt: '2026-07-30' },
  ];
  const out = sortByUrgency(docs, { now: NOW }).map((d) => d.id);
  assert.deepEqual(out, ['lapsed-30', 'in-2', 'in-10']);
});

test('normalizeDocType accepts the known kinds and funnels the rest to OTHER', () => {
  assert.equal(normalizeDocType('permit'), 'PERMIT');
  assert.equal(normalizeDocType(' Insurance '), 'INSURANCE');
  assert.equal(normalizeDocType('something-else'), 'OTHER');
  assert.equal(normalizeDocType(''), 'OTHER');
  assert.equal(normalizeDocType(null), 'OTHER');
});

test('a year-end expiry does not drift across a month boundary', () => {
  // Guards the UTC date-only arithmetic against local-timezone slippage.
  assert.equal(daysUntilExpiry('2027-01-01', new Date('2026-12-31T23:00:00Z')), 1);
  assert.equal(daysUntilExpiry('2026-12-31', new Date('2026-12-31T00:30:00Z')), 0);
});
