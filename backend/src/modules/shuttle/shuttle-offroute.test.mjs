import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Env BEFORE the imports: the scheduler statically imports prisma, the
// provider client and the zones/tracker services.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.INTEGRATION_ENC_KEY = process.env.INTEGRATION_ENC_KEY || crypto.randomBytes(32).toString('base64');

const { createOffRouteTracker, createZonePresenceTracker } = await import('./route-corridor.js');
const { detectInHouseEvents, __resetInHouseDetectionForTests } = await import('./shuttle-alerts.scheduler.js');

test.beforeEach(() => { __resetInHouseDetectionForTests(); });

const NOW = new Date('2026-08-25T15:00:00Z').getTime();
const TICK = 60_000;

// MCO-ish corridor along lat 28.43; ~1 km north of it is decisively off a
// 300 m corridor, mid-line is decisively on it. The pickup-lot BOX contains
// the mid-line point and excludes the northern one — so ONE pair of fixes
// exercises both detections.
const LINE = [{ lat: 28.43, lng: -81.40 }, { lat: 28.43, lng: -81.30 }];
const ON_FIX = { latitude: 28.43, longitude: -81.35 };   // on corridor, inside BOX
const OFF_FIX = { latitude: 28.439, longitude: -81.35 }; // off corridor, outside BOX
const BOX = [
  { lat: 28.435, lng: -81.36 }, // NW
  { lat: 28.435, lng: -81.34 }, // NE
  { lat: 28.425, lng: -81.34 }, // SE
  { lat: 28.425, lng: -81.36 }, // SW
];

const ROUTE = {
  id: 'r1', tenantId: 't1', locationId: 'locA', name: 'Base ⇄ MCO', kind: 'ROUTE',
  isPickupSpot: false, geometryJson: { type: 'polyline', points: LINE }, toleranceM: 300,
  notifyOnEnter: false, notifyOnExit: false, notifyOnOffRoute: true,
  active: true, providerSyncStatus: 'ACTIVE', providerSyncError: null,
};

const PICKUP_ZONE = {
  id: 'z1', tenantId: 't1', locationId: 'locA', name: 'Pickup Lot B', kind: 'ZONE',
  isPickupSpot: true, walkingDirections: 'Sign B-4',
  geometryJson: { type: 'rectangle', points: BOX }, toleranceM: null,
  notifyOnEnter: true, notifyOnExit: false, notifyOnOffRoute: false,
  active: true, providerSyncStatus: 'SYNCED', providerSyncError: null,
};

function world({
  zones = [ROUTE],
  configs = [{ locationId: 'locA', tenantId: 't1', vehicleIdsJson: ['v1'], alertRecipientsJson: [{ name: 'HP', email: 'hp@ride.co', channels: ['EMAIL'] }] }],
  devices = [{ externalDeviceId: 'dev-1', vehicleId: 'v1' }],
  housePositions = {},
  bulkFixes = null, // null = provider has nothing
  hasKey = true,
  requests = [],
} = {}) {
  const alertRows = [];
  const emails = [];
  const smses = [];
  const warns = [];
  const infos = [];
  const updateManyCalls = [];
  let bulkCalls = 0;
  let idSeq = 0;
  const clock = { now: NOW };

  const deps = {
    now: () => clock.now,
    logger: {
      info: (msg, meta) => infos.push({ msg, meta }),
      warn: (msg, meta) => warns.push({ msg, meta }),
    },
    provider: {
      hasApiKey: async () => hasKey,
      getDevicesWithPositions: async () => { bulkCalls++; return bulkFixes || []; },
      listRawAlerts: async () => [],
    },
    offRouteTracker: createOffRouteTracker(),
    zonePresenceTracker: createZonePresenceTracker(),
    latestPositionsByVehicle: async (ids) => {
      const out = {};
      for (const id of ids) if (housePositions[id]) out[id] = { ...housePositions[id], vehicleId: id };
      return out;
    },
    mailer: { sendEmail: async (args) => { emails.push(args); } },
    smsSend: async (args) => { smses.push(args); },
    resolveBrand: async () => ({ companyName: 'RideFleet' }),
    prisma: {
      shuttleZone: {
        findMany: async ({ where }) => zones.filter((z) => z.tenantId === where.tenantId && z.active === where.active),
        updateMany: async (args) => {
          updateManyCalls.push(args);
          for (const z of zones) {
            if (args.where.id.in.includes(z.id)) Object.assign(z, args.data);
          }
          return { count: args.where.id.in.length };
        },
      },
      shuttleTrackerConfig: {
        findMany: async ({ where }) => configs.filter((c) => c.tenantId === where.tenantId
          && where.locationId.in.includes(c.locationId)),
        findFirst: async ({ where }) => configs.find((c) => c.locationId === where.locationId && c.tenantId === where.tenantId) || null,
      },
      vehicleTelematicsDevice: {
        findMany: async ({ where }) => devices.filter((d) => where.vehicleId.in.includes(d.vehicleId)),
      },
      shuttleAlert: {
        create: async ({ data }) => {
          if (alertRows.some((r) => r.tenantId === data.tenantId && r.providerRef === data.providerRef)) {
            const err = new Error('Unique constraint failed'); err.code = 'P2002'; throw err;
          }
          const row = { id: `al_${++idSeq}`, staffNotifiedAt: null, arrivalNotifiedAt: null, ...data };
          alertRows.push(row);
          return row;
        },
        update: async ({ where, data }) => {
          const row = alertRows.find((r) => r.id === where.id);
          Object.assign(row || {}, data);
          return row;
        },
      },
      shuttleRequest: { findMany: async () => requests },
      location: { findFirst: async () => ({ name: 'MCO Airport' }) },
      vehicle: { findFirst: async () => ({ make: 'Ford', model: 'Transit', plate: 'IKT-482' }) },
    },
  };
  return {
    deps, alertRows, emails, smses, warns, infos, updateManyCalls, clock,
    bulkCallCount: () => bulkCalls,
    setHousePosition: (id, fix) => { housePositions[id] = fix; },
  };
}

const freshFix = (fix, clock, ageMs = 30_000) => ({ ...fix, eventAt: new Date(clock.now - ageMs).toISOString() });

/** Advance one worker tick: refresh the house fix, run the sweep, bump the clock. */
async function tickWith(w, fix, { ageMs } = {}) {
  w.setHousePosition('v1', freshFix(fix, w.clock, ageMs));
  const out = await detectInHouseEvents('t1', w.deps);
  w.clock.now += TICK;
  return out;
}

// ── ROUTE corridors: debounce → alert → recovery ────────────────────────────

test('one off tick = NO alert; the second consecutive one creates OFF_ROUTE + staff email, exactly once', async () => {
  const w = world();
  let out = await tickWith(w, OFF_FIX);
  assert.equal(out.created, 0, 'debounce: first off tick is silent');
  assert.equal(w.alertRows.length, 0);

  out = await tickWith(w, OFF_FIX);
  assert.equal(out.created, 1);
  assert.equal(w.alertRows.length, 1);
  const row = w.alertRows[0];
  assert.equal(row.type, 'OFF_ROUTE');
  assert.equal(row.zoneId, 'r1');
  assert.equal(row.vehicleId, 'v1');
  assert.equal(row.providerRef, `offroute:r1:v1:${Math.floor(NOW / 60000)}`,
    'ref minute = the FIRST detection tick, not the confirming one');
  const raw = JSON.parse(row.rawJson);
  assert.equal(raw.toleranceM, 300);
  assert.ok(raw.distanceM > 900 && raw.distanceM < 1100, 'distance recorded (~1 km)');
  assert.ok(!('lat' in raw) && !('lng' in raw) && !('latitude' in raw) && !('longitude' in raw),
    'NO coordinates in rawJson');
  assert.equal(w.emails.length, 1, 'staff fan-out through the existing recipients path');
  assert.match(w.emails[0].subject, /left the route corridor/);
  assert.ok(row.staffNotifiedAt instanceof Date);

  // Still off next tick: same excursion, no second alert, no second email.
  out = await tickWith(w, OFF_FIX);
  assert.equal(out.created, 0);
  assert.equal(w.emails.length, 1);
});

test('IDEMPOTENT REF: a state-lost re-detection in the same minute collapses on the unique (no dupe, no re-notify)', async () => {
  const w = world();
  // Two off observations inside the same minute → fire (ref minute = NOW's).
  w.setHousePosition('v1', freshFix(OFF_FIX, w.clock));
  await detectInHouseEvents('t1', w.deps);
  const out1 = await detectInHouseEvents('t1', w.deps);
  assert.equal(out1.created, 1);
  // Fresh trackers (≈ a worker restart mid-minute) re-detect the same
  // excursion in the same minute bucket → P2002 no-op.
  w.deps.offRouteTracker = createOffRouteTracker();
  w.deps.zonePresenceTracker = createZonePresenceTracker();
  await detectInHouseEvents('t1', w.deps);
  const out2 = await detectInHouseEvents('t1', w.deps);
  assert.equal(out2.created, 0, 'duplicate ref collapsed');
  assert.equal(w.alertRows.length, 1);
  assert.equal(w.emails.length, 1, 'fan-out only for rows that actually inserted');
});

test('recovery: 2 consecutive in-corridor ticks emit BACK_ON_ROUTE, FEED-ONLY (no email/SMS)', async () => {
  const w = world();
  await tickWith(w, OFF_FIX);
  await tickWith(w, OFF_FIX); // OFF_ROUTE fired
  let out = await tickWith(w, ON_FIX);
  assert.equal(out.created, 0, 'one on tick is not a recovery');
  out = await tickWith(w, ON_FIX);
  assert.equal(out.created, 1);
  assert.equal(out.backOnRoute, 1);
  const back = w.alertRows[1];
  assert.equal(back.type, 'BACK_ON_ROUTE');
  assert.match(back.providerRef, /^backonroute:r1:v1:\d+$/);
  assert.equal(w.emails.length, 1, 'BACK_ON_ROUTE never emails');
  assert.equal(w.smses.length, 0);
  assert.equal(back.staffNotifiedAt, null);
});

test('flapping single ticks never alert on a ROUTE; a vehicle that stays on-route never alerts', async () => {
  const w = world();
  for (const fix of [ON_FIX, OFF_FIX, ON_FIX, OFF_FIX, ON_FIX, ON_FIX]) {
    await tickWith(w, fix);
  }
  assert.equal(w.alertRows.length, 0);
});

// ── staleness rules (shared by both detections) ─────────────────────────────

test('a fix older than 5 min SKIPS the vehicle — stale data never alarms and never advances the machines', async () => {
  const w = world({ zones: [ROUTE, PICKUP_ZONE] });
  let out = await tickWith(w, OFF_FIX, { ageMs: 6 * 60_000 });
  assert.equal(out.skippedStale, 2, 'route AND zone both skipped the stale vehicle');
  out = await tickWith(w, OFF_FIX, { ageMs: 6 * 60_000 });
  assert.equal(out.skippedStale, 2);
  assert.equal(w.alertRows.length, 0, 'two stale "off" fixes are not two off ticks');
});

test('a fix older than 90s triggers ONE bulk provider refresh per tick, and the fresh fix drives detection', async () => {
  const w = world({ bulkFixes: [] });
  // House fix is 3 min old and OFF-route; the provider answers with a FRESH
  // on-route fix — no alert may fire from the stale one.
  w.deps.provider.getDevicesWithPositions = async () => {
    w.bulk = (w.bulk || 0) + 1;
    return [{ externalDeviceId: 'dev-1', latitude: ON_FIX.latitude, longitude: ON_FIX.longitude, eventAt: new Date(w.clock.now - 5_000).toISOString() }];
  };
  let out = await tickWith(w, OFF_FIX, { ageMs: 3 * 60_000 });
  assert.equal(out.refreshed, 1);
  assert.equal(w.bulk, 1, 'exactly one bulk call this tick');
  out = await tickWith(w, OFF_FIX, { ageMs: 3 * 60_000 });
  assert.equal(w.bulk, 2, 'one bulk call per tick, not per vehicle or per zone');
  assert.equal(w.alertRows.length, 0, 'the fresh on-route fix won over the stale off-route one');
});

test('bulk refresh returning a fresh OFF-route fix leads to a normal 2-tick alert', async () => {
  const w = world();
  w.deps.provider.getDevicesWithPositions = async () => [
    { externalDeviceId: 'dev-1', latitude: OFF_FIX.latitude, longitude: OFF_FIX.longitude, eventAt: new Date(w.clock.now - 5_000).toISOString() },
  ];
  await tickWith(w, ON_FIX, { ageMs: 4 * 60_000 }); // stale house fix, fresh provider fix = off
  const out = await tickWith(w, ON_FIX, { ageMs: 4 * 60_000 });
  assert.equal(out.created, 1);
  assert.equal(w.alertRows[0].type, 'OFF_ROUTE');
});

test('NO API key: no bulk call even for stale-ish fixes; house fixes still detect (VoltSwitch/simulator tenants)', async () => {
  const w = world({ hasKey: false });
  // 2 min old: stale enough to WANT a refresh, still fresh enough to use.
  await tickWith(w, OFF_FIX, { ageMs: 2 * 60_000 });
  const out = await tickWith(w, OFF_FIX, { ageMs: 2 * 60_000 });
  assert.equal(out.created, 1);
  assert.equal(w.bulkCallCount(), 0);
});

test('a broken bulk refresh degrades gracefully: warn + stale vehicles skipped, nothing crashes', async () => {
  const w = world();
  w.deps.provider.getDevicesWithPositions = async () => { throw new Error('503 from provider'); };
  const out = await tickWith(w, OFF_FIX, { ageMs: 6 * 60_000 });
  assert.equal(out.skippedStale, 1);
  assert.equal(out.created, 0);
  assert.ok(w.warns.some((x) => x.msg.includes('bulk position refresh failed')));
});

// ── ZONE polygons: baseline seeding + ENTER/EXIT ────────────────────────────

test('BASELINE: a van already inside a zone at boot emits NOTHING — transitions after that emit once each', async () => {
  const w = world({ zones: [PICKUP_ZONE] });
  let out = await tickWith(w, ON_FIX); // inside — seeds only
  assert.equal(out.created, 0, 'first observation is a baseline, never an ENTER');
  out = await tickWith(w, ON_FIX);     // still inside
  assert.equal(out.created, 0);

  out = await tickWith(w, OFF_FIX);    // inside → outside
  assert.equal(out.created, 1);
  assert.equal(w.alertRows[0].type, 'EXIT');
  assert.equal(w.alertRows[0].zoneId, 'z1');
  assert.match(w.alertRows[0].providerRef, /^zonedet:z1:v1:EXIT:\d+$/);

  out = await tickWith(w, ON_FIX);     // outside → inside
  assert.equal(out.created, 1);
  assert.equal(w.alertRows[1].type, 'ENTER');
  assert.match(w.alertRows[1].providerRef, /^zonedet:z1:v1:ENTER:\d+$/);

  out = await tickWith(w, ON_FIX);     // no flip, no repeat
  assert.equal(out.created, 0);
});

test('prefs gate the NOTIFICATIONS, never the row: EXIT with notifyOnExit=false is feed-only; ENTER emails', async () => {
  const w = world({ zones: [PICKUP_ZONE] }); // notifyOnEnter: true, notifyOnExit: false
  await tickWith(w, ON_FIX);   // baseline inside
  let out = await tickWith(w, OFF_FIX); // EXIT
  assert.equal(out.created, 1);
  assert.equal(out.staffAttempts, 0);
  assert.equal(w.emails.length, 0, 'notifyOnExit off = no email, row still exists');
  out = await tickWith(w, ON_FIX); // ENTER
  assert.equal(out.staffAttempts, 1);
  assert.equal(w.emails.length, 1);
  assert.match(w.emails[0].subject, /entered/);
});

test('PICKUP-SPOT ENTER flows through the EXISTING arrival fan-out: customer SMS + arrivalNotifiedAt stamp', async () => {
  const w = world({
    zones: [PICKUP_ZONE],
    requests: [
      { id: 'r-opted', smsOptIn: true, customerPhone: '+17875550100', reservation: { customer: { locale: 'es' } } },
      { id: 'r-noopt', smsOptIn: false, customerPhone: '+17875550200', reservation: null },
    ],
  });
  await tickWith(w, OFF_FIX);              // baseline outside
  const out = await tickWith(w, ON_FIX);   // ENTER the pickup spot
  assert.equal(out.created, 1);
  assert.equal(out.arrivalSms, 1, 'only the opted-in open request gets the SMS');
  assert.equal(w.smses.length, 1);
  assert.equal(w.smses[0].to, '+17875550100');
  assert.match(w.smses[0].body, /tu shuttle llegó a Pickup Lot B/);
  assert.match(w.smses[0].body, /Sign B-4/, 'the spot\'s walking text rides along');
  const row = w.alertRows.find((r) => r.type === 'ENTER');
  assert.ok(row.arrivalNotifiedAt instanceof Date, 'processed-marker stamped, same as the provider path');
});

test('route + zone detect in ONE sweep with their own tempos: EXIT after 1 tick, OFF_ROUTE after 2', async () => {
  const w = world({ zones: [ROUTE, PICKUP_ZONE] });
  await tickWith(w, ON_FIX);            // baseline inside + corridor on
  let out = await tickWith(w, OFF_FIX); // zone flips immediately; corridor debounce tick 1
  assert.deepEqual(w.alertRows.map((r) => r.type), ['EXIT']);
  assert.equal(out.created, 1);
  out = await tickWith(w, OFF_FIX);     // corridor debounce tick 2 → OFF_ROUTE
  assert.deepEqual(w.alertRows.map((r) => r.type), ['EXIT', 'OFF_ROUTE']);
  assert.equal(out.created, 1);
});

// ── scoping + self-heal + inert states ──────────────────────────────────────

test('tenant with no ZONE rows and no armed route (notifyOnOffRoute off) is skipped entirely', async () => {
  const w = world({ zones: [{ ...ROUTE, notifyOnOffRoute: false }] });
  const out = await tickWith(w, OFF_FIX);
  assert.equal(out.skipped, true);
  assert.equal(w.alertRows.length, 0);
});

test('a route only watches ITS location\'s configured vehicles', async () => {
  const w = world({
    configs: [
      { locationId: 'locA', tenantId: 't1', vehicleIdsJson: [], alertRecipientsJson: [] },      // route's sede: no vans
      { locationId: 'locB', tenantId: 't1', vehicleIdsJson: ['v1'], alertRecipientsJson: [] },  // other sede has v1
    ],
  });
  // v1 (locB's van) is off locA's corridor — but it is not locA's vehicle.
  await tickWith(w, OFF_FIX);
  const out = await tickWith(w, OFF_FIX);
  assert.equal(out.skipped, true, 'no vehicles for the watched locations = nothing to evaluate');
  assert.equal(w.alertRows.length, 0);
});

test('SELF-HEAL: legacy UNSUPPORTED routes flip to ACTIVE on the first sweep, logged, and detect the same tick', async () => {
  const legacyRoute = { ...ROUTE, providerSyncStatus: 'UNSUPPORTED' };
  const w = world({ zones: [legacyRoute] });
  await tickWith(w, OFF_FIX);
  assert.equal(legacyRoute.providerSyncStatus, 'ACTIVE');
  assert.equal(w.updateManyCalls.length, 1);
  assert.deepEqual(w.updateManyCalls[0].data, { providerSyncStatus: 'ACTIVE', providerSyncError: null });
  assert.ok(w.infos.some((x) => x.msg.includes('legacy ROUTE rows now ACTIVE')));
  const out = await tickWith(w, OFF_FIX);
  assert.equal(out.created, 1, 'the healed route detects without a re-save');
  // Second sweep: nothing left to heal.
  assert.equal(w.updateManyCalls.length, 1);
});

test('respects the recipients list: no recipients = feed row only, no email attempts', async () => {
  const w = world({
    configs: [{ locationId: 'locA', tenantId: 't1', vehicleIdsJson: ['v1'], alertRecipientsJson: [] }],
  });
  await tickWith(w, OFF_FIX);
  const out = await tickWith(w, OFF_FIX);
  assert.equal(out.created, 1);
  assert.equal(out.staffAttempts, 0);
  assert.equal(w.emails.length, 0);
});
