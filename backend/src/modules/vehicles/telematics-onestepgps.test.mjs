import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Env BEFORE the import: prisma.js wants a DATABASE_URL shape, the crypto lib
// wants a key, and the client reads its timeout at module load — a tiny one so
// the timeout test does not stall the suite.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');
process.env.ONESTEPGPS_TIMEOUT_MS = '80';

const {
  speedToMph,
  parseRfc3339,
  normalizeDeviceInfo,
  getDevicesWithPositions,
  listDevices,
  testConnection,
  setApiKey,
  getApiKey,
  hasApiKey,
  clearApiKey,
  getCredentialStatus,
  OneStepGpsAuthError,
  _setPrismaForTests,
  _setFetchForTests,
  _resetSpeedUnitWarningsForTests,
} = await import('./telematics-onestepgps.js');

// ── fakes ───────────────────────────────────────────────────────────────────

function fakeDb() {
  const store = new Map();
  const keyOf = (w) => `${w.tenantId}|${w.sourceSystem}`;
  const integrationCredential = {
    upsert: async ({ where, create, update }) => {
      const k = keyOf(where.tenantId_sourceSystem);
      const existing = store.get(k);
      const row = existing
        ? { ...existing, ...update }
        : { id: `cred_${store.size + 1}`, ...create };
      store.set(k, row);
      return row;
    },
    findUnique: async ({ where }) => store.get(keyOf(where.tenantId_sourceSystem)) || null,
    deleteMany: async ({ where }) => {
      const had = store.delete(`${where.tenantId}|${where.sourceSystem}`);
      return { count: had ? 1 : 0 };
    },
    update: async ({ where, data }) => {
      const row = store.get(keyOf(where.tenantId_sourceSystem));
      if (!row) throw new Error('record not found');
      Object.assign(row, data);
      return row;
    },
  };
  // Disjoint-storage invariant (the VoltSwitch erase-bug regression): the
  // OneStepGPS key must live ONLY in IntegrationCredential. Any read or write
  // of the appSetting table (where telematicsConfig lives) from this client
  // blows the test up.
  const appSetting = new Proxy({}, {
    get() { throw new Error('onestepgps client touched appSetting — the key must not live in telematicsConfig'); },
  });
  return { prisma: { integrationCredential, appSetting }, store };
}

const jsonResponse = (data, { ok = true, status = 200, text = '' } = {}) => ({
  ok, status,
  json: async () => data,
  text: async () => text,
});

function useDb() {
  const world = fakeDb();
  _setPrismaForTests(world.prisma);
  return world;
}

afterEach(() => {
  _setPrismaForTests(null);
  _setFetchForTests(null);
  _resetSpeedUnitWarningsForTests();
});

// ── speed conversion (the trap the contract doc warns about) ────────────────

test('speedToMph honors the unit tag: km/h converts, mph passes through', () => {
  assert.equal(speedToMph({ value: 100, unit: 'km/h' }), 62.14);
  assert.equal(speedToMph({ value: 0, unit: 'km/h' }), 0);
  assert.equal(speedToMph({ value: 60, unit: 'mph' }), 60);
  assert.equal(speedToMph({ value: 50, unit: 'kph' }), 31.07);
});

test('speedToMph: unknown unit warns ONCE and is treated as km/h', () => {
  const warns = [];
  const warn = (msg, meta) => warns.push({ msg, meta });
  assert.equal(speedToMph({ value: 100, unit: 'knots' }, warn), 62.14);
  assert.equal(speedToMph({ value: 100, unit: 'knots' }, warn), 62.14);
  assert.equal(warns.length, 1);
  assert.match(warns[0].msg, /unknown speed unit/);
  assert.equal(warns[0].meta.unit, 'knots');
});

test('speedToMph: bare number is the ambiguous top-level field — treated as native km/h', () => {
  assert.equal(speedToMph(100), 62.14);
});

test('speedToMph: missing, garbage, and negative values are null', () => {
  assert.equal(speedToMph(null), null);
  assert.equal(speedToMph(undefined), null);
  assert.equal(speedToMph({ value: 'x', unit: 'km/h' }), null);
  assert.equal(speedToMph({ value: -5, unit: 'km/h' }), null);
  assert.equal(speedToMph('garbage'), null);
});

// ── RFC3339 + normalization ─────────────────────────────────────────────────

test('parseRfc3339 parses UTC timestamps and rejects garbage', () => {
  const d = parseRfc3339('2018-08-27T05:34:55Z');
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), '2018-08-27T05:34:55.000Z');
  assert.equal(parseRfc3339('not-a-date'), null);
  assert.equal(parseRfc3339(''), null);
  assert.equal(parseRfc3339(null), null);
});

const RAW_DEVICE = {
  device_id: 'dev-1',
  display_name: 'Shuttle 1',
  license_plate: 'ABC-123',
  active_state: 'active',
  latest_device_point: {
    dt_server: '2026-08-24T12:00:10Z',
    dt_tracker: '2026-08-24T12:00:00Z',
    lat: 18.4381, lng: -66.0043,
    angle: 146,
    speed: 40, // ambiguous top-level — must NOT win over the tagged detail
    device_point_detail: {
      speed: { value: 40, unit: 'km/h', display: '40 km/h' },
      heading: 146,
    },
  },
};

test('normalizeDeviceInfo maps the contract shape: dt_tracker as eventAt, angle as heading, tagged speed', () => {
  const d = normalizeDeviceInfo(RAW_DEVICE);
  assert.equal(d.externalDeviceId, 'dev-1');
  assert.equal(d.displayName, 'Shuttle 1');
  assert.equal(d.licensePlate, 'ABC-123');
  assert.equal(d.latitude, 18.4381);
  assert.equal(d.longitude, -66.0043);
  assert.equal(d.heading, 146);
  assert.equal(d.speedMph, 24.85); // 40 km/h
  assert.equal(d.eventAt.toISOString(), '2026-08-24T12:00:00.000Z');
});

test('normalizeDeviceInfo falls back to top-level lat/lng + dt_tracker when there is no point', () => {
  const d = normalizeDeviceInfo({ device_id: 'dev-2', lat: 18.1, lng: -66.1, dt_tracker: '2026-08-24T11:00:00Z' });
  assert.equal(d.latitude, 18.1);
  assert.equal(d.longitude, -66.1);
  assert.equal(d.eventAt.toISOString(), '2026-08-24T11:00:00.000Z');
  assert.equal(d.speedMph, null);
});

test('normalizeDeviceInfo: no device_id → null; missing coords stay null', () => {
  assert.equal(normalizeDeviceInfo({ display_name: 'ghost' }), null);
  assert.equal(normalizeDeviceInfo(null), null);
  const d = normalizeDeviceInfo({ device_id: 'dev-3' });
  assert.equal(d.latitude, null);
  assert.equal(d.longitude, null);
});

// ── credential storage ──────────────────────────────────────────────────────

test('setApiKey encrypts at rest, getApiKey round-trips, hasApiKey/clearApiKey work', async () => {
  const { store } = useDb();
  await setApiKey('t1', 'sk-live-SECRET', 'user-1');

  const row = store.get('t1|ONESTEPGPS');
  assert.ok(row, 'credential row stored');
  assert.ok(!String(row.encryptedPayload).includes('sk-live-SECRET'), 'key never stored in the clear');
  assert.equal(row.rotatedByUserId, 'user-1');

  assert.equal(await getApiKey('t1'), 'sk-live-SECRET');
  assert.equal(await hasApiKey('t1'), true);
  assert.equal(await hasApiKey('t2'), false);

  const status = await getCredentialStatus('t1');
  assert.equal(status.hasApiKey, true);
  assert.ok(!JSON.stringify(status).includes('sk-live-SECRET'), 'status never carries the key');

  await clearApiKey('t1');
  assert.equal(await hasApiKey('t1'), false);
  await assert.rejects(() => getApiKey('t1'), OneStepGpsAuthError);
});

test('rotating the key resets the test status (caller must re-test)', async () => {
  const { store } = useDb();
  await setApiKey('t1', 'first-key');
  store.get('t1|ONESTEPGPS').lastTestStatus = 'OK';
  await setApiKey('t1', 'second-key');
  assert.equal(store.get('t1|ONESTEPGPS').lastTestStatus, null);
  assert.equal(await getApiKey('t1'), 'second-key');
});

// ── bulk fetch + defensive parsing ──────────────────────────────────────────

test('getDevicesWithPositions: one bulk call, Bearer auth, no api-key query param, malformed entries skipped', async () => {
  useDb();
  await setApiKey('t1', 'sk-bulk-key');
  const calls = [];
  _setFetchForTests(async (url, opts) => {
    calls.push({ url, opts });
    return jsonResponse([
      RAW_DEVICE,
      { device_id: 'dev-nofix', display_name: 'No fix yet' },   // missing lat/lng → skipped
      { display_name: 'no id' },                                 // no device_id → skipped
      null,                                                      // malformed → skipped
      { device_id: 'dev-4', lat: '18.2', lng: '-66.2', dt_tracker: 'garbage' }, // string coords ok, bad date → null eventAt
    ]);
  });

  const fixes = await getDevicesWithPositions('t1');
  assert.equal(calls.length, 1, 'exactly ONE bulk call');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://track.onestepgps.com/v3/api/public/device-info');
  assert.equal(url.searchParams.get('latest_device_point'), 'true');
  assert.equal(url.searchParams.get('lat_lng'), 'true');
  assert.equal(url.searchParams.get('api-key'), null, 'key must NEVER ride in the URL');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-bulk-key');

  assert.deepEqual(fixes.map((f) => f.externalDeviceId), ['dev-1', 'dev-4']);
  assert.equal(fixes[0].speedMph, 24.85);
  assert.equal(fixes[1].eventAt, null);
});

test('listDevices includes fixless devices for the mapping UI', async () => {
  useDb();
  await setApiKey('t1', 'k');
  _setFetchForTests(async () => jsonResponse([RAW_DEVICE, { device_id: 'dev-nofix', display_name: 'Spare' }]));
  const devices = await listDevices('t1');
  assert.equal(devices.length, 2);
  assert.equal(devices[0].hasPosition, true);
  assert.equal(devices[1].hasPosition, false);
  assert.equal(devices[1].displayName, 'Spare');
});

test('a paginated wrapper (result_list) is tolerated', async () => {
  useDb();
  await setApiKey('t1', 'k');
  _setFetchForTests(async () => jsonResponse({ count: 1, result_list: [RAW_DEVICE] }));
  const fixes = await getDevicesWithPositions('t1');
  assert.equal(fixes.length, 1);
});

// ── failure modes: key hygiene + timeout ────────────────────────────────────

test('HTTP errors never leak the API key, even when the body echoes it', async () => {
  useDb();
  await setApiKey('t1', 'sk-leaky-key');
  _setFetchForTests(async () => jsonResponse(null, { ok: false, status: 401, text: 'invalid key sk-leaky-key rejected' }));
  await assert.rejects(
    () => getDevicesWithPositions('t1'),
    (err) => {
      assert.ok(!err.message.includes('sk-leaky-key'), `key leaked into error: ${err.message}`);
      assert.match(err.message, /401/);
      assert.match(err.message, /\[redacted\]/);
      return true;
    }
  );
});

test('calls are timeout-bounded (a hung fetch cannot wedge the poll)', async () => {
  useDb();
  await setApiKey('t1', 'sk-timeout-key');
  _setFetchForTests(() => new Promise(() => {})); // never settles
  await assert.rejects(
    () => getDevicesWithPositions('t1'),
    (err) => {
      assert.match(err.message, /timed out after 80ms/);
      assert.ok(!err.message.includes('sk-timeout-key'));
      return true;
    }
  );
});

test('missing key throws OneStepGpsAuthError before any network call', async () => {
  useDb();
  _setFetchForTests(async () => { throw new Error('must not be called'); });
  await assert.rejects(() => getDevicesWithPositions('t-nobody'), OneStepGpsAuthError);
});

// ── testConnection ──────────────────────────────────────────────────────────

test('testConnection reports ok + device count and records OK', async () => {
  const { store } = useDb();
  await setApiKey('t1', 'k');
  _setFetchForTests(async () => jsonResponse([{ device_id: 'a' }, { device_id: 'b' }]));
  const out = await testConnection('t1');
  assert.deepEqual(out, { ok: true, deviceCount: 2 });
  assert.equal(store.get('t1|ONESTEPGPS').lastTestStatus, 'OK');
});

test('testConnection failure is ok:false with a redacted message, records ERROR', async () => {
  const { store } = useDb();
  await setApiKey('t1', 'sk-probe-key');
  _setFetchForTests(async () => jsonResponse(null, { ok: false, status: 403, text: 'nope sk-probe-key' }));
  const out = await testConnection('t1');
  assert.equal(out.ok, false);
  assert.ok(!out.error.includes('sk-probe-key'));
  assert.equal(store.get('t1|ONESTEPGPS').lastTestStatus, 'ERROR');
});

// ── Phase 2: zones + alerts (ASSUMED contract — defensive by design) ────────
// These imports live down here so the top of the file stays byte-identical to
// its Phase 1 shape; node resolves them before any test runs regardless.
const {
  pickProviderZoneId,
  pushProviderZone,
  deleteProviderZone,
  listRawAlerts,
  OneStepGpsShapeError,
} = await import('./telematics-onestepgps.js');

test('pickProviderZoneId tolerates every plausible id spelling and nesting', () => {
  assert.equal(pickProviderZoneId({ zone_id: 'z-1' }), 'z-1');
  assert.equal(pickProviderZoneId({ id: 42 }), '42');
  assert.equal(pickProviderZoneId({ _id: 'abc' }), 'abc');
  assert.equal(pickProviderZoneId({ zone: { zone_id: 'nested' } }), 'nested');
  assert.equal(pickProviderZoneId({ result: { id: 'r-1' } }), 'r-1');
  assert.equal(pickProviderZoneId('bare-id'), 'bare-id');
  assert.equal(pickProviderZoneId({}), null);
  assert.equal(pickProviderZoneId(null), null);
  assert.equal(pickProviderZoneId({ unrelated: true }), null);
});

test('pushProviderZone create: POST with Bearer auth, no key in URL, id parsed from the answer', async () => {
  useDb();
  await setApiKey('t1', 'sk-zone-key');
  const calls = [];
  _setFetchForTests(async (url, opts) => {
    calls.push({ url, opts });
    return jsonResponse({ zone_id: 'prov-9' });
  });
  const out = await pushProviderZone('t1', {
    name: 'LAX Pickup Lot B',
    points: [{ lat: 18.1, lng: -66.1 }, { lat: 18.2, lng: -66.1 }, { lat: 18.2, lng: -66.2 }],
  });
  assert.deepEqual(out, { providerZoneId: 'prov-9' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-zone-key');
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('api-key'), null, 'key must NEVER ride in the URL');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.zone_name, 'LAX Pickup Lot B');
  assert.equal(body.points.length, 3);
  assert.ok(!calls[0].opts.body.includes('sk-zone-key'), 'key must never enter the request body');
});

test('pushProviderZone create: an answer with NO recognizable id is a ShapeError, never a fake success', async () => {
  useDb();
  await setApiKey('t1', 'k');
  _setFetchForTests(async () => jsonResponse({ status: 'ok, trust me' }));
  await assert.rejects(
    () => pushProviderZone('t1', { name: 'X', points: [{ lat: 1, lng: 2 }] }),
    OneStepGpsShapeError,
  );
});

test('pushProviderZone update: PUT to the existing id; an empty answer keeps that id', async () => {
  useDb();
  await setApiKey('t1', 'k');
  const calls = [];
  _setFetchForTests(async (url, opts) => { calls.push({ url, opts }); return jsonResponse(null); });
  const out = await pushProviderZone('t1', { providerZoneId: 'prov-7', name: 'Base', points: [{ lat: 1, lng: 2 }] });
  assert.equal(out.providerZoneId, 'prov-7');
  assert.equal(calls[0].opts.method, 'PUT');
  assert.match(new URL(calls[0].url).pathname, /\/zone\/prov-7$/);
});

test('deleteProviderZone: DELETE to the id; a null id is a no-op skip', async () => {
  useDb();
  await setApiKey('t1', 'k');
  const calls = [];
  _setFetchForTests(async (url, opts) => { calls.push({ url, opts }); return jsonResponse(null); });
  assert.deepEqual(await deleteProviderZone('t1', null), { ok: true, skipped: true });
  assert.equal(calls.length, 0, 'no network call without an id');
  assert.deepEqual(await deleteProviderZone('t1', 'prov-3'), { ok: true });
  assert.equal(calls[0].opts.method, 'DELETE');
});

test('listRawAlerts unwraps bare arrays AND the known wrapper spellings; garbage is a ShapeError', async () => {
  useDb();
  await setApiKey('t1', 'k');
  const entry = { alert_id: 'a1', alert_type: 'zone_enter' };

  _setFetchForTests(async () => jsonResponse([entry]));
  assert.deepEqual(await listRawAlerts('t1', { sinceIso: '2026-08-24T00:00:00Z' }), [entry]);

  for (const key of ['result_list', 'alerts', 'data', 'result']) {
    _setFetchForTests(async () => jsonResponse({ [key]: [entry] }));
    assert.deepEqual(await listRawAlerts('t1', {}), [entry], `wrapper ${key}`);
  }

  _setFetchForTests(async () => jsonResponse({ nothing: 'recognizable' }));
  await assert.rejects(() => listRawAlerts('t1', {}), OneStepGpsShapeError);
});

test('listRawAlerts sends the since window and errors stay key-redacted', async () => {
  useDb();
  await setApiKey('t1', 'sk-alert-key');
  const calls = [];
  _setFetchForTests(async (url) => { calls.push(url); return jsonResponse([]); });
  await listRawAlerts('t1', { sinceIso: '2026-08-24T12:00:00.000Z' });
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('dt_server_from'), '2026-08-24T12:00:00.000Z');
  assert.equal(url.searchParams.get('api-key'), null);

  _setFetchForTests(async () => jsonResponse(null, { ok: false, status: 500, text: 'boom sk-alert-key' }));
  await assert.rejects(
    () => listRawAlerts('t1', {}),
    (err) => {
      assert.ok(!err.message.includes('sk-alert-key'), `key leaked: ${err.message}`);
      return true;
    },
  );
});
