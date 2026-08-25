/**
 * Staff Shuttle Monitor — DB-free suite (2026-08-24).
 *
 * Two halves, mirroring the module split:
 *   • shuttle-monitor.js pure rules (freshness thresholds shared with the
 *     public page, card whitelist, queue summary);
 *   • shuttle-monitor.service.js with an injected in-memory prisma — the
 *     part that pins TENANT SCOPING: fail-closed with no tenant, cross-tenant
 *     rows invisible, allowedLocationIds intersects and never widens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  positionFreshness, vehicleLabel, monitorShuttlePayload, summarizeOpenRequests,
} from './shuttle-monitor.js';
import { POSITION_AGING_MS, POSITION_STALE_MS } from './shuttle-tracker-position.js';
import { shuttleMonitorService } from './shuttle-monitor.service.js';

const NOW = new Date('2026-08-24T15:00:00Z').getTime();
const secondsAgo = (s) => new Date(NOW - s * 1000).toISOString();

// ─── pure rules ──────────────────────────────────────────────────────────────

test('freshness reuses the public thresholds exactly — the two maps may never disagree', () => {
  const fix = (s) => ({ latitude: 18.4, longitude: -66.0, eventAt: secondsAgo(s) });
  assert.equal(positionFreshness(fix(30), NOW).status, 'LIVE');
  assert.equal(positionFreshness(fix(POSITION_AGING_MS / 1000 + 5), NOW).status, 'AGING');
  assert.equal(positionFreshness(fix(POSITION_STALE_MS / 1000 + 5), NOW).status, 'OFFLINE');
  assert.equal(positionFreshness(null, NOW).status, 'OFFLINE');
  assert.equal(positionFreshness({ latitude: 'x', longitude: -66, eventAt: secondsAgo(5) }, NOW).status, 'OFFLINE');
  assert.equal(positionFreshness(fix(30), NOW).ageSeconds, 30);
});

test('vehicleLabel: year make model, then internalNumber, then a generic', () => {
  assert.equal(vehicleLabel({ year: 2023, make: 'Ford', model: 'Transit 350' }), '2023 Ford Transit 350');
  assert.equal(vehicleLabel({ internalNumber: 'U-17' }), 'U-17');
  assert.equal(vehicleLabel({}), 'Shuttle');
});

test('monitor card is PICKED, never spread — and NO_DEVICE outranks any fix', () => {
  const leakyVehicle = {
    id: 'v1', year: 2023, make: 'Ford', model: 'Transit 350', color: 'White', plate: 'IKT-482',
    internalNumber: 'U-17', vin: '1FTBW3XM0PKA00001', tenantId: 't1', acquisitionCost: '41000',
  };
  const out = monitorShuttlePayload({
    vehicle: leakyVehicle,
    hasDevice: true,
    position: { latitude: 18.4, longitude: -66.0, heading: 90, speedMph: 18, eventAt: secondsAgo(32), vehicleId: 'v1' },
    config: { mode: 'ON_DEMAND', headwayMinutes: 10, locationId: 'loc1' },
    location: { id: 'loc1', name: 'LAX Airport' },
    now: NOW,
  });
  assert.deepEqual(Object.keys(out).sort(), [
    'ageSeconds', 'asOf', 'color', 'headwayMinutes', 'label', 'locationId',
    'locationName', 'mode', 'plate', 'position', 'status', 'vehicleId',
  ]);
  assert.equal(out.status, 'LIVE');
  assert.equal(out.label, '2023 Ford Transit 350');
  assert.deepEqual(Object.keys(out.position).sort(), ['heading', 'latitude', 'longitude', 'speedMph']);
  assert.equal(JSON.stringify(out).includes('1FTBW3XM'), false, 'VIN never crosses even to staff cards');

  const noDevice = monitorShuttlePayload({
    vehicle: leakyVehicle, hasDevice: false,
    position: { latitude: 18.4, longitude: -66.0, eventAt: secondsAgo(5) },
    config: { mode: 'NON_STOP', headwayMinutes: 10 }, location: null, now: NOW,
  });
  assert.equal(noDevice.status, 'NO_DEVICE');
  assert.equal('position' in noDevice, false, 'an unmapped unit never draws a marker');
});

test('OFFLINE cards carry no coordinates — a stale dot presented on the staff map lies too', () => {
  const out = monitorShuttlePayload({
    vehicle: { id: 'v1', make: 'Ford' }, hasDevice: true,
    position: { latitude: 18.4, longitude: -66.0, eventAt: secondsAgo(POSITION_STALE_MS / 1000 + 60) },
    config: { mode: 'ON_DEMAND' }, location: { id: 'l', name: 'SJU' }, now: NOW,
  });
  assert.equal(out.status, 'OFFLINE');
  assert.equal('position' in out, false);
});

test('open-queue summary: per location, oldest leads, next capped at 3', () => {
  const rows = [
    { locationId: 'lax', customerName: 'Juan P.', partySize: 3, pickupNote: 'Lot B', createdAt: secondsAgo(12 * 60) },
    { locationId: 'lax', customerName: 'M. Rivera', partySize: 1, createdAt: secondsAgo(9 * 60) },
    { locationId: 'lax', customerName: 'K. Osei', partySize: 2, createdAt: secondsAgo(5 * 60) },
    { locationId: 'lax', customerName: 'Fourth', partySize: 1, createdAt: secondsAgo(4 * 60) },
    { locationId: 'lax', customerName: 'Fifth', partySize: 1, createdAt: secondsAgo(3 * 60) },
    { locationId: 'sju', customerName: 'Ana', partySize: 4, createdAt: secondsAgo(60) },
  ];
  const out = summarizeOpenRequests(rows, NOW);
  assert.equal(out.lax.openCount, 5);
  assert.equal(out.lax.oldest.customerName, 'Juan P.');
  assert.equal(out.lax.oldest.waitingMinutes, 12);
  assert.equal(out.lax.oldest.pickupNote, 'Lot B');
  assert.equal(out.lax.next.length, 3);
  // Phase 3: every entry names its assignment (null when nobody pinned one).
  assert.deepEqual(out.lax.next[0], { customerName: 'M. Rivera', partySize: 1, assignedVehicle: null });
  assert.equal(out.sju.openCount, 1);
  assert.equal('missing' in out, false);
});

test('Phase 3: assignments resolve ONLY through the caller\'s tenant-verified vehicle map', () => {
  const rows = [
    { locationId: 'lax', customerName: 'Juan P.', partySize: 2, bags: 3, assignedVehicleId: 'v1', createdAt: secondsAgo(600) },
    { locationId: 'lax', customerName: 'K. Osei', partySize: 1, assignedVehicleId: 'v_stale', createdAt: secondsAgo(300) },
  ];
  const vehicleById = { v1: { id: 'v1', year: 2023, make: 'Ford', model: 'Transit 350', plate: 'IKT-482' } };
  const out = summarizeOpenRequests(rows, NOW, vehicleById);
  assert.deepEqual(out.lax.oldest.assignedVehicle, { vehicleId: 'v1', label: '2023 Ford Transit 350', plate: 'IKT-482' });
  assert.equal(out.lax.oldest.bags, 3);
  // A stale/foreign id the map does not know renders as null — never a lookup.
  assert.equal(out.lax.next[0].assignedVehicle, null);
});

// ─── service scoping, with an in-memory prisma ──────────────────────────────

/** Tiny where-matcher for the exact query shapes the service builds. */
const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
  if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
  return row[k] === v;
});

function fakePrisma(data) {
  const table = (rows) => ({
    findMany: async ({ where } = {}) => rows.filter((r) => matches(r, where)),
    count: async ({ where } = {}) => rows.filter((r) => matches(r, where)).length,
  });
  return {
    shuttleTrackerConfig: table(data.configs || []),
    location: table(data.locations || []),
    vehicle: table(data.vehicles || []),
    vehicleTelematicsDevice: table(data.devices || []),
    shuttleRequest: table(data.requests || []),
  };
}

const DATA = {
  configs: [
    { id: 'c1', tenantId: 't1', locationId: 'lax', mode: 'ON_DEMAND', headwayMinutes: 10, vehicleIdsJson: ['v1', 'v-foreign'] },
    { id: 'c2', tenantId: 't1', locationId: 'sju', mode: 'NON_STOP', headwayMinutes: 10, vehicleIdsJson: ['v2'] },
    { id: 'c3', tenantId: 't1', locationId: 'off', mode: 'OFF', headwayMinutes: 10, vehicleIdsJson: ['v3'] },
    { id: 'cx', tenantId: 't2', locationId: 'mia', mode: 'ON_DEMAND', headwayMinutes: 10, vehicleIdsJson: ['vx'] },
  ],
  locations: [
    { id: 'lax', tenantId: 't1', name: 'LAX Airport', latitude: 33.94, longitude: -118.4 },
    { id: 'sju', tenantId: 't1', name: 'SJU Airport', latitude: 18.43, longitude: -66.0 },
    { id: 'mia', tenantId: 't2', name: 'Miami', latitude: 25.8, longitude: -80.2 },
  ],
  vehicles: [
    { id: 'v1', tenantId: 't1', year: 2023, make: 'Ford', model: 'Transit 350', color: 'White', plate: 'IKT-482', internalNumber: 'U-1' },
    { id: 'v2', tenantId: 't1', year: 2022, make: 'Mercedes', model: 'Sprinter 2500', color: 'Silver', plate: 'JQD-119', internalNumber: 'U-2' },
    // v-foreign belongs to ANOTHER tenant although t1's config still lists it.
    { id: 'v-foreign', tenantId: 't2', make: 'Toyota', model: 'Hiace', plate: 'XXX-000' },
    { id: 'vx', tenantId: 't2', make: 'Ford', model: 'Transit', plate: 'YYY-111' },
  ],
  devices: [
    { vehicleId: 'v1', isActive: true },
    // v2 has NO device row → NO_DEVICE card.
  ],
  requests: [
    { id: 'r1', tenantId: 't1', locationId: 'lax', status: 'READY', customerName: 'Juan P.', partySize: 3, pickupNote: 'Lot B', createdAt: secondsAgo(12 * 60) },
    { id: 'r2', tenantId: 't2', locationId: 'mia', status: 'READY', customerName: 'Foreign', partySize: 1, createdAt: secondsAgo(60) },
  ],
};

const positionsFor = (fixes) => async (ids) => {
  const out = {};
  for (const id of ids) if (fixes[id]) out[id] = fixes[id];
  return out;
};

const T1_FIXES = { v1: { vehicleId: 'v1', latitude: 33.94, longitude: -118.4, heading: 90, speedMph: 18, eventAt: secondsAgo(32) } };

test('FAIL-CLOSED: a scope without a tenant gets the empty shape, never all tenants', async () => {
  const deps = { prisma: fakePrisma(DATA), latestPositionsByVehicle: positionsFor(T1_FIXES) };
  const out = await shuttleMonitorService.positions({}, deps, NOW);
  assert.deepEqual(out.shuttles, []);
  assert.equal(out.enabled, false);
  const en = await shuttleMonitorService.enabled({}, deps);
  assert.equal(en.enabled, false);
});

test('tenant scoping: t1 sees its shuttles; the cross-tenant vehicle its config still lists is DROPPED', async () => {
  const deps = { prisma: fakePrisma(DATA), latestPositionsByVehicle: positionsFor(T1_FIXES) };
  const out = await shuttleMonitorService.positions({ tenantId: 't1', allowedLocationIds: null }, deps, NOW);
  assert.equal(out.enabled, true);
  const ids = out.shuttles.map((s) => s.vehicleId).sort();
  assert.deepEqual(ids, ['v1', 'v2'], 'v-foreign (t2) and vx (t2 config) must not appear; OFF config excluded');
  const v1 = out.shuttles.find((s) => s.vehicleId === 'v1');
  assert.equal(v1.status, 'LIVE');
  assert.equal(v1.plate, 'IKT-482');
  const v2 = out.shuttles.find((s) => s.vehicleId === 'v2');
  assert.equal(v2.status, 'NO_DEVICE');
  // Cross-tenant requests never surface either.
  assert.equal('mia' in out.requestsByLocation, false);
  assert.equal(out.requestsByLocation.lax.oldest.customerName, 'Juan P.');
});

test('location scoping INTERSECTS: an SJU-scoped user sees only the SJU shuttle and queue', async () => {
  const deps = { prisma: fakePrisma(DATA), latestPositionsByVehicle: positionsFor(T1_FIXES) };
  const out = await shuttleMonitorService.positions({ tenantId: 't1', allowedLocationIds: ['sju'] }, deps, NOW);
  assert.deepEqual(out.shuttles.map((s) => s.vehicleId), ['v2']);
  assert.deepEqual(Object.keys(out.requestsByLocation), []);
  // And a scope naming a FOREIGN location yields nothing, not that location.
  const foreign = await shuttleMonitorService.positions({ tenantId: 't1', allowedLocationIds: ['mia'] }, deps, NOW);
  assert.deepEqual(foreign.shuttles, []);
  assert.equal(foreign.enabled, false);
});

test('enabled(): true only when the caller scope holds a mode≠OFF config', async () => {
  const deps = { prisma: fakePrisma(DATA) };
  assert.equal((await shuttleMonitorService.enabled({ tenantId: 't1' }, deps)).enabled, true);
  assert.equal((await shuttleMonitorService.enabled({ tenantId: 't1', allowedLocationIds: ['off'] }, deps)).enabled, false);
  assert.equal((await shuttleMonitorService.enabled({ tenantId: 't-none' }, deps)).enabled, false);
});

// ─── Phase 3: waiting customers with the ephemeral shared fix ───────────────

test('waitingCustomers: staff-only coordinates come from the injected Redis read, scoped like the queue', async () => {
  const data = {
    ...DATA,
    requests: [
      { id: 'r1', tenantId: 't1', locationId: 'lax', status: 'READY', customerName: 'Juan P.', partySize: 2, bags: 3, assignedVehicleId: 'v1', pickupSpotZoneId: 'zone_b', createdAt: secondsAgo(12 * 60) },
      { id: 'r3', tenantId: 't1', locationId: 'lax', status: 'READY', customerName: 'M. Rivera', partySize: 1, createdAt: secondsAgo(2 * 60) },
      { id: 'r2', tenantId: 't2', locationId: 'mia', status: 'READY', customerName: 'Foreign', partySize: 1, createdAt: secondsAgo(60) },
    ],
  };
  const fixes = { r1: { lat: 33.941, lng: -118.401, at: NOW - 45_000 } };
  const deps = {
    prisma: fakePrisma(data),
    latestPositionsByVehicle: positionsFor(T1_FIXES),
    readCustomerLocation: async (id) => fixes[id] || null,
  };
  const out = await shuttleMonitorService.positions({ tenantId: 't1' }, deps, NOW);

  assert.equal(out.waitingCustomers.length, 2, 'the foreign-tenant request never surfaces');
  const juan = out.waitingCustomers.find((c) => c.requestId === 'r1');
  assert.equal(juan.sharing, true);
  assert.equal(juan.lat, 33.941);
  assert.equal(juan.ageSeconds, 45);
  assert.equal(juan.bags, 3);
  assert.equal(juan.waitingMinutes, 12);
  assert.deepEqual(juan.assignedVehicle, { vehicleId: 'v1', label: '2023 Ford Transit 350', plate: 'IKT-482' });

  const rivera = out.waitingCustomers.find((c) => c.requestId === 'r3');
  assert.equal(rivera.sharing, false);
  assert.equal('lat' in rivera, false, 'not sharing = list only, no coordinate keys');

  // Redis down: everyone renders as not sharing, the monitor never breaks.
  const dark = await shuttleMonitorService.positions({ tenantId: 't1' }, {
    ...deps, readCustomerLocation: async () => { throw new Error('redis down'); },
  }, NOW);
  assert.equal(dark.waitingCustomers.every((c) => c.sharing === false), true);
});
