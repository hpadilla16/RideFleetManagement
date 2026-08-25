/**
 * Driver mode — the IO half, DB-free with an in-memory prisma (Phase 3
 * driver surface, 2026-08-25; approved mockup Screens 12–15 + 17a).
 *
 * What carries the operation:
 *   - the fail-closed token chain: expired/revoked/off/rotated-out = null
 *     (the route's bare 404), never a partial context;
 *   - roster scoping: the shift's OWN tenant+location only — a cross-sede or
 *     cross-tenant request is invisible AND unactionable;
 *   - picked-up / no-show go through the REAL shuttleRequestsService (the
 *     fan-out is not reimplemented), and no-show demands the confirm gate;
 *   - the driver-phone position is a FALLBACK: a device-mapped vehicle
 *     ignores it (pinned here), an unmapped one publishes through the house
 *     write path (VehicleTelematicsEvent + Redis) with source DRIVER_PHONE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shuttleDriverService } from './shuttle-driver.service.js';
import { shuttleRequestsService } from './shuttle-requests.service.js';

const NOW = new Date('2026-08-25T18:00:00Z');
const TOK_ACTIVE = 'tok_active_abcdefgh12345678';
const TOK_EXPIRED = 'tok_expired_abcdefgh1234567';
const TOK_REVOKED = 'tok_revoked_abcdefgh1234567';

// ─── in-memory prisma ───────────────────────────────────────────────────────

const matchVal = (val, cond) => {
  const v = val ?? null;
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('in' in cond) return cond.in.includes(v);
    if ('not' in cond) return v !== cond.not;
    if ('gt' in cond) return new Date(v).getTime() > new Date(cond.gt).getTime();
    if ('gte' in cond) return new Date(v).getTime() >= new Date(cond.gte).getTime();
    return true;
  }
  if (v instanceof Date || cond instanceof Date) {
    return new Date(v).getTime() === new Date(cond).getTime();
  }
  return v === (cond ?? null);
};
const matches = (row, where = {}) => Object.entries(where).every(([k, cond]) => matchVal(row[k], cond));

function table(rows, { idPrefix = 'row', uniqueBy = null } = {}) {
  let seq = 0;
  const sorted = (list, orderBy) => {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    if (!clauses.length) return list;
    const [k, dir] = Object.entries(clauses[0])[0];
    return [...list].sort((a, b) => (new Date(a[k]).getTime() - new Date(b[k]).getTime()) * (dir === 'desc' ? -1 : 1));
  };
  return {
    rows,
    async findFirst({ where } = {}) { return rows.find((r) => matches(r, where)) || null; },
    async findUnique({ where } = {}) { return rows.find((r) => matches(r, where)) || null; },
    async findMany({ where, orderBy, take } = {}) {
      let out = sorted(rows.filter((r) => matches(r, where)), orderBy);
      if (take) out = out.slice(0, take);
      return out;
    },
    async count({ where } = {}) { return rows.filter((r) => matches(r, where)).length; },
    async create({ data }) {
      if (uniqueBy && rows.some((r) => uniqueBy.every((k) => r[k] === data[k]))) {
        const e = new Error('unique violation'); e.code = 'P2002'; throw e;
      }
      const row = { id: data.id || `${idPrefix}_${++seq}`, createdAt: data.createdAt || NOW, ...data };
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }) {
      const row = rows.find((r) => matches(r, where));
      for (const [k, v] of Object.entries(data)) {
        row[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] || 0) + v.increment : v;
      }
      return { ...row };
    },
  };
}

function makeWorld({ mode = 'ON_DEMAND', deviceMapped = false, recipients = [{ name: 'Ops', email: 'ops@rentgo.example', channels: ['EMAIL'] }] } = {}) {
  const shifts = table([
    {
      id: 'shift_1', tenantId: 't1', locationId: 'lax', vehicleId: 'v1', driverName: 'Luis M.',
      token: TOK_ACTIVE, expiresAt: new Date('2026-08-25T23:59:59Z'), revokedAt: null,
      createdAt: new Date('2026-08-25T12:00:00Z'),
    },
    {
      id: 'shift_expired', tenantId: 't1', locationId: 'lax', vehicleId: 'v1', driverName: 'Old',
      token: TOK_EXPIRED, expiresAt: new Date('2026-08-25T11:00:00Z'), revokedAt: null,
      createdAt: new Date('2026-08-24T12:00:00Z'),
    },
    {
      id: 'shift_revoked', tenantId: 't1', locationId: 'lax', vehicleId: 'v1', driverName: 'Gone',
      token: TOK_REVOKED, expiresAt: new Date('2026-08-25T23:59:59Z'), revokedAt: new Date('2026-08-25T13:00:00Z'),
      createdAt: new Date('2026-08-25T09:00:00Z'),
    },
  ], { idPrefix: 'shift' });

  const configs = table([
    { id: 'c1', tenantId: 't1', locationId: 'lax', mode, headwayMinutes: 10, vehicleIdsJson: ['v1', 'v2'], alertRecipientsJson: recipients },
    { id: 'c2', tenantId: 't1', locationId: 'sju', mode: 'ON_DEMAND', headwayMinutes: 15, vehicleIdsJson: ['v2', 'v3'], alertRecipientsJson: null },
    { id: 'c9', tenantId: 't2', locationId: 'mia', mode: 'ON_DEMAND', headwayMinutes: 10, vehicleIdsJson: ['v9'], alertRecipientsJson: null },
  ]);

  const requests = table([
    {
      id: 'req_shared', tenantId: 't1', locationId: 'lax', reservationId: 'res_1',
      customerName: 'Juan P.', customerPhone: '+13105550182', partySize: 2, bags: 3,
      pickupSpotZoneId: 'z1', assignedVehicleId: 'v1', pickupNote: 'blue jacket',
      status: 'READY', smsOptIn: true, callCount: 1, createdAt: new Date('2026-08-25T17:50:00Z'),
    },
    {
      id: 'req_other_van', tenantId: 't1', locationId: 'lax', reservationId: 'res_2',
      customerName: 'K. Osei', customerPhone: null, partySize: 1, bags: 0,
      pickupSpotZoneId: null, assignedVehicleId: 'v2', pickupNote: null,
      status: 'VIEWED', smsOptIn: false, callCount: 1, createdAt: new Date('2026-08-25T17:55:00Z'),
    },
    {
      id: 'req_closed', tenantId: 't1', locationId: 'lax', reservationId: 'res_3',
      customerName: 'Done D.', status: 'COMPLETED', partySize: 1, smsOptIn: false,
      createdAt: new Date('2026-08-25T15:00:00Z'),
    },
    {
      id: 'req_sju', tenantId: 't1', locationId: 'sju', reservationId: 'res_4',
      customerName: 'Cross S.', status: 'READY', partySize: 1, smsOptIn: false,
      createdAt: new Date('2026-08-25T17:00:00Z'),
    },
    {
      id: 'req_t2', tenantId: 't2', locationId: 'mia', reservationId: 'res_9',
      customerName: 'Foreign F.', status: 'READY', partySize: 1, smsOptIn: false,
      createdAt: new Date('2026-08-25T17:00:00Z'),
    },
  ], { idPrefix: 'req' });

  const alerts = table([], { idPrefix: 'alert', uniqueBy: ['tenantId', 'providerRef'] });
  const messages = table([
    { id: 'msg_old', tenantId: 't1', shiftId: 'shift_1', message: 'Primer aviso', createdAt: new Date('2026-08-25T14:00:00Z') },
    { id: 'msg_new', tenantId: 't1', shiftId: 'shift_1', message: 'Recoge también en Terminal B', createdAt: new Date('2026-08-25T17:00:00Z') },
    { id: 'msg_foreign', tenantId: 't1', shiftId: 'shift_revoked', message: 'Otro turno', createdAt: new Date('2026-08-25T16:00:00Z') },
  ], { idPrefix: 'msg' });

  const world = {
    shifts, configs, requests, alerts, messages,
    events: table([], { idPrefix: 'evt' }),
    devices: table(deviceMapped ? [{ id: 'd1', vehicleId: 'v1', isActive: true, provider: 'ONESTEPGPS' }] : [], { idPrefix: 'dev' }),
    published: [], watched: [], sms: [], emails: [], cleared: [],
    requestCalls: [],
  };

  const prisma = {
    shuttleDriverShift: shifts,
    shuttleDriverMessage: messages,
    shuttleTrackerConfig: configs,
    shuttleRequest: requests,
    shuttleAlert: alerts,
    shuttleZone: table([
      {
        id: 'z1', tenantId: 't1', locationId: 'lax', name: 'Lot B', kind: 'ZONE', isPickupSpot: true,
        geometryJson: { type: 'rectangle', points: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { lat: 5, lng: 6 }] },
        toleranceM: null, walkingDirections: 'sign B-4', walkingDirectionsEs: 'letrero B-4', active: true,
        providerZoneId: 'osg_1', providerSyncStatus: 'SYNCED', notifyOnEnter: true,
      },
      { id: 'z_inactive', tenantId: 't1', locationId: 'lax', name: 'Old Lot', kind: 'ZONE', isPickupSpot: false, geometryJson: {}, active: false },
      { id: 'z_sju', tenantId: 't1', locationId: 'sju', name: 'SJU Curb', kind: 'ZONE', isPickupSpot: true, geometryJson: {}, active: true },
    ]),
    vehicle: table([
      { id: 'v1', tenantId: 't1', year: 2023, make: 'Ford', model: 'Transit 350', color: 'White', plate: 'IKT-482', internalNumber: 'S-01' },
      { id: 'v2', tenantId: 't1', year: 2022, make: 'Ram', model: 'ProMaster', color: 'Gray', plate: 'XYZ-001', internalNumber: 'S-02' },
      { id: 'v9', tenantId: 't2', make: 'Kia', model: 'Carnival', plate: 'T2-999' },
    ]),
    location: table([
      { id: 'lax', tenantId: 't1', name: 'LAX Airport', latitude: 33.9425, longitude: -118.4081, locationConfig: JSON.stringify({ locationPhone: '(310) 555-0100' }) },
      { id: 'sju', tenantId: 't1', name: 'SJU Airport', latitude: 18.4394, longitude: -66.0018, locationConfig: null },
      { id: 'mia', tenantId: 't2', name: 'MIA Airport', latitude: 25.7959, longitude: -80.287, locationConfig: null },
    ]),
    reservation: table([
      { id: 'res_1', tenantId: 't1', customer: { locale: 'es-PR' } },
      { id: 'res_2', tenantId: 't1', customer: { locale: 'en' } },
    ]),
    vehicleTelematicsDevice: world.devices,
    vehicleTelematicsEvent: world.events,
  };

  // The real shuttleRequestsService, spied — the driver surface must CALL it,
  // not reimplement it.
  const requestsDeps = {
    prisma,
    logger: { info() {}, warn() {}, error() {} },
    sendEmail: async (args) => { world.emails.push(args); },
    smsSend: async (args) => { world.sms.push(args); },
    resolveBrand: async () => ({ companyName: 'Rent & Go' }),
    clearCustomerLocation: async (id) => { world.cleared.push(id); },
    now: () => NOW,
  };
  const deps = {
    prisma,
    logger: { info() {}, warn() {}, error() {} },
    sendEmail: async (args) => { world.emails.push(args); },
    signalWatch: async (tenantId) => { world.watched.push(tenantId); },
    readCustomerLocation: async (requestId) => (
      requestId === 'req_shared' ? { lat: 33.9401, lng: -118.4109, at: NOW.getTime() - 30 * 1000 } : null
    ),
    publishPosition: async (vehicleId, fix) => { world.published.push({ vehicleId, fix }); },
    requests: {
      markPickedUp: (...args) => { world.requestCalls.push(['markPickedUp', args[0]]); return shuttleRequestsService.markPickedUp(...args); },
      markNoShow: (...args) => { world.requestCalls.push(['markNoShow', args[0]]); return shuttleRequestsService.markNoShow(...args); },
    },
    requestsDeps,
    now: () => NOW,
  };
  world.deps = deps;
  return world;
}

// ─── mint / list / revoke ───────────────────────────────────────────────────

test('mintShift: unambiguous vehicle → shift at its configured sede, house token, end-of-day default expiry', async () => {
  const w = makeWorld();
  const shift = await shuttleDriverService.mintShift(
    { vehicleId: 'v1', driverName: '  Luis M.  ' },
    { tenantId: 't1' }, 'user_1', w.deps
  );
  assert.equal(shift.locationId, 'lax', 'location derived from the config list');
  assert.equal(shift.driverName, 'Luis M.');
  assert.equal(shift.createdByUserId, 'user_1');
  assert.match(shift.token, /^[A-Za-z0-9_-]{32}$/, '192-bit base64url house token');
  assert.ok(shift.expiresAt.getTime() > NOW.getTime());
  assert.ok(shift.expiresAt.getTime() - NOW.getTime() <= 24 * 3600 * 1000, 'never beyond 24h');
});

test('mintShift: hours honored within [1,24]; out-of-range is a 400', async () => {
  const w = makeWorld();
  const shift = await shuttleDriverService.mintShift(
    { vehicleId: 'v1', driverName: 'Luis', hours: 6 },
    { tenantId: 't1' }, null, w.deps
  );
  assert.equal(shift.expiresAt.getTime(), NOW.getTime() + 6 * 3600 * 1000);
  await assert.rejects(
    shuttleDriverService.mintShift({ vehicleId: 'v1', driverName: 'Luis', hours: 30 }, { tenantId: 't1' }, null, w.deps),
    (e) => e.status === 400
  );
});

test('mintShift fail-closed: foreign vehicle, unconfigured vehicle, and out-of-scope sede all read the same 400', async () => {
  const w = makeWorld();
  // Another tenant's vehicle — not an existence oracle.
  await assert.rejects(
    shuttleDriverService.mintShift({ vehicleId: 'v9', driverName: 'X' }, { tenantId: 't1' }, null, w.deps),
    (e) => e.status === 400
  );
  // Owned but not in any tracker config.
  w.deps.prisma.vehicle.rows.push({ id: 'v_plain', tenantId: 't1', make: 'Toyota', model: 'Corolla' });
  await assert.rejects(
    shuttleDriverService.mintShift({ vehicleId: 'v_plain', driverName: 'X' }, { tenantId: 't1' }, null, w.deps),
    (e) => e.status === 400
  );
  // Configured at LAX, but the caller is scoped to SJU only.
  await assert.rejects(
    shuttleDriverService.mintShift({ vehicleId: 'v1', driverName: 'X' }, { tenantId: 't1', allowedLocationIds: ['sju'] }, null, w.deps),
    (e) => e.status === 400
  );
});

test('mintShift ambiguity: a vehicle serving two sedes demands locationId, then honors it', async () => {
  const w = makeWorld();
  await assert.rejects(
    shuttleDriverService.mintShift({ vehicleId: 'v2', driverName: 'X' }, { tenantId: 't1' }, null, w.deps),
    (e) => e.status === 400 && /multiple locations/.test(e.message)
  );
  const shift = await shuttleDriverService.mintShift(
    { vehicleId: 'v2', driverName: 'X', locationId: 'sju' },
    { tenantId: 't1' }, null, w.deps
  );
  assert.equal(shift.locationId, 'sju');
});

test('listShifts: ACTIVE only, scoped, and the token is NEVER re-listed', async () => {
  const w = makeWorld();
  const out = await shuttleDriverService.listShifts({ tenantId: 't1' }, w.deps);
  assert.deepEqual(out.shifts.map((s) => s.id), ['shift_1'], 'expired + revoked stay out');
  const s = out.shifts[0];
  assert.equal(s.vehicleLabel, '2023 Ford Transit 350');
  assert.equal(s.plate, 'IKT-482');
  assert.equal(s.locationName, 'LAX Airport');
  assert.equal('token' in s, false, 'the mint response is the ONE time a link is shown');
  const foreign = await shuttleDriverService.listShifts({ tenantId: 't2' }, w.deps);
  assert.equal(foreign.shifts.length, 0);
});

test('revokeShift: scoped fail-closed 404; revocation kills the token immediately; idempotent', async () => {
  const w = makeWorld();
  await assert.rejects(
    shuttleDriverService.revokeShift('shift_1', { tenantId: 't2' }, w.deps),
    (e) => e.status === 404
  );
  const row = await shuttleDriverService.revokeShift('shift_1', { tenantId: 't1' }, w.deps);
  assert.ok(row.revokedAt, 'revokedAt stamped');
  assert.equal(await shuttleDriverService.shiftContext(TOK_ACTIVE, w.deps), null, 'the live token dies with the revoke');
  const again = await shuttleDriverService.revokeShift('shift_1', { tenantId: 't1' }, w.deps);
  assert.equal(again.revokedAt.getTime(), row.revokedAt.getTime(), 'idempotent — no re-stamp');
});

// ─── token resolution (the bare-404 chain) ──────────────────────────────────

test('resolveShift fail-closed chain: expired, revoked, short, unknown, mode OFF, vehicle rotated out — all null', async () => {
  const w = makeWorld();
  assert.notEqual(await shuttleDriverService.resolveShift(TOK_ACTIVE, w.deps), null);
  assert.equal(await shuttleDriverService.resolveShift(TOK_EXPIRED, w.deps), null, 'expired');
  assert.equal(await shuttleDriverService.resolveShift(TOK_REVOKED, w.deps), null, 'revoked');
  assert.equal(await shuttleDriverService.resolveShift('short', w.deps), null, 'too short to even look up');
  assert.equal(await shuttleDriverService.resolveShift('nope_abcdefgh12345678', w.deps), null, 'unknown');

  const off = makeWorld({ mode: 'OFF' });
  assert.equal(await shuttleDriverService.resolveShift(TOK_ACTIVE, off.deps), null, 'tracker OFF kills the link');

  const rotated = makeWorld();
  rotated.configs.rows[0].vehicleIdsJson = ['v2']; // v1 rotated out of shuttle duty
  assert.equal(await shuttleDriverService.resolveShift(TOK_ACTIVE, rotated.deps), null, 'de-configured vehicle kills the link');

  const transferred = makeWorld();
  transferred.deps.prisma.vehicle.rows.find((v) => v.id === 'v1').tenantId = 't2'; // super moved the unit
  assert.equal(await shuttleDriverService.resolveShift(TOK_ACTIVE, transferred.deps), null, 'ownership re-verified on every read');
});

// ─── shift context (the driver page) ────────────────────────────────────────

test('shiftContext: vehicle + location + zones-with-geometry + roster, scoped to the shift sede only', async () => {
  const w = makeWorld();
  const ctx = await shuttleDriverService.shiftContext(TOK_ACTIVE, w.deps);
  assert.equal(ctx.driverName, 'Luis M.');
  assert.equal(ctx.mode, 'ON_DEMAND');
  assert.deepEqual(ctx.vehicle, { name: 'Ford Transit 350', color: 'White', plate: 'IKT-482' });
  assert.equal(ctx.location.name, 'LAX Airport');

  // Zones: active LAX zones only, drawing fields only.
  assert.deepEqual(ctx.zones.map((z) => z.id), ['z1'], 'inactive + cross-sede zones stay out');
  assert.equal(ctx.zones[0].name, 'Lot B');
  assert.ok(ctx.zones[0].geometry, 'geometry crosses — the driver draws the spots');
  // Per-language directions (2026-08-25): both texts ride to the driver page.
  assert.equal(ctx.zones[0].walkingDirections, 'sign B-4');
  assert.equal(ctx.zones[0].walkingDirectionsEs, 'letrero B-4');
  assert.equal('providerZoneId' in ctx.zones[0], false);

  // Roster: the OPEN queue of the shift's sede — closed, cross-sede and
  // cross-tenant rows invisible.
  assert.deepEqual(ctx.roster.map((r) => r.id), ['req_shared', 'req_other_van'], 'oldest first');
  assert.equal(ctx.roster.some((r) => ['req_closed', 'req_sju', 'req_t2'].includes(r.id)), false);

  const shared = ctx.roster[0];
  assert.equal(shared.pickupSpot, 'Lot B', 'spot zone name resolved');
  assert.equal(shared.assignedToYou, true, 'assigned to THIS van (ON_DEMAND highlight)');
  assert.equal(shared.sharing, true);
  assert.equal(shared.lat, 33.9401, 'sharing customer coords cross — the driver is who they exist for');
  assert.equal(shared.ageSeconds, 30);

  const notSharing = ctx.roster[1];
  assert.equal(notSharing.sharing, false);
  assert.equal('lat' in notSharing, false, 'no coordinate keys without sharing');
  assert.equal(notSharing.assignedToYou, false);
  assert.equal(notSharing.assignedVehicle.plate, 'XYZ-001', 'the other van still labels');

  assert.deepEqual(w.watched, ['t1'], 'the driver page arms the fast-poll watch signal');
});

// ─── driver-phone position fallback ─────────────────────────────────────────

test('pushPosition unmapped vehicle: the house write path — event row (source DRIVER_PHONE) + Redis publish', async () => {
  const w = makeWorld({ deviceMapped: false });
  const out = await shuttleDriverService.pushPosition(TOK_ACTIVE, { lat: 33.94, lng: -118.41 }, w.deps);
  assert.deepEqual(out, { ok: true, accepted: true });

  assert.equal(w.events.rows.length, 1);
  const evt = w.events.rows[0];
  assert.equal(evt.vehicleId, 'v1');
  assert.equal(evt.tenantId, 't1');
  assert.equal(evt.eventType, 'PING');
  assert.equal(JSON.parse(evt.payloadJson).source, 'DRIVER_PHONE');

  assert.equal(w.published.length, 1);
  assert.equal(w.published[0].vehicleId, 'v1');
  assert.equal(w.published[0].fix.latitude, 33.94);
  assert.equal(w.published[0].fix.longitude, -118.41);
});

test('PINNED: a device-mapped vehicle IGNORES driver-phone fixes — no row, no publish, accepted:false', async () => {
  const w = makeWorld({ deviceMapped: true });
  const out = await shuttleDriverService.pushPosition(TOK_ACTIVE, { lat: 33.94, lng: -118.41 }, w.deps);
  assert.equal(out.ok, true, 'the POST succeeds so the page keeps its cadence');
  assert.equal(out.accepted, false);
  assert.equal(w.events.rows.length, 0, 'the device is the truth — nothing written');
  assert.equal(w.published.length, 0, 'nothing published to Redis either');
});

test('pushPosition: garbage coordinates are a 400, never stored; dead token is null (404)', async () => {
  const w = makeWorld();
  await assert.rejects(
    shuttleDriverService.pushPosition(TOK_ACTIVE, { lat: 91, lng: 0 }, w.deps),
    (e) => e.status === 400
  );
  assert.equal(w.events.rows.length, 0);
  assert.equal(await shuttleDriverService.pushPosition(TOK_EXPIRED, { lat: 1, lng: 2 }, w.deps), null);
});

// ─── roster actions through the REAL services ───────────────────────────────

test('markPickedUp: calls the real shuttleRequestsService, closes COMPLETED, clears the location key', async () => {
  const w = makeWorld();
  const out = await shuttleDriverService.markPickedUp(TOK_ACTIVE, 'req_shared', w.deps);
  assert.deepEqual(out, { ok: true, id: 'req_shared', status: 'COMPLETED' });
  assert.deepEqual(w.requestCalls, [['markPickedUp', 'req_shared']], 'the EXISTING service, not a reimplementation');
  assert.equal(w.requests.rows.find((r) => r.id === 'req_shared').status, 'COMPLETED');
  assert.deepEqual(w.cleared, ['req_shared'], 'ephemeral sharing dies with the pickup');
});

test('markPickedUp fail-closed: a cross-sede or cross-tenant request is a 404, untouched', async () => {
  const w = makeWorld();
  for (const id of ['req_sju', 'req_t2']) {
    await assert.rejects(
      shuttleDriverService.markPickedUp(TOK_ACTIVE, id, w.deps),
      (e) => e.status === 404,
      `${id} must be invisible to this shift`
    );
  }
  assert.equal(w.requests.rows.find((r) => r.id === 'req_sju').status, 'READY');
  assert.equal(w.requests.rows.find((r) => r.id === 'req_t2').status, 'READY');
});

test('markNoShow confirm gate: without {confirmed:true} it is a 400 BEFORE any state or fan-out', async () => {
  const w = makeWorld();
  for (const body of [{}, { confirmed: false }, { confirmed: 'true' }, { confirmed: 1 }]) {
    await assert.rejects(
      shuttleDriverService.markNoShow(TOK_ACTIVE, 'req_shared', body, w.deps),
      (e) => e.status === 400 && e.code === 'CONFIRM_REQUIRED'
    );
  }
  assert.equal(w.requestCalls.length, 0, 'the service was never even called');
  assert.equal(w.requests.rows.find((r) => r.id === 'req_shared').status, 'READY');
});

test('markNoShow confirmed: the REAL fan-out runs — NO_SHOW close, customer SMS, REQUEST_NO_SHOW alert', async () => {
  const w = makeWorld();
  const out = await shuttleDriverService.markNoShow(TOK_ACTIVE, 'req_shared', { confirmed: true }, w.deps);
  assert.deepEqual(out, { ok: true, id: 'req_shared', status: 'NO_SHOW' });
  assert.deepEqual(w.requestCalls, [['markNoShow', 'req_shared']]);
  assert.equal(w.requests.rows.find((r) => r.id === 'req_shared').status, 'NO_SHOW');
  assert.equal(w.sms.length, 1, 'opted-in customer got the no-show SMS through the existing chain');
  assert.equal(w.sms[0].to, '+13105550182');
  const alert = w.alerts.rows.find((a) => a.type === 'REQUEST_NO_SHOW');
  assert.ok(alert, 'the staff feed row came from the existing fan-out');
  assert.equal(alert.providerRef, 'noshow:req_shared');
  assert.deepEqual(w.cleared, ['req_shared']);
});

// ─── notifications ──────────────────────────────────────────────────────────

test('notifications: staff notify → stored; the driver reads HIS shift only, newest first', async () => {
  const w = makeWorld();
  const sent = await shuttleDriverService.notifyShift('shift_1', '  Cliente extra en Lot B  ', { tenantId: 't1' }, 'user_1', w.deps);
  assert.equal(sent.ok, true);

  const out = await shuttleDriverService.listNotifications(TOK_ACTIVE, w.deps);
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[0].message, 'Cliente extra en Lot B', 'trimmed, newest first');
  assert.equal(out.messages.some((m) => m.message === 'Otro turno'), false, 'another shift\'s messages are invisible');
});

test('notifyShift guards: empty message 400, foreign scope 404, dead shift 409', async () => {
  const w = makeWorld();
  await assert.rejects(shuttleDriverService.notifyShift('shift_1', '   ', { tenantId: 't1' }, null, w.deps), (e) => e.status === 400);
  await assert.rejects(shuttleDriverService.notifyShift('shift_1', 'hola', { tenantId: 't2' }, null, w.deps), (e) => e.status === 404);
  await assert.rejects(shuttleDriverService.notifyShift('shift_expired', 'hola', { tenantId: 't1' }, null, w.deps), (e) => e.status === 409);
  await assert.rejects(shuttleDriverService.notifyShift('shift_revoked', 'hola', { tenantId: 't1' }, null, w.deps), (e) => e.status === 409);
});

// ─── issues ─────────────────────────────────────────────────────────────────

test('reportIssue: a DRIVER_ISSUE alert row (ids + words only) + email to the EMAIL-channel recipients', async () => {
  const w = makeWorld();
  const out = await shuttleDriverService.reportIssue(TOK_ACTIVE, { category: 'mecanico', note: 'Se calienta el motor' }, w.deps);
  assert.deepEqual(out, { ok: true });

  const alert = w.alerts.rows.find((a) => a.type === 'DRIVER_ISSUE');
  assert.ok(alert);
  assert.equal(alert.tenantId, 't1');
  assert.equal(alert.vehicleId, 'v1');
  assert.match(alert.providerRef, /^drvissue:shift_1:/);
  const raw = JSON.parse(alert.rawJson);
  assert.equal(raw.shiftId, 'shift_1');
  assert.equal(raw.category, 'MECANICO');
  assert.equal(raw.note, 'Se calienta el motor');
  assert.equal('lat' in raw, false, 'never coordinates');

  assert.equal(w.emails.length, 1);
  assert.equal(w.emails[0].to, 'ops@rentgo.example');
  assert.match(w.emails[0].subject, /MECANICO/);
  assert.match(w.emails[0].subject, /Ford Transit 350/);
  assert.match(w.emails[0].text, /LAX Airport/);
});

test('reportIssue: two reports in one shift both land (unique refs); bad category 400; no recipients = row only', async () => {
  const w = makeWorld({ recipients: null });
  await shuttleDriverService.reportIssue(TOK_ACTIVE, { category: 'TRAFICO' }, w.deps);
  await shuttleDriverService.reportIssue(TOK_ACTIVE, { category: 'TRAFICO' }, w.deps);
  assert.equal(w.alerts.rows.filter((a) => a.type === 'DRIVER_ISSUE').length, 2, 'a driver CAN file twice');
  assert.equal(w.emails.length, 0, 'no recipients configured — the alert row still lands');
  await assert.rejects(
    shuttleDriverService.reportIssue(TOK_ACTIVE, { category: 'ENGINE' }, w.deps),
    (e) => e.status === 400
  );
});
