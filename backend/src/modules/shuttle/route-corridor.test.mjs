import test from 'node:test';
import assert from 'node:assert/strict';

// Pure module — no env, no prisma, importable bare.
import {
  haversineMeters,
  pointToSegmentMeters,
  distanceToPolylineM,
  isOffRoute,
  pointInPolygon,
  isInsideZone,
  createOffRouteTracker,
  createZonePresenceTracker,
  DEFAULT_TOLERANCE_M,
  GAP_RESET_MS,
  COOLDOWN_MS,
} from './route-corridor.js';

// Meters per degree of latitude on the sphere the module uses.
const M_PER_DEG_LAT = (Math.PI / 180) * 6371008.8; // ≈ 111194.93

// MCO-ish corridor: straight east–west line at lat 28.43.
const LAT = 28.43;
const LINE = [{ lat: LAT, lng: -81.40 }, { lat: LAT, lng: -81.30 }];

const within = (actual, expected, relTol) =>
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relTol,
    `expected ${actual} ≈ ${expected} (±${relTol * 100}%)`);

// ── geometry ────────────────────────────────────────────────────────────────

test('haversineMeters: one degree of latitude ≈ 111.19 km; zero for identical points', () => {
  const a = { lat: 28, lng: -81 };
  within(haversineMeters(a, { lat: 29, lng: -81 }), M_PER_DEG_LAT, 0.001);
  assert.equal(haversineMeters(a, a), 0);
});

test('a point ON the polyline is ≈ 0 m away (vertex, mid-segment, and mid-vertex of a bend)', () => {
  assert.ok(distanceToPolylineM({ lat: LAT, lng: -81.40 }, LINE) < 0.01, 'start vertex');
  assert.ok(distanceToPolylineM({ lat: LAT, lng: -81.35 }, LINE) < 0.01, 'mid-segment');
  const bend = [{ lat: 28.40, lng: -81.40 }, { lat: 28.43, lng: -81.35 }, { lat: 28.40, lng: -81.30 }];
  assert.ok(distanceToPolylineM({ lat: 28.43, lng: -81.35 }, bend) < 0.01, 'shared bend vertex');
});

test('perpendicular offsets from an E–W segment come out exact-ish (±2%)', () => {
  for (const meters of [50, 300, 1000, 5000]) {
    const dLat = meters / M_PER_DEG_LAT;
    within(distanceToPolylineM({ lat: LAT + dLat, lng: -81.35 }, LINE), meters, 0.02);
    within(distanceToPolylineM({ lat: LAT - dLat, lng: -81.35 }, LINE), meters, 0.02);
  }
});

test('beyond a segment END the distance is to the endpoint, not the infinite line — matches haversine ±2%', () => {
  const p = { lat: LAT, lng: -81.29 }; // 0.01° east of the east end
  const expected = haversineMeters(p, LINE[1]);
  within(distanceToPolylineM(p, LINE), expected, 0.02);
  assert.ok(expected > 900, 'sanity: the endpoint is ~1 km away');
});

test('distanceToPolylineM takes the MIN over segments (L-shaped route)', () => {
  const L = [
    { lat: 28.40, lng: -81.40 },
    { lat: 28.40, lng: -81.30 }, // east leg
    { lat: 28.50, lng: -81.30 }, // north leg
  ];
  // Just west of the NORTH leg, far from the east leg.
  const p = { lat: 28.47, lng: -81.302 };
  const dNorthLeg = 0.002 * M_PER_DEG_LAT * Math.cos((28.47 * Math.PI) / 180);
  within(distanceToPolylineM(p, L), dNorthLeg, 0.02);
});

test('pointToSegmentMeters handles a degenerate (zero-length) segment as point distance', () => {
  const a = { lat: LAT, lng: -81.35 };
  const p = { lat: LAT + 300 / M_PER_DEG_LAT, lng: -81.35 };
  within(pointToSegmentMeters(p, a, a), 300, 0.02);
});

// ── isOffRoute (corridor verdict) ───────────────────────────────────────────

const ROUTE = { geometryJson: { type: 'polyline', points: LINE }, toleranceM: 300 };
const offsetFix = (meters) => ({ lat: LAT + meters / M_PER_DEG_LAT, lng: -81.35 });

test('isOffRoute: inside vs outside the tolerance boundary', () => {
  const inside = isOffRoute(offsetFix(290), ROUTE);
  assert.equal(inside.off, false);
  within(inside.distanceM, 290, 0.02);
  assert.equal(inside.toleranceM, 300);

  const outside = isOffRoute(offsetFix(310), ROUTE);
  assert.equal(outside.off, true);
  within(outside.distanceM, 310, 0.02);
});

test('isOffRoute: missing tolerance falls back to the 300 m default', () => {
  const r = { geometryJson: { points: LINE }, toleranceM: null };
  assert.equal(isOffRoute(offsetFix(200), r).off, false);
  assert.equal(isOffRoute(offsetFix(400), r).off, true);
  assert.equal(isOffRoute(offsetFix(400), r).toleranceM, DEFAULT_TOLERANCE_M);
});

test('isOffRoute FAILS CLOSED on unusable geometry or fix — never "off" from garbage', () => {
  assert.deepEqual(isOffRoute(offsetFix(9999), { geometryJson: { points: [LINE[0]] }, toleranceM: 300 }),
    { off: false, distanceM: null, toleranceM: 300 });
  assert.equal(isOffRoute(offsetFix(9999), { geometryJson: null, toleranceM: 300 }).off, false);
  assert.equal(isOffRoute({ lat: NaN, lng: -81.35 }, ROUTE).off, false);
  assert.equal(isOffRoute(offsetFix(9999), { geometryJson: { points: [LINE[0], { lat: 999, lng: 0 }] }, toleranceM: 300 }).off, false);
});

// ── zone containment (in-house ENTER/EXIT) ──────────────────────────────────

// Pickup-lot rectangle stored the way the editor stores it: 4 corner points.
const BOX = [
  { lat: 28.435, lng: -81.36 }, // NW
  { lat: 28.435, lng: -81.34 }, // NE
  { lat: 28.425, lng: -81.34 }, // SE
  { lat: 28.425, lng: -81.36 }, // SW
];
const BOX_ZONE = { geometryJson: { type: 'rectangle', points: BOX } };

test('pointInPolygon: center in, far out, corners of the world out', () => {
  assert.equal(pointInPolygon({ lat: 28.43, lng: -81.35 }, BOX), true);
  assert.equal(pointInPolygon({ lat: 28.44, lng: -81.35 }, BOX), false, 'north of the box');
  assert.equal(pointInPolygon({ lat: 28.43, lng: -81.33 }, BOX), false, 'east of the box');
  assert.equal(pointInPolygon({ lat: 0, lng: 0 }, BOX), false);
});

test('pointInPolygon: just-inside/just-outside near the boundary (~10 m either side) resolve correctly', () => {
  const edgeLat = 28.435; // the north edge
  const delta = 10 / M_PER_DEG_LAT; // ≈ 10 m in degrees of latitude
  assert.equal(pointInPolygon({ lat: edgeLat - delta, lng: -81.35 }, BOX), true, '10 m inside');
  assert.equal(pointInPolygon({ lat: edgeLat + delta, lng: -81.35 }, BOX), false, '10 m outside');
});

test('pointInPolygon: concave polygon — the notch is OUT, the arms are IN', () => {
  // U-shape: notch cut into the top between lng -81.355 and -81.345.
  const U = [
    { lat: 28.44, lng: -81.36 },
    { lat: 28.44, lng: -81.355 },
    { lat: 28.43, lng: -81.355 },
    { lat: 28.43, lng: -81.345 },
    { lat: 28.44, lng: -81.345 },
    { lat: 28.44, lng: -81.34 },
    { lat: 28.42, lng: -81.34 },
    { lat: 28.42, lng: -81.36 },
  ];
  assert.equal(pointInPolygon({ lat: 28.435, lng: -81.35 }, U), false, 'inside the notch = outside the zone');
  assert.equal(pointInPolygon({ lat: 28.435, lng: -81.3575 }, U), true, 'west arm');
  assert.equal(pointInPolygon({ lat: 28.435, lng: -81.3425 }, U), true, 'east arm');
  assert.equal(pointInPolygon({ lat: 28.425, lng: -81.35 }, U), true, 'the base under the notch');
});

test('pointInPolygon FAILS CLOSED on unusable geometry or fix — a broken polygon contains nothing', () => {
  assert.equal(pointInPolygon({ lat: 28.43, lng: -81.35 }, BOX.slice(0, 2)), false);
  assert.equal(pointInPolygon({ lat: 28.43, lng: -81.35 }, null), false);
  assert.equal(pointInPolygon({ lat: NaN, lng: -81.35 }, BOX), false);
  assert.equal(pointInPolygon({ lat: 28.43, lng: -81.35 }, [...BOX.slice(0, 2), { lat: 999, lng: 0 }]), false,
    'invalid vertices are dropped, leaving too few');
});

test('isInsideZone reads the zone row shape (geometryJson.points)', () => {
  assert.equal(isInsideZone({ lat: 28.43, lng: -81.35 }, BOX_ZONE), true);
  assert.equal(isInsideZone({ lat: 28.45, lng: -81.35 }, BOX_ZONE), false);
  assert.equal(isInsideZone({ lat: 28.43, lng: -81.35 }, { geometryJson: null }), false);
});

// ── zone presence state machine (ENTER/EXIT) ────────────────────────────────

test('presence: first observation only SEEDS — no ENTER for a van already inside at boot', () => {
  const t = createZonePresenceTracker();
  const out = t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: true, now: T0 });
  assert.equal(out.fire, null);
  assert.equal(out.baseline, true);
  // Staying inside stays silent.
  assert.equal(t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: true, now: T0 + TICK }).fire, null);
});

test('presence: enter then exit emit exactly once each, in order', () => {
  const t = createZonePresenceTracker();
  t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: false, now: T0 }); // baseline outside
  assert.equal(t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: true, now: T0 + TICK }).fire, 'ENTER');
  assert.equal(t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: true, now: T0 + 2 * TICK }).fire, null);
  assert.equal(t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: false, now: T0 + 3 * TICK }).fire, 'EXIT');
  assert.equal(t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: false, now: T0 + 4 * TICK }).fire, null);
});

test('presence: a continuity gap RE-SEEDS — movement during the gap never back-fills an event', () => {
  const t = createZonePresenceTracker();
  t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: false, now: T0 });
  // The van entered during a data gap: first fresh observation re-baselines.
  const out = t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: true, now: T0 + GAP_RESET_MS + TICK });
  assert.equal(out.fire, null);
  assert.equal(out.baseline, true);
  // The NEXT flip fires normally.
  assert.equal(t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: false, now: T0 + GAP_RESET_MS + 2 * TICK }).fire, 'EXIT');
});

test('presence: pairs are independent; reset/prune housekeeping', () => {
  const t = createZonePresenceTracker();
  t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: false, now: T0 });
  t.observe({ zoneId: 'z1', vehicleId: 'v2', inside: true, now: T0 });
  assert.equal(t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: true, now: T0 + TICK }).fire, 'ENTER');
  assert.equal(t.observe({ zoneId: 'z1', vehicleId: 'v2', inside: true, now: T0 + TICK }).fire, null,
    'v2 was already inside — v1\'s state never bleeds over');
  assert.equal(t.size(), 2);
  t.prune(T0 + TICK + 2 * 60 * 60 * 1000);
  assert.equal(t.size(), 0);
  t.observe({ zoneId: 'z1', vehicleId: 'v1', inside: true, now: T0 });
  t.reset();
  assert.equal(t.size(), 0);
});

// ── off-route state machine ─────────────────────────────────────────────────

const TICK = 60_000;
const T0 = new Date('2026-08-25T15:00:00Z').getTime();

/** Run a sequence of 'off'/'on' observations one tick apart; returns fires. */
function run(tracker, seq, { zoneId = 'r1', vehicleId = 'v1', start = T0 } = {}) {
  const fires = [];
  seq.forEach((s, i) => {
    const out = tracker.observe({ zoneId, vehicleId, off: s === 'off', now: start + i * TICK });
    if (out.fire) fires.push({ ...out, i });
  });
  return fires;
}

test('1 off tick = nothing; 2 consecutive = ONE OFF_ROUTE carrying the FIRST tick time', () => {
  const t = createOffRouteTracker();
  assert.deepEqual(run(t, ['off']), []);
  t.reset();
  const fires = run(t, ['off', 'off', 'off', 'off']);
  assert.equal(fires.length, 1, 'one excursion, one alert');
  assert.equal(fires[0].fire, 'OFF_ROUTE');
  assert.equal(fires[0].firstOffAt, T0, 'ref time = FIRST off observation, not the confirming one');
});

test('single-tick flapping (off/on/off/on…) never fires — the debounce eats jitter', () => {
  const t = createOffRouteTracker();
  assert.deepEqual(run(t, ['off', 'on', 'off', 'on', 'off', 'on', 'off']), []);
});

test('recovery needs 2 consecutive on ticks and emits BACK_ON_ROUTE exactly once', () => {
  const t = createOffRouteTracker();
  const fires = run(t, ['off', 'off', 'on', 'off', 'off', 'on', 'on', 'on']);
  //                     └─ fire ─┘   blip + still-off = same excursion  └ recover
  assert.deepEqual(fires.map((f) => f.fire), ['OFF_ROUTE', 'BACK_ON_ROUTE']);
});

test('after a real recovery a NEW excursion fires immediately (recovery re-arms, per spec)', () => {
  const t = createOffRouteTracker();
  const fires = run(t, ['off', 'off', 'on', 'on', 'off', 'off']);
  assert.deepEqual(fires.map((f) => f.fire), ['OFF_ROUTE', 'BACK_ON_ROUTE', 'OFF_ROUTE']);
});

test('COOLDOWN: a data gap must not re-fire the SAME excursion; it re-alerts only after 10 min', () => {
  const t = createOffRouteTracker();
  // Fire at T0+1min…
  run(t, ['off', 'off']);
  // …then a gap long enough to reset continuity, still inside the cooldown.
  let now = T0 + TICK + GAP_RESET_MS + TICK;
  let out;
  out = t.observe({ zoneId: 'r1', vehicleId: 'v1', off: true, now }); now += TICK;
  assert.equal(out.fire, null);
  out = t.observe({ zoneId: 'r1', vehicleId: 'v1', off: true, now }); now += TICK;
  assert.equal(out.fire, null, 'suppressed — same excursion, cooldown holds');
  assert.equal(out.suppressed, true);
  // A second gap AFTER the cooldown expires: the standing condition may
  // re-alert (staff attention is stale by then).
  now = T0 + TICK + COOLDOWN_MS + GAP_RESET_MS + 2 * TICK;
  t.observe({ zoneId: 'r1', vehicleId: 'v1', off: true, now });
  out = t.observe({ zoneId: 'r1', vehicleId: 'v1', off: true, now: now + TICK });
  assert.equal(out.fire, 'OFF_ROUTE');
});

test('a gap-reset pair that proves itself back IN the corridor re-arms silently (no BACK_ON_ROUTE)', () => {
  const t = createOffRouteTracker();
  run(t, ['off', 'off']); // fired
  const base = T0 + TICK + GAP_RESET_MS + TICK;
  // Two on ticks after the gap: no BACK_ON_ROUTE (no observed OFF→ON flip)…
  assert.equal(t.observe({ zoneId: 'r1', vehicleId: 'v1', off: false, now: base }).fire, null);
  assert.equal(t.observe({ zoneId: 'r1', vehicleId: 'v1', off: false, now: base + TICK }).fire, null);
  // …but the cooldown is re-armed: a fresh excursion fires immediately.
  t.observe({ zoneId: 'r1', vehicleId: 'v1', off: true, now: base + 2 * TICK });
  const out = t.observe({ zoneId: 'r1', vehicleId: 'v1', off: true, now: base + 3 * TICK });
  assert.equal(out.fire, 'OFF_ROUTE');
});

test('pairs are independent, reset() clears them, prune() keeps cooling pairs', () => {
  const t = createOffRouteTracker();
  run(t, ['off', 'off'], { vehicleId: 'v1' });
  assert.deepEqual(run(t, ['off', 'off'], { vehicleId: 'v2' }).map((f) => f.fire), ['OFF_ROUTE'],
    'v1 state never bleeds into v2');
  assert.equal(t.size(), 2);
  // Prune far in the future drops idle pairs; inside cooldown they survive.
  t.prune(T0 + 2 * TICK + 5 * 60_000, 60_000); // idle > 1 min but still cooling
  assert.equal(t.size(), 2, 'cooling pairs are kept — their memory IS the cooldown');
  t.prune(T0 + 2 * TICK + 2 * COOLDOWN_MS, 60_000);
  assert.equal(t.size(), 0);
  run(t, ['off', 'off']);
  t.reset();
  assert.equal(t.size(), 0);
});
