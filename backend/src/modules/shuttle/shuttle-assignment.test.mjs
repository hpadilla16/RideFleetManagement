/**
 * Manual shuttle assignment — DB-free with an in-memory prisma (Phase 3,
 * 2026-08-25; approved mockup Screen 8a).
 *
 * FAIL-CLOSED is the whole feature: an assignment decides which vehicle's
 * GPS a customer page follows, so every edge — foreign tenant, foreign
 * location scope, a vehicle outside the location's tracker config, a closed
 * request — refuses. Plus the mode-aware public payload the assignment
 * drives (Screens 8a/8b), pinned against the pure builders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shuttleRequestsService } from './shuttle-requests.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.service.js';
import {
  publicPositionPayload, publicShuttleEntry, SHUTTLE_ENTRY_MARK,
} from './shuttle-tracker-position.js';

const NOW = new Date('2026-08-25T15:00:00Z').getTime();
const secondsAgo = (s) => new Date(NOW - s * 1000).toISOString();

// ─── in-memory prisma ───────────────────────────────────────────────────────

const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
  return row[k] === v;
});

function table(rows) {
  return {
    rows,
    async findFirst({ where } = {}) { return rows.find((r) => matches(r, where)) || null; },
    async findMany({ where } = {}) { return rows.filter((r) => matches(r, where)); },
    async update({ where, data }) {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return { ...row };
    },
  };
}

function makeWorld() {
  const requests = table([
    { id: 'req_open', tenantId: 't1', locationId: 'lax', status: 'READY', assignedVehicleId: null },
    { id: 'req_closed', tenantId: 't1', locationId: 'lax', status: 'COMPLETED', assignedVehicleId: null },
    { id: 'req_foreign', tenantId: 't2', locationId: 'mia', status: 'READY', assignedVehicleId: null },
  ]);
  const deps = {
    prisma: {
      shuttleRequest: requests,
      vehicle: table([
        { id: 'v1', tenantId: 't1' },
        { id: 'v_unconfigured', tenantId: 't1' },
        { id: 'v_foreign', tenantId: 't2' },
      ]),
      shuttleTrackerConfig: table([
        { id: 'c1', tenantId: 't1', locationId: 'lax', mode: 'ON_DEMAND', vehicleIdsJson: ['v1', 'v_foreign'] },
      ]),
    },
    logger: { info() {}, warn() {}, error() {} },
    clearCustomerLocation: async () => {},
  };
  return { deps, requests };
}

// ─── assign / unassign ──────────────────────────────────────────────────────

test('assign: a configured, tenant-owned vehicle pins onto an open request', async () => {
  const w = makeWorld();
  const row = await shuttleRequestsService.assign('req_open', 'v1', { tenantId: 't1' }, 'u1', w.deps);
  assert.equal(row.assignedVehicleId, 'v1');
});

test('FAIL-CLOSED: vehicle outside the location config, foreign vehicle, missing vehicle — all 400', async () => {
  for (const vehicleId of ['v_unconfigured', 'v_foreign', 'v_ghost']) {
    const w = makeWorld();
    await assert.rejects(
      () => shuttleRequestsService.assign('req_open', vehicleId, { tenantId: 't1' }, 'u1', w.deps),
      (e) => e.status === 400,
      `vehicleId=${vehicleId}`,
    );
    assert.equal(w.requests.rows[0].assignedVehicleId, null, `${vehicleId} must not write`);
  }
  // v_foreign is IN the config's json (stale) but not tenant-owned — the
  // ownership re-check is the one that refused it. That is the QA 2026-08-15
  // transfer rule applied to assignment.
});

test('FAIL-CLOSED: foreign-tenant and out-of-scope-location requests look nonexistent (404)', async () => {
  const w = makeWorld();
  await assert.rejects(
    () => shuttleRequestsService.assign('req_foreign', 'v1', { tenantId: 't1' }, 'u1', w.deps),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => shuttleRequestsService.assign('req_open', 'v1', { tenantId: 't1', allowedLocationIds: ['sju'] }, 'u1', w.deps),
    (e) => e.status === 404,
    'a LAX request is invisible to SJU-scoped staff',
  );
});

test('a closed request takes no assignment (409); missing vehicleId is a 400', async () => {
  const w = makeWorld();
  await assert.rejects(
    () => shuttleRequestsService.assign('req_closed', 'v1', { tenantId: 't1' }, 'u1', w.deps),
    (e) => e.status === 409,
  );
  await assert.rejects(
    () => shuttleRequestsService.assign('req_open', '', { tenantId: 't1' }, 'u1', w.deps),
    (e) => e.status === 400,
  );
});

test('unassign clears; idempotent on a bare row; same scoping', async () => {
  const w = makeWorld();
  await shuttleRequestsService.assign('req_open', 'v1', { tenantId: 't1' }, 'u1', w.deps);
  const cleared = await shuttleRequestsService.unassign('req_open', { tenantId: 't1' }, 'u1', w.deps);
  assert.equal(cleared.assignedVehicleId, null);
  const again = await shuttleRequestsService.unassign('req_open', { tenantId: 't1' }, 'u1', w.deps);
  assert.equal(again.assignedVehicleId, null);
  await assert.rejects(
    () => shuttleRequestsService.unassign('req_open', { tenantId: 't2' }, 'u1', w.deps),
    (e) => e.status === 404,
  );
});

// ─── audit wiring ───────────────────────────────────────────────────────────

test('both directions are audited: actions exist and the routes call auditFromReq with them', () => {
  assert.equal(AUDIT_ACTIONS.SHUTTLE_ASSIGN, 'SHUTTLE_ASSIGN');
  assert.equal(AUDIT_ACTIONS.SHUTTLE_UNASSIGN, 'SHUTTLE_UNASSIGN');
  const src = readFileSync(new URL('./shuttle-requests.routes.js', import.meta.url), 'utf8');
  assert.match(src, /post\('\/:id\/assign'/);
  assert.match(src, /delete\('\/:id\/assign'/);
  assert.match(src, /AUDIT_ACTIONS\.SHUTTLE_ASSIGN/);
  assert.match(src, /AUDIT_ACTIONS\.SHUTTLE_UNASSIGN/);
});

// ─── the mode-aware public payload the assignment drives ────────────────────

test('assigned flag: literal true only, present in every payload', () => {
  const base = { position: null, config: { mode: 'ON_DEMAND' }, location: { name: 'LAX' }, now: NOW };
  assert.equal(publicPositionPayload(base).assigned, false);
  assert.equal(publicPositionPayload({ ...base, assigned: true }).assigned, true);
  assert.equal(publicPositionPayload({ ...base, assigned: 'yes' }).assigned, false);
});

test('THE WHITELIST, Phase 3 edition: assigned + locationSharing joined the contract; shuttles is NON_STOP-only', () => {
  const base = {
    position: { latitude: 18.4, longitude: -66.0, eventAt: secondsAgo(5) },
    location: { name: 'LAX' }, now: NOW,
  };
  const onDemand = publicPositionPayload({ ...base, config: { mode: 'ON_DEMAND' } });
  assert.deepEqual(Object.keys(onDemand).sort(), [
    'arrivedAtSpot', 'arrivedSpotName', 'assigned', 'brandName', 'counterPhone',
    'headwayMinutes', 'locationName', 'locationSharing', 'mode',
    'pickupInstructions', 'position', 'requestStatus', 'status', 'walkingDirections',
  ]);

  // Even a caller passing a shuttles array cannot make ON_DEMAND show the fleet.
  const smuggled = publicPositionPayload({
    ...base, config: { mode: 'ON_DEMAND' },
    shuttles: [publicShuttleEntry({ vehicle: { make: 'Ford' }, position: null, now: NOW })],
  });
  assert.equal('shuttles' in smuggled, false, 'the loop array is a NON_STOP shape only');
});

test('NON_STOP: the loop array crosses — but ONLY entries publicShuttleEntry built', () => {
  const entry = publicShuttleEntry({
    vehicle: { id: 'v1', make: 'Ford', model: 'Transit', color: 'White', plate: 'IKT-482', vin: 'SECRETVIN', tenantId: 't1' },
    position: { latitude: 18.4, longitude: -66.0, heading: 90, speedMph: 18, eventAt: secondsAgo(25) },
    now: NOW,
  });
  const raw = { name: 'Fake', vehicleId: 'v9', latitude: 1, longitude: 2 }; // hand-rolled — no mark
  const out = publicPositionPayload({
    position: null, config: { mode: 'NON_STOP', headwayMinutes: 10 }, location: { name: 'LAX' },
    shuttles: [entry, raw], now: NOW,
  });
  assert.equal(out.shuttles.length, 1, 'the unmarked object was refused');
  assert.deepEqual(Object.keys(out.shuttles[0]).sort(), ['color', 'name', 'plate', 'position', 'status']);
  assert.equal(out.shuttles[0].status, 'LIVE');
  assert.equal(out.shuttles[0].position.ageSeconds, 25);
  assert.equal(JSON.stringify(out).includes('SECRETVIN'), false);
  assert.equal(JSON.stringify(out).includes('v1'), false, 'no vehicle ids on the public loop');
});

test('publicShuttleEntry freshness: stale/absent fixes go OFFLINE with no coordinates — same trust rule as the single dot', () => {
  const vehicle = { make: 'Ford', model: 'Transit' };
  const stale = publicShuttleEntry({ vehicle, position: { latitude: 18.4, longitude: -66.0, eventAt: secondsAgo(5 * 60) }, now: NOW });
  assert.equal(stale.status, 'OFFLINE');
  assert.equal('position' in stale, false);
  const none = publicShuttleEntry({ vehicle, position: null, now: NOW });
  assert.equal(none.status, 'OFFLINE');
  const aging = publicShuttleEntry({ vehicle, position: { latitude: 18.4, longitude: -66.0, eventAt: secondsAgo(120) }, now: NOW });
  assert.equal(aging.status, 'AGING');
  // The construction mark is a Symbol — it can never serialize to a page.
  assert.equal(JSON.stringify(none).includes('publicShuttleEntry'), false);
  assert.equal(none[SHUTTLE_ENTRY_MARK], true);
});
