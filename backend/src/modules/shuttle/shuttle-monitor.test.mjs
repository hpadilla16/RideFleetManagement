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
  waitingCustomerPayload, alertDetail, alertRequestId, zoneLessAlertVisible,
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
  // `zoneId: null` must match an absent key too (the alert feed's zone-less half).
  if (v === null) return (row[k] ?? null) === null;
  return row[k] === v;
});

function fakePrisma(data) {
  const table = (rows) => ({
    rows,
    findMany: async ({ where, orderBy, take } = {}) => {
      let out = rows.filter((r) => matches(r, where));
      const clause = Array.isArray(orderBy) ? orderBy[0] : orderBy;
      if (clause) {
        const [k, dir] = Object.entries(clause)[0];
        out = [...out].sort((a, b) => (new Date(a[k]).getTime() - new Date(b[k]).getTime()) * (dir === 'desc' ? -1 : 1));
      }
      return take ? out.slice(0, take) : out;
    },
    count: async ({ where } = {}) => rows.filter((r) => matches(r, where)).length,
  });
  return {
    shuttleTrackerConfig: table(data.configs || []),
    location: table(data.locations || []),
    vehicle: table(data.vehicles || []),
    vehicleTelematicsDevice: table(data.devices || []),
    shuttleRequest: table(data.requests || []),
    shuttleZone: table(data.zones || []),
    shuttleAlert: table(data.alerts || []),
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

// ─── 2026-08-26: pickup-spot NAME on the waiting list ───────────────────────

test('waitingCustomerPayload: pickupSpotName is one extra picked string beside the id', () => {
  const request = { id: 'r1', locationId: 'lax', customerName: 'Juan P.', partySize: 2, bags: 3, pickupSpotZoneId: 'zone_b', createdAt: secondsAgo(600) };
  const named = waitingCustomerPayload({ request, fix: null, spotName: '  Lot B  ', now: NOW });
  assert.equal(named.pickupSpotZoneId, 'zone_b');
  assert.equal(named.pickupSpotName, 'Lot B', 'trimmed');
  assert.deepEqual(Object.keys(named).sort(), [
    'assignedVehicle', 'bags', 'locationId', 'name', 'partySize',
    'pickupSpotName', 'pickupSpotZoneId', 'requestId', 'sharing', 'waitingMinutes',
  ]);
  // Unresolvable (a deleted zone, a failed lookup) is honestly null — never
  // the raw id dressed up as a name.
  assert.equal(waitingCustomerPayload({ request, fix: null, now: NOW }).pickupSpotName, null);
});

test('waitingCustomers resolve the spot name inside the tenant + configured sedes', async () => {
  const data = {
    ...DATA,
    zones: [
      { id: 'zone_b', tenantId: 't1', locationId: 'lax', name: 'Lot B' },
      { id: 'zone_foreign', tenantId: 't2', locationId: 'mia', name: 'Foreign Curb' },
    ],
    requests: [
      { id: 'r1', tenantId: 't1', locationId: 'lax', status: 'READY', customerName: 'Juan P.', partySize: 2, pickupSpotZoneId: 'zone_b', createdAt: secondsAgo(600) },
      { id: 'r4', tenantId: 't1', locationId: 'lax', status: 'READY', customerName: 'Cross C.', partySize: 1, pickupSpotZoneId: 'zone_foreign', createdAt: secondsAgo(300) },
    ],
  };
  const deps = {
    prisma: fakePrisma(data),
    latestPositionsByVehicle: positionsFor(T1_FIXES),
    readCustomerLocation: async () => null,
  };
  const out = await shuttleMonitorService.positions({ tenantId: 't1' }, deps, NOW);
  const byId = Object.fromEntries(out.waitingCustomers.map((c) => [c.requestId, c]));
  assert.equal(byId.r1.pickupSpotName, 'Lot B');
  assert.equal(byId.r4.pickupSpotName, null, 'a zone from another tenant never resolves');

  // Cosmetic only: a dead zone table leaves names null and the map intact.
  const broken = fakePrisma(data);
  broken.shuttleZone.findMany = async () => { throw new Error('zones down'); };
  const degraded = await shuttleMonitorService.positions({ tenantId: 't1' }, { ...deps, prisma: broken }, NOW);
  assert.equal(degraded.waitingCustomers.length, 2);
  assert.equal(degraded.waitingCustomers.every((c) => c.pickupSpotName === null), true);
});

// ─── 2026-08-26: alert feed detail + zone-less visibility ───────────────────

test('alertRequestId: rawJson first, then the deterministic noshow: providerRef, else null', () => {
  assert.equal(alertRequestId({ rawJson: JSON.stringify({ requestId: 'req_1' }), providerRef: 'noshow:req_9' }), 'req_1');
  assert.equal(alertRequestId({ rawJson: null, providerRef: 'noshow:req_9' }), 'req_9');
  assert.equal(alertRequestId({ rawJson: 'not json', providerRef: 'noshow:req_9' }), 'req_9');
  assert.equal(alertRequestId({ providerRef: 'a-100' }), null, 'a provider geofence alert names no request');
  assert.equal(alertRequestId({ rawJson: JSON.stringify(['array']) }), null);
  assert.equal(alertRequestId({}), null);
});

test('alertDetail is FIELD-PICKED — a fattened rawJson never becomes new response keys', () => {
  const row = {
    providerRef: 'noshow:req_1',
    rawJson: JSON.stringify({
      requestId: 'req_1', customerName: 'Juan P.', partySize: 2, bags: 3, markedBy: 'driver: Luis M.',
      // Anything a later code path adds must stay behind the whitelist.
      customerPhone: '+13105550999', lat: 33.94, lng: -118.41, reservationId: 'res_1', internalNote: 'x',
    }),
  };
  const out = alertDetail(row, '+13105550182');
  assert.deepEqual(Object.keys(out).sort(), ['bags', 'customerName', 'customerPhone', 'markedBy', 'partySize', 'requestId']);
  assert.equal(out.customerName, 'Juan P.');
  assert.equal(out.partySize, 2);
  assert.equal(out.bags, 3);
  assert.equal(out.markedBy, 'driver: Luis M.');
  // The phone is the CALLER's scope-checked value, never the blob's.
  assert.equal(out.customerPhone, '+13105550182');
  assert.equal(JSON.stringify(out).includes('3105550999'), false);
  assert.equal(JSON.stringify(out).includes('33.94'), false, 'coordinates never ride an alert detail');
  assert.equal(JSON.stringify(out).includes('res_1'), false);

  // No payload at all = no detail block (a plain geofence ENTER).
  assert.equal(alertDetail({ providerRef: 'a-100', rawJson: JSON.stringify({ zone: 'prov-1' }) }), null);
  assert.equal(alertDetail({}), null);
  // No resolved phone is null, never an empty string the UI would tel: to.
  assert.equal(alertDetail(row).customerPhone, null);
});

test('zoneLessAlertVisible: request wins, then the vehicle, then FAIL CLOSED', () => {
  const vehicles = new Set(['v1']);
  // 1) names a request the caller can see
  assert.equal(zoneLessAlertVisible({ row: { vehicleId: null }, scopedRequest: { id: 'r', locationId: 'lax' }, allowedVehicleIds: vehicles, hasRequestRef: true }), true);
  // 1b) names one they cannot — hidden even though the vehicle is theirs
  assert.equal(zoneLessAlertVisible({ row: { vehicleId: 'v1' }, scopedRequest: null, allowedVehicleIds: vehicles, hasRequestRef: true }), false);
  // 2) no request ref, but the vehicle is configured at an allowed sede
  assert.equal(zoneLessAlertVisible({ row: { vehicleId: 'v1' }, allowedVehicleIds: vehicles }), true);
  assert.equal(zoneLessAlertVisible({ row: { vehicleId: 'v-other' }, allowedVehicleIds: vehicles }), false);
  // 3) nothing to tie it to
  assert.equal(zoneLessAlertVisible({ row: { vehicleId: null }, allowedVehicleIds: vehicles }), false);
  assert.equal(zoneLessAlertVisible({ row: {}, allowedVehicleIds: new Set() }), false);
});

const ALERT_DATA = () => ({
  ...DATA,
  zones: [
    { id: 'z_lax', tenantId: 't1', locationId: 'lax', name: 'Lot B', kind: 'ZONE', isPickupSpot: true },
    { id: 'z_sju', tenantId: 't1', locationId: 'sju', name: 'SJU Curb', kind: 'ZONE', isPickupSpot: true },
  ],
  requests: [
    { id: 'req_lax', tenantId: 't1', locationId: 'lax', status: 'NO_SHOW', customerName: 'Juan P.', customerPhone: '+13105550182', partySize: 2, bags: 3, createdAt: secondsAgo(3600) },
    { id: 'req_sju', tenantId: 't1', locationId: 'sju', status: 'NO_SHOW', customerName: 'Ana R.', customerPhone: '+17875550100', partySize: 1, createdAt: secondsAgo(3600) },
  ],
  alerts: [
    // zoned — visible to LAX staff the old way
    { id: 'al_zoned', tenantId: 't1', zoneId: 'z_lax', vehicleId: 'v1', type: 'ENTER', providerRef: 'a-1', rawJson: null, occurredAt: new Date(NOW - 60_000), staffNotifiedAt: null },
    // zone-less no-show for a LAX request, no assigned van
    {
      id: 'al_noshow_lax', tenantId: 't1', zoneId: null, vehicleId: null, type: 'REQUEST_NO_SHOW',
      providerRef: 'noshow:req_lax', occurredAt: new Date(NOW - 120_000), staffNotifiedAt: null,
      rawJson: JSON.stringify({ requestId: 'req_lax', customerName: 'Juan P.', partySize: 2, bags: 3, markedBy: 'driver: Luis M.' }),
    },
    // zone-less no-show at ANOTHER sede
    {
      id: 'al_noshow_sju', tenantId: 't1', zoneId: null, vehicleId: null, type: 'REQUEST_NO_SHOW',
      providerRef: 'noshow:req_sju', occurredAt: new Date(NOW - 180_000), staffNotifiedAt: null,
      rawJson: JSON.stringify({ requestId: 'req_sju', customerName: 'Ana R.', partySize: 1, markedBy: 'staff' }),
    },
    // zone-less driver issue on a LAX-configured van
    {
      id: 'al_issue_lax', tenantId: 't1', zoneId: null, vehicleId: 'v1', type: 'DRIVER_ISSUE',
      providerRef: 'drvissue:shift_1:aabb', occurredAt: new Date(NOW - 240_000), staffNotifiedAt: null,
      rawJson: JSON.stringify({ shiftId: 'shift_1', category: 'MECANICO', note: 'humo', driverName: 'Luis M.' }),
    },
    // zone-less driver issue on the SJU van
    {
      id: 'al_issue_sju', tenantId: 't1', zoneId: null, vehicleId: 'v2', type: 'DRIVER_ISSUE',
      providerRef: 'drvissue:shift_2:ccdd', occurredAt: new Date(NOW - 300_000), staffNotifiedAt: null,
      rawJson: JSON.stringify({ shiftId: 'shift_2', category: 'TRAFICO', driverName: 'Ana' }),
    },
    // unattributable: no zone, no vehicle, no request — nobody scoped sees it
    { id: 'al_orphan', tenantId: 't1', zoneId: null, vehicleId: null, type: 'OFF_ROUTE', providerRef: 'a-orphan', rawJson: null, occurredAt: new Date(NOW - 360_000), staffNotifiedAt: null },
    // another tenant's row, never anywhere
    { id: 'al_t2', tenantId: 't2', zoneId: null, vehicleId: 'vx', type: 'DRIVER_ISSUE', providerRef: 'x', rawJson: null, occurredAt: new Date(NOW - 10_000), staffNotifiedAt: null },
  ],
});

test('alerts FAIL-CLOSED: no tenant, no feed — and another tenant’s rows never appear', async () => {
  const deps = { prisma: fakePrisma(ALERT_DATA()) };
  assert.deepEqual(await shuttleMonitorService.alerts({}, {}, deps), { alerts: [] });
  const out = await shuttleMonitorService.alerts({ tenantId: 't1' }, {}, deps);
  assert.equal(out.alerts.some((a) => a.id === 'al_t2'), false);
});

test('alerts detail: the no-show payload is whitelisted in, WITH the scope-checked callback number', async () => {
  const deps = { prisma: fakePrisma(ALERT_DATA()) };
  const out = await shuttleMonitorService.alerts({ tenantId: 't1' }, {}, deps);

  const noshow = out.alerts.find((a) => a.id === 'al_noshow_lax');
  assert.deepEqual(Object.keys(noshow).sort(), ['detail', 'id', 'occurredAt', 'staffNotifiedAt', 'type', 'vehicle', 'zone']);
  assert.deepEqual(noshow.detail, {
    requestId: 'req_lax', customerName: 'Juan P.', partySize: 2, bags: 3,
    markedBy: 'driver: Luis M.', customerPhone: '+13105550182',
  });

  // A plain geofence alert grows no detail block at all.
  assert.equal(out.alerts.find((a) => a.id === 'al_zoned').detail, null);
  // And the raw blob itself never ships.
  assert.equal(JSON.stringify(out).includes('rawJson'), false);
  assert.equal(JSON.stringify(out).includes('shiftId'), false);
});

test('ZONE-LESS alerts reach location-scoped staff — their own, and ONLY their own', async () => {
  const deps = { prisma: fakePrisma(ALERT_DATA()) };

  const lax = await shuttleMonitorService.alerts({ tenantId: 't1', allowedLocationIds: ['lax'] }, {}, deps);
  const laxIds = lax.alerts.map((a) => a.id).sort();
  assert.deepEqual(laxIds, ['al_issue_lax', 'al_noshow_lax', 'al_zoned'],
    'the LAX no-show (via its request) and the LAX van issue (via its config) now arrive');
  assert.equal(lax.alerts.find((a) => a.id === 'al_noshow_lax').detail.customerPhone, '+13105550182');

  const sju = await shuttleMonitorService.alerts({ tenantId: 't1', allowedLocationIds: ['sju'] }, {}, deps);
  assert.deepEqual(sju.alerts.map((a) => a.id).sort(), ['al_issue_sju', 'al_noshow_sju']);
  assert.equal(sju.alerts.some((a) => ['al_noshow_lax', 'al_issue_lax'].includes(a.id)), false,
    'the other sede stays invisible — the fix widens nothing');
  assert.equal(sju.alerts.find((a) => a.id === 'al_noshow_sju').detail.customerPhone, '+17875550100');

  // Unattributable rows stay hidden from every scoped caller, visible only in
  // the unscoped tenant feed.
  assert.equal([...laxIds, ...sju.alerts.map((a) => a.id)].includes('al_orphan'), false);
  const unscoped = await shuttleMonitorService.alerts({ tenantId: 't1' }, {}, deps);
  assert.equal(unscoped.alerts.some((a) => a.id === 'al_orphan'), true);
  assert.deepEqual(unscoped.alerts.map((a) => a.id), [
    'al_zoned', 'al_noshow_lax', 'al_noshow_sju', 'al_issue_lax', 'al_issue_sju', 'al_orphan',
  ], 'newest first');
});

test('alerts: a scope naming a FOREIGN location yields nothing, not that location', async () => {
  const deps = { prisma: fakePrisma(ALERT_DATA()) };
  const out = await shuttleMonitorService.alerts({ tenantId: 't1', allowedLocationIds: ['mia'] }, {}, deps);
  assert.deepEqual(out.alerts, []);
});
