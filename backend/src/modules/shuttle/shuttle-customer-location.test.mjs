/**
 * Ephemeral customer location — DB-free (Phase 3, 2026-08-25; Screens 9/10).
 *
 * Pins the binding privacy constraints where they can fail: the Redis-only
 * write path (TTL 300s, refreshed, deleted on close), the public payload
 * that carries a DISTANCE and never an echo of the customer's coordinates,
 * and the staff-only payload being the single place a fix leaves the server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  custLocKey, CUSTOMER_LOC_TTL_S, validateCustomerFix, parseStoredFix,
  distanceMeters, publicLocationSharing,
} from './shuttle-customer-location.js';
import {
  storeCustomerLocation, readCustomerLocation, clearCustomerLocation,
} from './shuttle-tracker.service.js';
import { waitingCustomerPayload } from './shuttle-monitor.js';
import { publicPositionPayload } from './shuttle-tracker-position.js';

const NOW = Date.now();

// ─── pure rules ─────────────────────────────────────────────────────────────

test('key naming: request id (a cuid — no PII), house prefix, TTL is 5 minutes', () => {
  assert.equal(custLocKey('req_abc123'), 'shuttle:custloc:req_abc123');
  assert.equal(CUSTOMER_LOC_TTL_S, 300);
});

test('fix validation: two finite in-range numbers or a refusal — garbage never stores', () => {
  assert.deepEqual(validateCustomerFix({ lat: 18.44, lng: -66.0 }), { ok: true, fix: { lat: 18.44, lng: -66.0 } });
  assert.deepEqual(validateCustomerFix({ lat: '18.44', lng: '-66.0' }).fix, { lat: 18.44, lng: -66.0 });
  for (const body of [
    {}, { lat: 18.44 }, { lng: -66 }, { lat: 91, lng: 0 }, { lat: 0, lng: 181 },
    { lat: 'north', lng: -66 }, { lat: NaN, lng: -66 }, { lat: Infinity, lng: -66 }, null,
  ]) {
    const out = validateCustomerFix(body);
    assert.equal(out.ok, false, JSON.stringify(body));
    // The refusal never echoes what was sent.
    assert.equal(out.error.includes('91'), false);
  }
});

test('parseStoredFix: round-trips a good value, rejects garbage and expired-beyond-TTL relics', () => {
  const good = JSON.stringify({ lat: 18.4, lng: -66.0, at: NOW - 30_000 });
  assert.deepEqual(parseStoredFix(good, NOW), { lat: 18.4, lng: -66.0, at: NOW - 30_000 });
  assert.equal(parseStoredFix(null, NOW), null);
  assert.equal(parseStoredFix('not json', NOW), null);
  assert.equal(parseStoredFix(JSON.stringify({ lat: 'x', lng: -66, at: NOW }), NOW), null);
  // A fix older than the TTL window reads as not-sharing even if the key
  // somehow survived — defensive against a Redis with persistence quirks.
  assert.equal(parseStoredFix(JSON.stringify({ lat: 18.4, lng: -66.0, at: NOW - 301_000 }), NOW), null);
});

test('distance: straight-line meters (owner decision), sane on a known baseline', () => {
  // One degree of latitude ≈ 111.19 km.
  const d = distanceMeters({ lat: 18.0, lng: -66.0 }, { latitude: 19.0, longitude: -66.0 });
  assert.ok(Math.abs(d - 111195) < 300, `expected ~111195m, got ${d}`);
  assert.equal(distanceMeters({ lat: 18, lng: -66 }, { lat: 18, lng: -66 }), 0);
  assert.equal(distanceMeters({ lat: 18, lng: -66 }, { lat: 'x', lng: -66 }), null);
  assert.equal(distanceMeters(null, { lat: 18, lng: -66 }), null);
});

test('PUBLIC sharing payload: active + nearest distance, NEVER the coordinates themselves', () => {
  const fix = { lat: 18.44, lng: -66.0, at: NOW };
  const near = { latitude: 18.441, longitude: -66.0 }; // ~111m north
  const far = { latitude: 18.5, longitude: -66.0 };
  const out = publicLocationSharing(fix, [far, near]);
  assert.equal(out.active, true);
  assert.ok(out.distanceMeters > 50 && out.distanceMeters < 200, `nearest wins: ${out.distanceMeters}`);
  assert.deepEqual(Object.keys(out).sort(), ['active', 'distanceMeters'], 'exactly two keys — no echo');
  assert.equal(JSON.stringify(out).includes('18.44'), false, 'the customer\'s own coords never round-trip');

  assert.deepEqual(publicLocationSharing(null, [near]), { active: false, distanceMeters: null });
  assert.deepEqual(publicLocationSharing(fix, []), { active: true, distanceMeters: null }, 'sharing with no shuttle fix = active, unknown distance');
});

test('the tracker payload carries locationSharing distance-only, and defaults to inactive', () => {
  const base = { position: null, config: { mode: 'ON_DEMAND' }, location: { name: 'SJU' }, now: NOW };
  const off = publicPositionPayload(base);
  assert.deepEqual(off.locationSharing, { active: false, distanceMeters: null });
  const on = publicPositionPayload({ ...base, locationSharing: { active: true, distanceMeters: 412 } });
  assert.deepEqual(on.locationSharing, { active: true, distanceMeters: 412 });
  // active must be literally true for a distance to cross.
  const fake = publicPositionPayload({ ...base, locationSharing: { active: 'yes', distanceMeters: 412 } });
  assert.deepEqual(fake.locationSharing, { active: false, distanceMeters: null });
});

// ─── the Redis IO half, against a fake client ───────────────────────────────

function fakeRedis() {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    async set(key, value, ex, ttl) {
      calls.push(['set', key, value, ex, ttl]);
      store.set(key, value);
    },
    async get(key) { calls.push(['get', key]); return store.get(key) ?? null; },
    async del(key) { calls.push(['del', key]); store.delete(key); },
  };
}

test('store: one SET with EX 300 under the request-id key — refreshed on every push', async () => {
  const redis = fakeRedis();
  assert.equal(await storeCustomerLocation('req_1', { lat: 18.4, lng: -66.0 }, redis), true);
  assert.equal(await storeCustomerLocation('req_1', { lat: 18.5, lng: -66.1 }, redis), true);
  assert.equal(redis.calls.length, 2);
  for (const [op, key, , ex, ttl] of redis.calls) {
    assert.equal(op, 'set');
    assert.equal(key, 'shuttle:custloc:req_1');
    assert.equal(ex, 'EX');
    assert.equal(ttl, CUSTOMER_LOC_TTL_S, 'every push re-arms the full TTL');
  }
  const stored = JSON.parse(redis.store.get('shuttle:custloc:req_1'));
  assert.equal(stored.lat, 18.5);
  assert.ok(Number.isFinite(stored.at));
});

test('read round-trips through parseStoredFix; clear deletes the key', async () => {
  const redis = fakeRedis();
  await storeCustomerLocation('req_2', { lat: 18.4, lng: -66.0 }, redis);
  const fix = await readCustomerLocation('req_2', redis);
  assert.equal(fix.lat, 18.4);
  await clearCustomerLocation('req_2', redis);
  assert.equal(redis.store.has('shuttle:custloc:req_2'), false);
  assert.equal(await readCustomerLocation('req_2', redis), null);
});

test('no Redis (null override) = sharing quietly unavailable, never a throw', async () => {
  assert.equal(await storeCustomerLocation('req_3', { lat: 18, lng: -66 }, null), false);
  assert.equal(await readCustomerLocation('req_3', null), null);
  await clearCustomerLocation('req_3', null); // must not throw
});

test('a throwing Redis degrades the same way — ephemeral means losing a push loses nothing', async () => {
  const angry = { async set() { throw new Error('boom'); }, async get() { throw new Error('boom'); }, async del() { throw new Error('boom'); } };
  assert.equal(await storeCustomerLocation('req_4', { lat: 18, lng: -66 }, angry), false);
  assert.equal(await readCustomerLocation('req_4', angry), null);
  await clearCustomerLocation('req_4', angry);
});

// ─── the staff payload — the ONE surface coordinates may leave through ──────

test('waitingCustomerPayload: sharing rows carry lat/lng/ageSeconds; non-sharing rows carry NO coordinate keys', () => {
  const request = {
    id: 'req_9', locationId: 'lax', customerName: 'Juan P.', partySize: 2, bags: 3,
    pickupSpotZoneId: 'zone_b', assignedVehicleId: 'v1', createdAt: new Date(NOW - 12 * 60_000),
  };
  const sharing = waitingCustomerPayload({
    request,
    fix: { lat: 18.44, lng: -66.0, at: NOW - 45_000 },
    assignedVehicle: { id: 'v1', year: 2023, make: 'Ford', model: 'Transit 350', plate: 'IKT-482' },
    now: NOW,
  });
  assert.deepEqual(Object.keys(sharing).sort(), [
    'ageSeconds', 'assignedVehicle', 'bags', 'lat', 'lng', 'locationId',
    'name', 'partySize', 'pickupSpotZoneId', 'requestId', 'sharing', 'waitingMinutes',
  ]);
  assert.equal(sharing.sharing, true);
  assert.equal(sharing.lat, 18.44);
  assert.equal(sharing.ageSeconds, 45);
  assert.equal(sharing.waitingMinutes, 12);
  assert.deepEqual(sharing.assignedVehicle, { vehicleId: 'v1', label: '2023 Ford Transit 350', plate: 'IKT-482' });

  const notSharing = waitingCustomerPayload({ request, fix: null, assignedVehicle: null, now: NOW });
  assert.equal(notSharing.sharing, false);
  assert.equal('lat' in notSharing, false, 'no coordinate keys at all — not even null ones');
  assert.equal('lng' in notSharing, false);
  assert.equal('ageSeconds' in notSharing, false);
  assert.equal(notSharing.assignedVehicle, null);
});
