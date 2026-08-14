import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineKm,
  geofencedLocations,
  classifyOverduePosition,
  DEFAULT_GEOFENCE_RADIUS_KM,
} from './overdue-geofence.js';

// SJU airport vs Condado — a real ~4 km pair to sanity-check the math.
const SJU = { latitude: 18.4394, longitude: -66.0018 };
const CONDADO = { latitude: 18.4571, longitude: -66.0788 };

test('haversine: SJU airport to Condado is roughly 8 km', () => {
  const d = haversineKm(SJU.latitude, SJU.longitude, CONDADO.latitude, CONDADO.longitude);
  assert.ok(d > 7 && d < 10, `expected ~8km, got ${d}`);
});

test('locations without coordinates never form a geofence', () => {
  const fences = geofencedLocations([
    { id: 'a', name: 'No coords', latitude: null, longitude: null },
    { id: 'b', name: 'Half coords', latitude: 18.4, longitude: null },
    { id: 'c', name: 'Real', latitude: 18.4394, longitude: -66.0018 },
    null,
  ]);
  assert.equal(fences.length, 1);
  assert.equal(fences[0].id, 'c');
  assert.equal(fences[0].radiusKm, DEFAULT_GEOFENCE_RADIUS_KM);
});

test('Decimal-as-string coordinates (Prisma) are accepted', () => {
  const fences = geofencedLocations([
    { id: 'a', latitude: '18.439400', longitude: '-66.001800', geofenceRadiusKm: '1.50' },
  ]);
  assert.equal(fences.length, 1);
  assert.equal(fences[0].radiusKm, 1.5);
});

test('no geofenced locations -> NO_GEOFENCE (never alerts)', () => {
  const out = classifyOverduePosition({ latitude: 18.44, longitude: -66.0 }, [{ id: 'x', latitude: null, longitude: null }]);
  assert.equal(out.verdict, 'NO_GEOFENCE');
});

test('missing position -> NO_POSITION (never alerts)', () => {
  const out = classifyOverduePosition(null, [{ id: 'a', ...SJU }]);
  assert.equal(out.verdict, 'NO_POSITION');
});

test('car on the lot -> INSIDE', () => {
  // ~100m from the fence center, default 0.5 km radius.
  const out = classifyOverduePosition(
    { latitude: 18.4403, longitude: -66.0018 },
    [{ id: 'a', name: 'SJU', ...SJU }]
  );
  assert.equal(out.verdict, 'INSIDE');
  assert.equal(out.nearestLocationId, 'a');
});

test('car across town -> OUTSIDE with distance to the NEAREST branch', () => {
  const out = classifyOverduePosition(CONDADO, [
    { id: 'far', name: 'Mayaguez', latitude: 18.2011, longitude: -67.1391 },
    { id: 'near', name: 'SJU', ...SJU },
  ]);
  assert.equal(out.verdict, 'OUTSIDE');
  assert.equal(out.nearestLocationId, 'near');
  assert.ok(out.distanceKm > 7 && out.distanceKm < 10);
});

test('dropped at ANOTHER branch of the tenant still counts as INSIDE', () => {
  const out = classifyOverduePosition(
    { latitude: 18.2013, longitude: -67.1393 }, // on the Mayaguez lot
    [
      { id: 'sju', name: 'SJU', ...SJU },
      { id: 'mayaguez', name: 'Mayaguez', latitude: 18.2011, longitude: -67.1391 },
    ]
  );
  assert.equal(out.verdict, 'INSIDE');
  assert.equal(out.nearestLocationId, 'mayaguez');
});

test('per-location radius override widens the fence', () => {
  // ~2 km away: outside the default 0.5 radius, inside a 3 km one.
  const pos = { latitude: 18.4574, longitude: -66.0018 };
  const tight = classifyOverduePosition(pos, [{ id: 'a', ...SJU }]);
  const wide = classifyOverduePosition(pos, [{ id: 'a', ...SJU, geofenceRadiusKm: 3 }]);
  assert.equal(tight.verdict, 'OUTSIDE');
  assert.equal(wide.verdict, 'INSIDE');
});
