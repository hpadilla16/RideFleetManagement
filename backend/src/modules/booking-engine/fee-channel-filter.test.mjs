import test from 'node:test';
import assert from 'node:assert/strict';
import { filterMandatoryFeesForChannel } from './fee-channel-filter.js';

const FEES = [
  { id: 'web', name: 'Website fee', isActive: true, mandatory: true, displayOnline: true },
  { id: 'all', name: 'Airport fee', isActive: true, mandatory: true, displayOnline: false },
  { id: 'opt', name: 'Optional', isActive: true, mandatory: false, displayOnline: true },
  { id: 'off', name: 'Inactive', isActive: false, mandatory: true, displayOnline: true }
];
const ids = (rows) => rows.map((f) => f.id);

test('WEBSITE (and a missing channel) get the website-only mandatory fees', () => {
  assert.deepEqual(ids(filterMandatoryFeesForChannel(FEES, 'WEBSITE')), ['web', 'all']);
  assert.deepEqual(ids(filterMandatoryFeesForChannel(FEES, undefined)), ['web', 'all']);
});

test('PARTNER is an online channel: the fees quoted at the partner checkout survive the pricing re-sync (QA M1)', () => {
  assert.deepEqual(ids(filterMandatoryFeesForChannel(FEES, 'PARTNER')), ['web', 'all']);
  assert.deepEqual(ids(filterMandatoryFeesForChannel(FEES, 'partner')), ['web', 'all']);
});

test('STAFF / CAR_SHARING / MIGRATION never get website-only fees', () => {
  for (const ch of ['STAFF', 'CAR_SHARING', 'MIGRATION']) {
    assert.deepEqual(ids(filterMandatoryFeesForChannel(FEES, ch)), ['all'], ch);
  }
});
