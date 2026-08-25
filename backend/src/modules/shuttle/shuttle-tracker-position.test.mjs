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
  //
  // 2026-08-24 (approved tracker polish): the contract DELIBERATELY grew by
  // exactly five keys — brandName, counterPhone, requestStatus,
  // walkingDirections, and (when a vehicle is passed) vehicle{name,color,
  // plate}. 2026-08-24 (Phase 2, approved #21): two more — arrivedAtSpot +
  // arrivedSpotName. 2026-08-25 (Phase 3 core, Screens 8a/8b/9): two more —
  // assigned + locationSharing{active,distanceMeters}, plus the NON_STOP-only
  // shuttles array (pinned in shuttle-assignment.test.mjs). This list IS the
  // review record; growing it again means editing this assertion on purpose.
  const leaky = {
    latitude: 18.4, longitude: -66.0, heading: 90, speedMph: 30, eventAt: secondsAgo(5),
    plate: 'ABC-123', vin: '1FTBW3XM…', odometer: 88123, engineOn: true,
    customerName: 'María', tenantId: 't1', id: 'veh_123', vehicleId: 'veh_123',
  };
  const out = publicPositionPayload({ position: leaky, config: CONFIG, location: LOCATION, now: NOW });
  assert.deepEqual(Object.keys(out).sort(), [
    'arrivedAtSpot', 'arrivedSpotName', 'assigned', 'brandName', 'counterPhone',
    'headwayMinutes', 'locationName', 'locationSharing', 'mode',
    'pickupInstructions', 'position', 'requestStatus', 'status', 'walkingDirections',
  ]);
  assert.deepEqual(Object.keys(out.position).sort(), ['ageSeconds', 'asOf', 'heading', 'latitude', 'longitude', 'speedMph']);
  // Phase 3 defaults: not assigned, not sharing — and locationSharing is the
  // two-key distance-only shape, never a coordinate carrier.
  assert.equal(out.assigned, false);
  assert.deepEqual(out.locationSharing, { active: false, distanceMeters: null });
});

test('PHASE 2 arrival fields: default off, spot name only when arrived, never invented', () => {
  const base = { position: null, config: CONFIG, location: LOCATION, now: NOW };
  const off = publicPositionPayload(base);
  assert.equal(off.arrivedAtSpot, false);
  assert.equal(off.arrivedSpotName, null);

  const on = publicPositionPayload({ ...base, arrivedAtSpot: true, arrivedSpotName: 'Pickup Lot B' });
  assert.equal(on.arrivedAtSpot, true);
  assert.equal(on.arrivedSpotName, 'Pickup Lot B');

  // A spot name without an arrival never crosses — the flag gates the name.
  const nameOnly = publicPositionPayload({ ...base, arrivedAtSpot: false, arrivedSpotName: 'Pickup Lot B' });
  assert.equal(nameOnly.arrivedAtSpot, false);
  assert.equal(nameOnly.arrivedSpotName, null);

  // Truthy-but-not-true never flips the flag (defensive against a caller
  // passing a row or a string where the boolean belongs).
  const truthy = publicPositionPayload({ ...base, arrivedAtSpot: 'yes', arrivedSpotName: 'X' });
  assert.equal(truthy.arrivedAtSpot, false);
  assert.equal(truthy.arrivedSpotName, null);
});

test('NEW #3 vehicle identity: name/color/plate only — a leaky vehicle row never crosses', () => {
  const leakyVehicle = {
    id: 'veh_1', tenantId: 't1', make: 'Ford', model: 'Transit 350', year: 2023,
    color: 'White', plate: 'IKT-482', vin: '1FTBW3XM0PKA00001', internalNumber: 'U-17',
    mileage: 88123, acquisitionCost: '41000.00',
  };
  const out = publicPositionPayload({
    position: { latitude: 18.4, longitude: -66.0, eventAt: secondsAgo(5) },
    config: CONFIG, location: LOCATION, vehicle: leakyVehicle, now: NOW,
  });
  assert.deepEqual(out.vehicle, { name: 'Ford Transit 350', color: 'White', plate: 'IKT-482' });
  assert.deepEqual(Object.keys(out.vehicle).sort(), ['color', 'name', 'plate']);
  // year / VIN / internalNumber stay staff-side.
  assert.equal(String(JSON.stringify(out)).includes('1FTBW3XM'), false);
  assert.equal(String(JSON.stringify(out)).includes('U-17'), false);
});

test('NEW #3: an all-empty vehicle record omits the key entirely', () => {
  const out = publicPositionPayload({
    position: { latitude: 18.4, longitude: -66.0, eventAt: secondsAgo(5) },
    config: CONFIG, location: LOCATION, vehicle: { id: 'v', make: '', model: null, color: '', plate: '' }, now: NOW,
  });
  assert.equal('vehicle' in out, false);
});

test('NEW #2 requestStatus: only READY/VIEWED/COMPLETED cross; bookkeeping states collapse to null', () => {
  const at = { position: null, config: CONFIG, location: LOCATION, now: NOW };
  assert.equal(publicPositionPayload({ ...at, requestStatus: 'READY' }).requestStatus, 'READY');
  assert.equal(publicPositionPayload({ ...at, requestStatus: 'VIEWED' }).requestStatus, 'VIEWED');
  assert.equal(publicPositionPayload({ ...at, requestStatus: 'COMPLETED' }).requestStatus, 'COMPLETED');
  assert.equal(publicPositionPayload({ ...at, requestStatus: 'CANCELLED' }).requestStatus, null);
  assert.equal(publicPositionPayload({ ...at, requestStatus: 'NO_SHOW' }).requestStatus, null);
  assert.equal(publicPositionPayload({ ...at, requestStatus: 'garbage' }).requestStatus, null);
  assert.equal(publicPositionPayload(at).requestStatus, null);
});

test('NEW #1/#4/#5: brand, walking directions and counter phone default to empty — never invented', () => {
  const bare = publicPositionPayload({ position: null, config: CONFIG, location: LOCATION, now: NOW });
  assert.equal(bare.brandName, null);
  assert.equal(bare.counterPhone, null);
  assert.equal(bare.walkingDirections, '');
  const full = publicPositionPayload({
    position: null, config: CONFIG, location: LOCATION, now: NOW,
    brandName: 'International Rental Corp', counterPhone: '(787) 555-0142',
    walkingDirections: 'Take the elevator to Level 1.',
  });
  assert.equal(full.brandName, 'International Rental Corp');
  assert.equal(full.counterPhone, '(787) 555-0142');
  assert.equal(full.walkingDirections, 'Take the elevator to Level 1.');
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

test('location coordinates surface as the pickup point; absent coords omit the key', () => {
  const withCoords = publicPositionPayload({
    position: { latitude: 18.44, longitude: -66.0, heading: 0, speedMph: 10, eventAt: secondsAgo(5) },
    config: CONFIG, location: { name: 'SJU', latitude: 18.438, longitude: -66.002 }, now: NOW,
  });
  assert.deepEqual(withCoords.pickup, { latitude: 18.438, longitude: -66.002 });
  const without = publicPositionPayload({
    position: null, config: CONFIG, location: LOCATION, now: NOW,
  });
  assert.equal('pickup' in without, false);
});
