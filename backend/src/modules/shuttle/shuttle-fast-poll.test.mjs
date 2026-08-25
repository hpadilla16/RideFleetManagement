import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Env BEFORE the import: the scheduler statically imports prisma, the settings
// service, and both provider clients (it is the ONLY file allowed to).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.INTEGRATION_ENC_KEY = process.env.INTEGRATION_ENC_KEY || crypto.randomBytes(32).toString('base64');

const { pollTenant, __resetWriteMemoForTests } = await import('./shuttle-fast-poll.scheduler.js');
// The write memo is process-lifetime by design; these cases replay identical
// fixture eventAts, so each test starts from a clean memo.
test.beforeEach(() => { __resetWriteMemoForTests(); });

// ── the fake world ──────────────────────────────────────────────────────────

const CONFIG = { tenantId: 't1', locationId: 'loc1', mode: 'NON_STOP', vehicleIdsJson: ['v1', 'v2'] };

const ONESTEP_FIX = (externalDeviceId, over = {}) => ({
  externalDeviceId,
  displayName: 'Shuttle',
  licensePlate: 'ABC-123',
  latitude: 18.4381,
  longitude: -66.0043,
  heading: 90,
  speedMph: 24.85,
  eventAt: new Date('2026-08-24T12:00:00Z'),
  ...over,
});

function world({ devices = [], openRequests = 0, watched = true, oneStepReady = true, oneStepFixes = [], voltReady = false, voltFix = null } = {}) {
  const events = [];
  const published = [];
  const warns = [];
  const counters = { deviceQueries: 0, bulkCalls: 0, hasKeyCalls: 0, voltAuths: 0, voltLocates: 0, settingsReads: 0 };
  const deps = {
    prisma: {
      shuttleRequest: { count: async () => openRequests },
      vehicleTelematicsDevice: {
        findMany: async ({ where }) => {
          counters.deviceQueries++;
          // The scheduler must ask for BOTH providers + only active devices.
          assert.deepEqual(where.provider, { in: ['VOLTSWITCH', 'ONESTEPGPS'] });
          assert.equal(where.isActive, true);
          return devices.filter((d) => where.vehicleId.in.includes(d.vehicleId));
        },
      },
      vehicleTelematicsEvent: { create: async ({ data }) => { events.push(data); return data; } },
    },
    logger: { info: () => {}, warn: (msg, meta) => warns.push({ msg, meta }) },
    isWatched: async () => watched,
    publishPosition: async (vehicleId, fix) => { published.push({ vehicleId, fix }); },
    settingsService: {
      getTelematicsConfig: async () => {
        counters.settingsReads++;
        return {
          voltswitchConnectorReady: voltReady,
          voltswitchApiEmail: 'ops@x.co',
          voltswitchApiPassword: 'pw',
        };
      },
    },
    voltswitch: {
      authenticate: async () => { counters.voltAuths++; return { token: 'tk', userHash: 'uh' }; },
      getDeviceLocation: async () => { counters.voltLocates++; return voltFix; },
    },
    onestepgps: {
      hasApiKey: async () => { counters.hasKeyCalls++; return oneStepReady; },
      getDevicesWithPositions: async () => { counters.bulkCalls++; return oneStepFixes; },
    },
  };
  return { deps, events, published, warns, counters };
}

// ── ONESTEPGPS path ─────────────────────────────────────────────────────────

test('an ONESTEPGPS tenant publishes fixes through the house write path (DB row + Redis publish)', async () => {
  const w = world({
    devices: [{ vehicleId: 'v1', externalDeviceId: 'D1', provider: 'ONESTEPGPS' }],
    oneStepFixes: [ONESTEP_FIX('D1'), ONESTEP_FIX('D-unmapped')],
  });
  const out = await pollTenant(CONFIG, w.deps);

  assert.deepEqual(out, { polled: 1, skipped: false });
  assert.equal(w.counters.bulkCalls, 1, 'ONE bulk call per tenant tick');
  // House DB row, same shape the VoltSwitch path writes.
  assert.equal(w.events.length, 1);
  const ev = w.events[0];
  assert.equal(ev.tenantId, 't1');
  assert.equal(ev.vehicleId, 'v1');
  assert.equal(ev.eventType, 'PING');
  assert.equal(ev.latitude, 18.4381);
  assert.equal(ev.longitude, -66.0043);
  assert.equal(ev.speedMph, 24.85);
  assert.equal(ev.heading, 90);
  assert.equal(ev.eventAt.toISOString(), '2026-08-24T12:00:00.000Z');
  assert.deepEqual(JSON.parse(ev.payloadJson), { source: 'SHUTTLE_FAST_POLL' });
  // Redis publish beside it.
  assert.equal(w.published.length, 1);
  assert.equal(w.published[0].vehicleId, 'v1');
  assert.equal(w.published[0].fix.eventAt, '2026-08-24T12:00:00.000Z');
  // A device the tenant never mapped must not be published.
  assert.ok(!w.published.some((p) => p.fix.externalDeviceId === 'D-unmapped'));
});

test('bulk response is filtered to the mapped externalDeviceIds; fixless devices are skipped', async () => {
  const w = world({
    devices: [
      { vehicleId: 'v1', externalDeviceId: 'D1', provider: 'ONESTEPGPS' },
      { vehicleId: 'v2', externalDeviceId: 'D2', provider: 'ONESTEPGPS' },
    ],
    oneStepFixes: [ONESTEP_FIX('D1'), ONESTEP_FIX('D2', { latitude: null })],
  });
  const out = await pollTenant(CONFIG, w.deps);
  assert.equal(out.polled, 1);
  assert.deepEqual(w.published.map((p) => p.vehicleId), ['v1']);
});

test('a tenant with ONESTEPGPS devices but NO stored key never reaches the provider', async () => {
  const w = world({
    devices: [{ vehicleId: 'v1', externalDeviceId: 'D1', provider: 'ONESTEPGPS' }],
    oneStepReady: false,
    oneStepFixes: [ONESTEP_FIX('D1')],
  });
  const out = await pollTenant(CONFIG, w.deps);
  assert.equal(out.polled, 0);
  assert.equal(w.counters.hasKeyCalls, 1);
  assert.equal(w.counters.bulkCalls, 0, 'no key → zero provider calls');
  assert.equal(w.published.length, 0);
});

// ── VoltSwitch path untouched ───────────────────────────────────────────────

test('a VoltSwitch-only tenant uses the original per-device path and never touches OneStepGPS', async () => {
  const w = world({
    devices: [{ vehicleId: 'v1', externalDeviceId: 'IMEI-1', provider: 'VOLTSWITCH' }],
    voltReady: true,
    voltFix: { latitude: 18.4, longitude: -66.0, heading: 10, speedMph: 30, eventAt: '2026-08-24T12:00:00Z' },
  });
  const out = await pollTenant(CONFIG, w.deps);
  assert.equal(out.polled, 1);
  assert.equal(w.counters.voltAuths, 1);
  assert.equal(w.counters.voltLocates, 1);
  assert.equal(w.counters.hasKeyCalls, 0, 'no ONESTEPGPS devices → OneStepGPS never consulted');
  assert.equal(w.counters.bulkCalls, 0);
  assert.equal(w.events.length, 1);
  assert.equal(w.published.length, 1);
  assert.deepEqual(JSON.parse(w.events[0].payloadJson), { source: 'SHUTTLE_FAST_POLL' });
});

test('VoltSwitch not ready → its branch is silent, and OneStepGPS still runs (failure isolation)', async () => {
  const w = world({
    devices: [
      { vehicleId: 'v1', externalDeviceId: 'IMEI-1', provider: 'VOLTSWITCH' },
      { vehicleId: 'v2', externalDeviceId: 'D2', provider: 'ONESTEPGPS' },
    ],
    voltReady: false,
    oneStepFixes: [ONESTEP_FIX('D2')],
  });
  const out = await pollTenant(CONFIG, w.deps);
  assert.equal(w.counters.voltAuths, 0);
  assert.equal(out.polled, 1);
  assert.deepEqual(w.published.map((p) => p.vehicleId), ['v2']);
});

test('a OneStepGPS outage does not blind the VoltSwitch shuttles', async () => {
  const w = world({
    devices: [
      { vehicleId: 'v1', externalDeviceId: 'IMEI-1', provider: 'VOLTSWITCH' },
      { vehicleId: 'v2', externalDeviceId: 'D2', provider: 'ONESTEPGPS' },
    ],
    voltReady: true,
    voltFix: { latitude: 18.4, longitude: -66.0, heading: 10, speedMph: 30, eventAt: '2026-08-24T12:00:00Z' },
  });
  w.deps.onestepgps.getDevicesWithPositions = async () => { throw new Error('503 from provider'); };
  const out = await pollTenant(CONFIG, w.deps);
  assert.equal(out.polled, 1, 'VoltSwitch fix still published');
  assert.deepEqual(w.published.map((p) => p.vehicleId), ['v1']);
  assert.ok(w.warns.some((x) => /onestepgps branch failed/.test(x.msg)));
});

test('mixed tenant: both providers publish in the same tick', async () => {
  const w = world({
    devices: [
      { vehicleId: 'v1', externalDeviceId: 'IMEI-1', provider: 'VOLTSWITCH' },
      { vehicleId: 'v2', externalDeviceId: 'D2', provider: 'ONESTEPGPS' },
    ],
    voltReady: true,
    voltFix: { latitude: 18.4, longitude: -66.0, heading: 10, speedMph: 30, eventAt: '2026-08-24T12:00:00Z' },
    oneStepFixes: [ONESTEP_FIX('D2')],
  });
  const out = await pollTenant(CONFIG, w.deps);
  assert.equal(out.polled, 2);
  assert.deepEqual(w.published.map((p) => p.vehicleId).sort(), ['v1', 'v2']);
});

// ── demand-driven guarantee preserved ───────────────────────────────────────

test('nobody watching + no open requests → zero provider calls, zero device queries', async () => {
  const w = world({
    devices: [{ vehicleId: 'v1', externalDeviceId: 'D1', provider: 'ONESTEPGPS' }],
    watched: false,
    openRequests: 0,
    oneStepFixes: [ONESTEP_FIX('D1')],
  });
  const out = await pollTenant(CONFIG, w.deps);
  assert.deepEqual(out, { polled: 0, skipped: true });
  assert.equal(w.counters.deviceQueries, 0);
  assert.equal(w.counters.hasKeyCalls, 0);
  assert.equal(w.counters.bulkCalls, 0);
});

test('an open shuttle request keeps the poll alive even with nobody watching', async () => {
  const w = world({
    devices: [{ vehicleId: 'v1', externalDeviceId: 'D1', provider: 'ONESTEPGPS' }],
    watched: false,
    openRequests: 1,
    oneStepFixes: [ONESTEP_FIX('D1')],
  });
  const out = await pollTenant(CONFIG, w.deps);
  assert.equal(out.polled, 1);
});

test('a fix with no eventAt gets a fresh timestamp (never a 1970 row)', async () => {
  const before = Date.now();
  const w = world({
    devices: [{ vehicleId: 'v1', externalDeviceId: 'D1', provider: 'ONESTEPGPS' }],
    oneStepFixes: [ONESTEP_FIX('D1', { eventAt: null })],
  });
  await pollTenant(CONFIG, w.deps);
  assert.equal(w.events.length, 1);
  assert.ok(w.events[0].eventAt.getTime() >= before);
});
