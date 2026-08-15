import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicPositionPayload, linkState, configVehicleIds,
  POSITION_STALE_MS, POSITION_AGING_MS, watchKey, posKey,
} from './shuttle-tracker-position.js';

const NOW = new Date('2026-08-15T15:00:00Z').getTime();
const secondsAgo = (s) => new Date(NOW - s * 1000).toISOString();

const CONFIG = { mode: 'ON_DEMAND', headwayMinutes: 8 };
const LOCATION = { name: 'San Juan Airport' };

test('a fresh fix is LIVE with whitelisted fields only', () => {
  const out = publicPositionPayload({
    position: { latitude: 18.4394, longitude: -66.0018, heading: 270, speedMph: 22, eventAt: secondsAgo(12) },
    config: CONFIG, location: LOCATION, pickupInstructions: 'Puerta 4', now: NOW,
  });
  assert.equal(out.status, 'LIVE');
  assert.equal(out.position.ageSeconds, 12);
  assert.equal(out.locationName, 'San Juan Airport');
  assert.equal(out.pickupInstructions, 'Puerta 4');
});

test('THE WHITELIST: nothing beyond the contract ever leaves, even if the caller passes extra', () => {
  // The payload is built by picking, not spreading — feed it a record dripping
  // with internals and assert none survive. This is the test that fails if
  // someone "conveniently" spreads the row later.
  const leaky = {
    latitude: 18.4, longitude: -66.0, heading: 90, speedMph: 30, eventAt: secondsAgo(5),
    plate: 'ABC-123', vin: '1FTBW3XM…', odometer: 88123, engineOn: true,
    customerName: 'María', tenantId: 't1', id: 'veh_123',
  };
  const out = publicPositionPayload({ position: leaky, config: CONFIG, location: LOCATION, now: NOW });
  assert.deepEqual(Object.keys(out).sort(), ['headwayMinutes', 'locationName', 'mode', 'pickupInstructions', 'position', 'status']);
  assert.deepEqual(Object.keys(out.position).sort(), ['ageSeconds', 'asOf', 'heading', 'latitude', 'longitude', 'speedMph']);
});

test('aging fix is flagged, stale fix goes OFFLINE with NO coordinates', () => {
  const aging = publicPositionPayload({
    position: { latitude: 18.4, longitude: -66.0, eventAt: secondsAgo(POSITION_AGING_MS / 1000 + 10) },
    config: CONFIG, location: LOCATION, now: NOW,
  });
  assert.equal(aging.status, 'AGING');

  const stale = publicPositionPayload({
    position: { latitude: 18.4, longitude: -66.0, eventAt: secondsAgo(POSITION_STALE_MS / 1000 + 60) },
    config: CONFIG, location: LOCATION, now: NOW,
  });
  assert.equal(stale.status, 'OFFLINE');
  assert.equal(stale.position, undefined);
});

test('no fix at all is OFFLINE, not a crash', () => {
  const out = publicPositionPayload({ position: null, config: CONFIG, location: null, now: NOW });
  assert.equal(out.status, 'OFFLINE');
  assert.equal(out.locationName, null);
});

test('garbage coordinates are OFFLINE — never NaN on a public page', () => {
  const out = publicPositionPayload({
    position: { latitude: 'not-a-number', longitude: -66.0, eventAt: secondsAgo(5) },
    config: CONFIG, location: LOCATION, now: NOW,
  });
  assert.equal(out.status, 'OFFLINE');
});

test('link states: active, expired, revoked, missing', () => {
  const future = new Date(NOW + 3600_000);
  const past = new Date(NOW - 3600_000);
  assert.equal(linkState({ expiresAt: future, revokedAt: null }, NOW), 'ACTIVE');
  assert.equal(linkState({ expiresAt: past, revokedAt: null }, NOW), 'EXPIRED');
  // Revoked wins even if unexpired — regeneration must kill the old link NOW.
  assert.equal(linkState({ expiresAt: future, revokedAt: past }, NOW), 'REVOKED');
  assert.equal(linkState(null, NOW), 'NOT_FOUND');
  assert.equal(linkState({ expiresAt: 'garbage', revokedAt: null }, NOW), 'EXPIRED');
});

test('vehicle ids tolerate the Json column shapes', () => {
  assert.deepEqual(configVehicleIds({ vehicleIdsJson: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(configVehicleIds({ vehicleIdsJson: ['a', '', null] }), ['a']);
  assert.deepEqual(configVehicleIds({ vehicleIdsJson: null }), []);
  assert.deepEqual(configVehicleIds(null), []);
});

test('redis key naming is centralized', () => {
  assert.equal(watchKey('t1'), 'shuttle:watch:t1');
  assert.equal(posKey('v9'), 'shuttle:pos:v9');
});
