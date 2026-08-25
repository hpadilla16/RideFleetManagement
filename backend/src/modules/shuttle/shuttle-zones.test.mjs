import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Env BEFORE the imports: the service statically imports the provider client
// (prisma + integration-crypto want their env at module load).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.INTEGRATION_ENC_KEY = process.env.INTEGRATION_ENC_KEY || crypto.randomBytes(32).toString('base64');

const {
  validateZoneInput,
  parseAlertRecipients,
} = await import('./shuttle-zone-alerts.js');
const { shuttleZonesService, syncZoneToProvider } = await import('./shuttle-zones.service.js');
const { OneStepGpsAuthError, OneStepGpsShapeError } = await import('../vehicles/telematics-onestepgps.js');
const { shuttleZonesRouter } = await import('./shuttle-zones.routes.js');

// ── validateZoneInput (the gate every save goes through) ────────────────────

const TRIANGLE = [{ lat: 18.1, lng: -66.1 }, { lat: 18.2, lng: -66.1 }, { lat: 18.2, lng: -66.2 }];

test('validateZoneInput: a clean polygon zone normalizes with defaults', () => {
  const v = validateZoneInput({ name: '  LAX Pickup Lot B ', points: TRIANGLE, isPickupSpot: true, notifyOnEnter: true });
  assert.equal(v.ok, true);
  assert.equal(v.zone.name, 'LAX Pickup Lot B');
  assert.equal(v.zone.kind, 'ZONE');
  assert.equal(v.zone.isPickupSpot, true);
  assert.equal(v.zone.notifyOnEnter, true);
  assert.equal(v.zone.notifyOnExit, false);
  assert.equal(v.zone.notifyOnOffRoute, false, 'off-route is a ROUTE-only toggle');
  assert.equal(v.zone.toleranceM, null);
  assert.deepEqual(v.zone.geometryJson.points, TRIANGLE);
});

test('validateZoneInput: geometry rules — a ZONE needs 3 points, a ROUTE needs 2, one NaN kills the save', () => {
  assert.equal(validateZoneInput({ name: 'x', points: TRIANGLE.slice(0, 2) }).ok, false);
  assert.equal(validateZoneInput({ name: 'x', kind: 'ROUTE', points: TRIANGLE.slice(0, 2) }).ok, true);
  assert.equal(validateZoneInput({ name: 'x', kind: 'ROUTE', points: [TRIANGLE[0]] }).ok, false);
  assert.equal(validateZoneInput({ name: 'x', points: [...TRIANGLE, { lat: 'nope', lng: 1 }] }).ok, false);
  assert.equal(validateZoneInput({ name: 'x', points: [...TRIANGLE, { lat: 91, lng: 1 }] }).ok, false);
  assert.equal(validateZoneInput({ name: 'x', points: [...TRIANGLE, { lat: 1, lng: 181 }] }).ok, false);
  assert.equal(validateZoneInput({ name: '', points: TRIANGLE }).ok, false);
  assert.equal(validateZoneInput({ name: 'x', kind: 'BLOB', points: TRIANGLE }).ok, false);
});

test('validateZoneInput: ROUTE tolerance defaults to 300m and is bounded 50–5000', () => {
  const line = TRIANGLE.slice(0, 2);
  assert.equal(validateZoneInput({ name: 'r', kind: 'ROUTE', points: line }).zone.toleranceM, 300);
  assert.equal(validateZoneInput({ name: 'r', kind: 'ROUTE', points: line, toleranceM: 500 }).zone.toleranceM, 500);
  assert.equal(validateZoneInput({ name: 'r', kind: 'ROUTE', points: line, toleranceM: 10 }).ok, false);
  assert.equal(validateZoneInput({ name: 'r', kind: 'ROUTE', points: line, toleranceM: 50000 }).ok, false);
  // ROUTE ignores ZONE-only toggles + pickup flag; keeps its own.
  const r = validateZoneInput({ name: 'r', kind: 'ROUTE', points: line, isPickupSpot: true, notifyOnEnter: true, notifyOnOffRoute: true });
  assert.equal(r.zone.isPickupSpot, false);
  assert.equal(r.zone.notifyOnEnter, false);
  assert.equal(r.zone.notifyOnOffRoute, true);
});

// ── parseAlertRecipients (staff fan-out list — one validator, both sides) ───

test('parseAlertRecipients: keeps reachable entries, drops garbage, dedups channels', () => {
  const out = parseAlertRecipients([
    { name: 'Hector P.', email: 'HP@ride.co', channels: ['EMAIL', 'SMS', 'email'] },       // SMS without phone drops
    { name: 'M. Colón', phone: '+1 787 555 0100', channels: ['SMS'] },
    { name: 'no channels', email: 'x@y.co' },                                              // no channels → dropped
    { name: 'bad email', email: 'not-an-email', channels: ['EMAIL'] },                     // invalid → dropped
    'garbage', null, 42,
  ]);
  assert.deepEqual(out, [
    { name: 'Hector P.', email: 'hp@ride.co', phone: null, channels: ['EMAIL'] },
    { name: 'M. Colón', email: null, phone: '+1 787 555 0100', channels: ['SMS'] },
  ]);
  assert.deepEqual(parseAlertRecipients(null), []);
  assert.deepEqual(parseAlertRecipients('not-a-list'), []);
});

// ── service: tenant scoping fail-closed + provider sync outcomes ────────────

function fakeWorld({ locations = {}, zones = [], syncBehavior = 'ok' } = {}) {
  const warns = [];
  let idSeq = 0;
  const zoneRows = [...zones];
  const configRows = new Map(); // locationId → config row
  const providerCalls = [];
  const deps = {
    logger: { info: () => {}, warn: (msg, meta) => warns.push({ msg, meta }) },
    prisma: {
      location: {
        findFirst: async ({ where }) => {
          const loc = locations[where.id];
          return loc && loc.tenantId === where.tenantId ? { id: where.id } : null;
        },
      },
      shuttleZone: {
        findMany: async ({ where }) => zoneRows.filter((z) => z.tenantId === where.tenantId
          && (!where.locationId || z.locationId === where.locationId)),
        findFirst: async ({ where }) => zoneRows.find((z) => z.id === where.id && z.tenantId === where.tenantId) || null,
        create: async ({ data }) => {
          const row = { id: `zone_${++idSeq}`, providerZoneId: null, providerSyncError: null, createdAt: new Date(), updatedAt: new Date(), ...data };
          zoneRows.push(row);
          return row;
        },
        update: async ({ where, data }) => {
          const row = zoneRows.find((z) => z.id === where.id);
          if (!row) throw new Error('not found');
          Object.assign(row, data, { updatedAt: new Date() });
          return row;
        },
        delete: async ({ where }) => {
          const i = zoneRows.findIndex((z) => z.id === where.id);
          if (i < 0) throw new Error('not found');
          return zoneRows.splice(i, 1)[0];
        },
      },
      shuttleTrackerConfig: {
        findFirst: async ({ where }) => {
          const row = configRows.get(where.locationId);
          return row && row.tenantId === where.tenantId ? row : null;
        },
        upsert: async ({ where, update, create }) => {
          const existing = configRows.get(where.locationId);
          const row = existing ? { ...existing, ...update } : { id: `cfg_${++idSeq}`, ...create };
          configRows.set(where.locationId, row);
          return row;
        },
      },
    },
    provider: {
      pushProviderZone: async (tenantId, args) => {
        providerCalls.push({ op: 'push', tenantId, args });
        if (syncBehavior === 'no-key') throw new OneStepGpsAuthError('No OneStepGPS API key stored');
        if (syncBehavior === 'shape') throw new OneStepGpsShapeError('zone create answered without a recognizable zone id');
        return { providerZoneId: args.providerZoneId || 'prov-new' };
      },
      deleteProviderZone: async (tenantId, id) => { providerCalls.push({ op: 'delete', tenantId, id }); return { ok: true }; },
    },
  };
  return { deps, warns, zoneRows, providerCalls, configRows };
}

const LOCS = { locA: { tenantId: 't1' }, locB: { tenantId: 't2' } };

test('create: location of ANOTHER tenant looks nonexistent (404), fail-closed', async () => {
  const w = fakeWorld({ locations: LOCS });
  await assert.rejects(
    () => shuttleZonesService.create({ tenantId: 't1', locationId: 'locB', body: { name: 'x', points: TRIANGLE } }, w.deps),
    (err) => err.status === 404,
  );
  assert.equal(w.zoneRows.length, 0);
  assert.equal(w.providerCalls.length, 0, 'no provider call for a refused save');
});

test('create: a valid ZONE syncs to the provider and comes back SYNCED', async () => {
  const w = fakeWorld({ locations: LOCS });
  const zone = await shuttleZonesService.create({
    tenantId: 't1', locationId: 'locA',
    body: { name: 'Lot B', points: TRIANGLE, isPickupSpot: true, notifyOnEnter: true },
  }, w.deps);
  assert.equal(zone.providerSyncStatus, 'SYNCED');
  assert.equal(w.zoneRows[0].providerZoneId, 'prov-new');
  assert.equal(w.providerCalls[0].op, 'push');
  assert.equal(w.providerCalls[0].tenantId, 't1');
});

test('create with NO stored API key stays PENDING (not ERROR) — the save still succeeds', async () => {
  const w = fakeWorld({ locations: LOCS, syncBehavior: 'no-key' });
  const zone = await shuttleZonesService.create({
    tenantId: 't1', locationId: 'locA', body: { name: 'Early zone', points: TRIANGLE },
  }, w.deps);
  assert.equal(zone.providerSyncStatus, 'PENDING');
  assert.ok(w.warns.some((x) => x.msg.includes('provider sync failed')));
});

test('create against a shape-drifted provider goes ERROR with the message, never a fake SYNCED', async () => {
  const w = fakeWorld({ locations: LOCS, syncBehavior: 'shape' });
  const zone = await shuttleZonesService.create({
    tenantId: 't1', locationId: 'locA', body: { name: 'Drift', points: TRIANGLE },
  }, w.deps);
  assert.equal(zone.providerSyncStatus, 'ERROR');
  assert.match(zone.providerSyncError, /recognizable zone id/);
  assert.equal(w.zoneRows[0].providerZoneId, null);
});

test('a ROUTE is STORE-ONLY: saved as UNSUPPORTED, no provider call, TODO warn logged — detection is never faked', async () => {
  const w = fakeWorld({ locations: LOCS });
  const zone = await shuttleZonesService.create({
    tenantId: 't1', locationId: 'locA',
    body: { name: 'Base ⇄ LAX', kind: 'ROUTE', points: TRIANGLE.slice(0, 2), notifyOnOffRoute: true },
  }, w.deps);
  assert.equal(zone.providerSyncStatus, 'UNSUPPORTED');
  assert.equal(zone.toleranceM, 300);
  assert.equal(w.providerCalls.length, 0, 'no provider zone API call for a ROUTE');
  assert.ok(w.warns.some((x) => x.msg.includes('ROUTE detection unsupported')));
});

test('list and update are tenant-scoped fail-closed; cross-tenant update is a 404', async () => {
  const w = fakeWorld({
    locations: LOCS,
    zones: [{
      id: 'z1', tenantId: 't1', locationId: 'locA', name: 'Mine', kind: 'ZONE',
      isPickupSpot: false, walkingDirections: null, geometryJson: { type: 'polygon', points: TRIANGLE },
      toleranceM: null, providerZoneId: 'p1', providerSyncStatus: 'SYNCED', providerSyncError: null,
      notifyOnEnter: false, notifyOnExit: false, notifyOnOffRoute: false, active: true, updatedAt: new Date(),
    }],
  });
  assert.deepEqual(await shuttleZonesService.list({ tenantId: null }, w.deps), [], 'no tenant → empty, never all');
  assert.equal((await shuttleZonesService.list({ tenantId: 't1' }, w.deps)).length, 1);
  assert.equal((await shuttleZonesService.list({ tenantId: 't2' }, w.deps)).length, 0);

  await assert.rejects(
    () => shuttleZonesService.update({ tenantId: 't2', zoneId: 'z1', body: { name: 'stolen' } }, w.deps),
    (err) => err.status === 404,
  );
  // A toggle-only update does NOT resync geometry.
  const updated = await shuttleZonesService.update({ tenantId: 't1', zoneId: 'z1', body: { notifyOnEnter: true } }, w.deps);
  assert.equal(updated.notifyOnEnter, true);
  assert.equal(w.providerCalls.length, 0, 'toggle flip must not re-push geometry');
  // A geometry change DOES.
  await shuttleZonesService.update({ tenantId: 't1', zoneId: 'z1', body: { geometry: { points: [...TRIANGLE, { lat: 18.3, lng: -66.3 }] } } }, w.deps);
  assert.equal(w.providerCalls.length, 1);
});

test('remove: cross-tenant is 404; own zone deletes ours even when the provider delete fails', async () => {
  const w = fakeWorld({
    locations: LOCS,
    zones: [{ id: 'z1', tenantId: 't1', locationId: 'locA', name: 'Doomed', kind: 'ZONE', geometryJson: { points: TRIANGLE }, providerZoneId: 'p1', providerSyncStatus: 'SYNCED' }],
  });
  w.deps.provider.deleteProviderZone = async () => { throw new Error('provider down'); };
  await assert.rejects(() => shuttleZonesService.remove({ tenantId: 't2', zoneId: 'z1' }, w.deps), (e) => e.status === 404);
  const out = await shuttleZonesService.remove({ tenantId: 't1', zoneId: 'z1' }, w.deps);
  assert.deepEqual(out, { ok: true });
  assert.equal(w.zoneRows.length, 0);
  assert.ok(w.warns.some((x) => x.msg.includes('provider zone delete failed')));
});

test('recipients: location-scoped, validated through the SAME parser, round-trips', async () => {
  const w = fakeWorld({ locations: LOCS });
  await assert.rejects(
    () => shuttleZonesService.setRecipients({ tenantId: 't1', locationId: 'locB', recipients: [] }, w.deps),
    (err) => err.status === 404,
  );
  const set = await shuttleZonesService.setRecipients({
    tenantId: 't1', locationId: 'locA',
    recipients: [{ name: 'HP', email: 'hp@ride.co', channels: ['EMAIL'] }, { name: 'junk' }],
  }, w.deps);
  assert.equal(set.recipients.length, 1, 'unreachable entries dropped at write time');
  const got = await shuttleZonesService.getRecipients({ tenantId: 't1', locationId: 'locA' }, w.deps);
  assert.deepEqual(got.recipients, set.recipients);
  // The upsert kept mode OFF — recipients never turn a tracker on.
  assert.equal(w.configRows.get('locA').mode, 'OFF');
});

// ── syncZoneToProvider retry surface (used by the alert scheduler) ──────────

test('syncZoneToProvider: a PENDING zone flips to SYNCED once the provider accepts', async () => {
  const w = fakeWorld({
    locations: LOCS,
    zones: [{ id: 'z1', tenantId: 't1', locationId: 'locA', name: 'Late', kind: 'ZONE', geometryJson: { type: 'polygon', points: TRIANGLE }, providerZoneId: null, providerSyncStatus: 'PENDING' }],
  });
  const out = await syncZoneToProvider(w.zoneRows[0], w.deps);
  assert.equal(out.providerSyncStatus, 'SYNCED');
  assert.equal(out.providerZoneId, 'prov-new');
});

// ── router surface (mirrors onestepgps.routes.test.mjs) ─────────────────────

test('shuttleZonesRouter mounts the full endpoint inventory with the admin guard FIRST', () => {
  const paths = shuttleZonesRouter.stack.filter((l) => l.route).map((l) => l.route.path);
  for (const p of ['/', '/recipients', '/:id']) {
    assert.ok(paths.includes(p), `missing route ${p}`);
  }
  const firstRouteIdx = shuttleZonesRouter.stack.findIndex((l) => l.route);
  const guardLayers = shuttleZonesRouter.stack.slice(0, firstRouteIdx).filter((l) => !l.route);
  assert.ok(guardLayers.length >= 1, 'expected auth/role guard middleware before routes');
});

test('literal /recipients routes are registered BEFORE the /:id params (Express matches in order)', () => {
  const routePaths = shuttleZonesRouter.stack.filter((l) => l.route).map((l) => l.route.path);
  const recipientsIdx = routePaths.indexOf('/recipients');
  const paramIdx = routePaths.indexOf('/:id');
  assert.ok(recipientsIdx >= 0 && paramIdx >= 0);
  assert.ok(recipientsIdx < paramIdx, 'PUT /recipients would be swallowed by PUT /:id');
});
