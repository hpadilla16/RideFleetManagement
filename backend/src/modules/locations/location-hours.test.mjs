// VozIA Fase 2 (2026-07-03) — pure tests for buildLocationHoursPayload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationHoursPayload } from './location-hours.routes.js';

const BASE = { id: 'loc1', code: 'SJU', name: 'San Juan Airport' };
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

test('empty config → all 7 days enabled with empty times, empty instructions', () => {
  const out = buildLocationHoursPayload({ ...BASE, locationConfig: null });
  assert.equal(out.id, 'loc1');
  assert.equal(out.code, 'SJU');
  assert.equal(out.name, 'San Juan Airport');
  assert.equal(out.pickupInstructions, '');
  assert.deepEqual(Object.keys(out.weeklyHours), DAYS);
  for (const day of DAYS) {
    assert.deepEqual(out.weeklyHours[day], { enabled: true, open: '', close: '' });
  }
});

test('partial weeklyHours: configured day wins, others fall back to operations window', () => {
  const cfg = {
    operationsOpenTime: '08:00',
    operationsCloseTime: '18:00',
    weeklyHours: {
      sunday: { enabled: false },
      saturday: { enabled: true, open: '09:00', close: '13:00' }
    },
    pickupInstructions: '  Meet at counter 4.  '
  };
  const out = buildLocationHoursPayload({ ...BASE, locationConfig: JSON.stringify(cfg) });
  assert.deepEqual(out.weeklyHours.saturday, { enabled: true, open: '09:00', close: '13:00' });
  // disabled day still reports the fallback window (matches resolveHoursForDate)
  assert.deepEqual(out.weeklyHours.sunday, { enabled: false, open: '08:00', close: '18:00' });
  assert.deepEqual(out.weeklyHours.monday, { enabled: true, open: '08:00', close: '18:00' });
  assert.equal(out.pickupInstructions, 'Meet at counter 4.');
});

test('malformed JSON config → treated as {} (all days enabled, no crash)', () => {
  const out = buildLocationHoursPayload({ ...BASE, locationConfig: '{not json' });
  for (const day of DAYS) {
    assert.deepEqual(out.weeklyHours[day], { enabled: true, open: '', close: '' });
  }
  assert.equal(out.pickupInstructions, '');
});

test('non-object day entry is ignored (falls back)', () => {
  const cfg = { weeklyHours: { monday: 'closed' }, operationsOpenTime: '07:00', operationsCloseTime: '19:00' };
  const out = buildLocationHoursPayload({ ...BASE, locationConfig: JSON.stringify(cfg) });
  assert.deepEqual(out.weeklyHours.monday, { enabled: true, open: '07:00', close: '19:00' });
});

test('object-form locationConfig (already parsed) is accepted', () => {
  const out = buildLocationHoursPayload({ ...BASE, locationConfig: { pickupInstructions: 'Row B' } });
  assert.equal(out.pickupInstructions, 'Row B');
});
