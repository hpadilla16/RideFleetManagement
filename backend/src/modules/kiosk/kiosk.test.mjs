/**
 * Ride Kiosk — Fase B1 tests (2026-07-05).
 * Run: npm run test:kiosk  (node --test --test-force-exit)
 *
 * Same harness style as spin-charge.test.mjs: prisma delegate methods are
 * stubbed in-memory (no DB), checkoutSessionService.createForReservation is
 * monkeypatched for the assign-vehicle tests. Covers:
 *   (a) pairing happy path / expired code / per-IP miss lockout / revoked / rotation
 *   (b) requireKioskDevice accepts valid + rejects invalid tokens
 *   (c) lookup returns the MASKED stub only + PER-DEVICE miss lockout
 *       (survives new sessions, other devices unaffected, lock expires)
 *   (d) session-device binding (device B → device A's session = 404)
 *   (e) assign-vehicle race: one winner, loser converges cleanly (incl. P2002)
 *   (f) events cap + lastActivityAt bump
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import {
  kioskDeviceService,
  KioskError,
  sha256Hex,
  MAX_PAIRING_ATTEMPTS,
  resetPairMissTracking,
} from './kiosk-device.service.js';
import { requireKioskDevice } from './kiosk-auth.middleware.js';
import {
  kioskSessionService,
  maskCustomerName,
  MAX_SESSION_EVENTS,
  MAX_LOOKUP_MISSES,
  projectAssistTimeline,
  ASSIST_TIMELINE_CAP,
  VOZIA_BINDING_TTL_MIN,
} from './kiosk-session.service.js';
import { setKioskSmartMatcher } from './kiosk-smart-match.js';
import { samePickupDay } from './kiosk-session.service.js';
import { checkoutSessionService } from '../checkout-session/checkout-session.service.js';

// ---------------------------------------------------------------------------
// In-memory DB + a tiny where-matcher for the exact query shapes the module
// uses ({ in }, { not }, { gt/gte/lt/lte }, { equals, mode }, { is }).
// ---------------------------------------------------------------------------

let db;

function condMatch(rowVal, cond) {
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'mode') continue;
    if (op === 'not') {
      if (val === null ? rowVal == null : rowVal === val) return false;
    } else if (op === 'in') {
      if (!val.includes(rowVal)) return false;
    } else if (op === 'gt') {
      if (!(rowVal != null && rowVal > val)) return false;
    } else if (op === 'gte') {
      if (!(rowVal != null && rowVal >= val)) return false;
    } else if (op === 'lt') {
      if (!(rowVal != null && rowVal < val)) return false;
    } else if (op === 'lte') {
      if (!(rowVal != null && rowVal <= val)) return false;
    } else if (op === 'equals') {
      if (String(rowVal ?? '').toLowerCase() !== String(val ?? '').toLowerCase()) return false;
    } else if (op === 'is') {
      if (!matches(rowVal || {}, val)) return false;
    } else {
      // nested relation object (e.g. customer: { lastName: {...} })
      if (!matches(rowVal || {}, { [op]: val })) return false;
    }
  }
  return true;
}

function matches(row, where) {
  return Object.entries(where || {}).every(([key, val]) => {
    if (val === undefined) return true;
    if (val === null) return row[key] == null;
    if (val instanceof Date || typeof val !== 'object') return row[key] === val || (val instanceof Date && row[key] instanceof Date && row[key].getTime() === val.getTime());
    return condMatch(row[key], val);
  });
}

function applyData(row, data) {
  for (const [key, val] of Object.entries(data || {})) {
    if (val && typeof val === 'object' && !(val instanceof Date) && !Array.isArray(val) && 'increment' in val) {
      row[key] = (row[key] || 0) + val.increment;
    } else {
      row[key] = val;
    }
  }
  return row;
}

function delegateStub(rows) {
  let seq = 0;
  return {
    findFirst: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findUnique: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findMany: async ({ where, take } = {}) => {
      const out = rows().filter((r) => matches(r, where));
      return typeof take === 'number' ? out.slice(0, take) : out;
    },
    create: async ({ data } = {}) => {
      const row = { id: `row_${++seq}`, ...data };
      rows().push(row);
      return row;
    },
    update: async ({ where, data } = {}) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error('stub update: no match');
      return applyData(row, data);
    },
    updateMany: async ({ where, data } = {}) => {
      const hits = rows().filter((r) => matches(r, where));
      hits.forEach((r) => applyData(r, data));
      return { count: hits.length };
    },
    groupBy: async () => [],
  };
}

function installStubs() {
  db = { devices: [], sessions: [], reservations: [], vehicles: [], blocks: [], checkoutSessions: [], locations: [], tenants: [] };
  db.locations.push({ id: 'loc1', tenantId: 't1', name: 'Orlando — MCO' });
  Object.assign(prisma.location, delegateStub(() => db.locations));
  // Tenant row deliberately carries sensitive-looking fields so the leak
  // assertions below prove device-facing views expose ONLY the name.
  db.tenants.push({
    id: 't1', name: 'International Rental Corp',
    settingsJson: 'SECRET-DO-NOT-LEAK', websiteTokenHash: 'hash-DO-NOT-LEAK', integrationConfig: { key: 'x' },
  });
  Object.assign(prisma.tenant, delegateStub(() => db.tenants));
  db.settings = [];
  Object.assign(prisma.appSetting, delegateStub(() => db.settings));
  prisma.appSetting.upsert = async ({ where, create, update }) => {
    const existing = db.settings.find((r) => r.key === where.key);
    if (existing) { Object.assign(existing, update); return existing; }
    const row = { ...create };
    db.settings.push(row);
    return row;
  };
  Object.assign(prisma.checkoutSession, delegateStub(() => db.checkoutSessions));
  Object.assign(prisma.kioskDevice, delegateStub(() => db.devices));
  Object.assign(prisma.kioskSession, delegateStub(() => db.sessions));
  // Real Prisma applies the schema defaults on create; the stub must too.
  const rawSessionCreate = prisma.kioskSession.create;
  prisma.kioskSession.create = ({ data } = {}) => rawSessionCreate({
    data: {
      step: 'WELCOME',
      outcome: 'IN_PROGRESS',
      reservationId: null,
      checkoutSessionId: null,
      escalatedReason: null,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      endedAt: null,
      ...data,
    },
  });
  Object.assign(prisma.reservation, delegateStub(() => db.reservations));
  Object.assign(prisma.vehicle, delegateStub(() => db.vehicles));
  Object.assign(prisma.vehicleAvailabilityBlock, delegateStub(() => db.blocks));
  // Transaction stub with rollback semantics for the reservation table (the
  // only table the assign-vehicle tx writes).
  prisma.$transaction = async (fn) => {
    const snapshot = db.reservations.map((r) => ({ ...r }));
    try {
      return await fn(prisma);
    } catch (err) {
      db.reservations = snapshot;
      throw err;
    }
  };
}

const HOUR = 60 * 60 * 1000;

function seedDevice(overrides = {}) {
  const device = {
    id: 'dev1',
    tenantId: 't1',
    locationId: 'loc1',
    name: 'Lobby 1',
    tokenHash: sha256Hex('placeholder'),
    tokenVersion: 1,
    pairingCodeHash: null,
    pairingCodeExpiresAt: null,
    pairingAttempts: 0,
    lookupMisses: 0,
    lookupLockedUntil: null,
    status: 'ACTIVE',
    walkupEnabled: true,
    lastSeenAt: new Date(),
    ...overrides,
  };
  db.devices.push(device);
  return device;
}

function deviceCtx(device) {
  return {
    id: device.id,
    tenantId: device.tenantId,
    locationId: device.locationId,
    name: device.name,
    walkupEnabled: device.walkupEnabled,
  };
}

function seedSession(overrides = {}) {
  const session = {
    id: 'ks1',
    tenantId: 't1',
    deviceId: 'dev1',
    kind: 'PICKUP',
    reservationId: null,
    checkoutSessionId: null,
    step: 'WELCOME',
    outcome: 'IN_PROGRESS',
    escalatedReason: null,
    eventsJson: [],
    lastActivityAt: new Date(Date.now() - HOUR),
    startedAt: new Date(Date.now() - HOUR),
    endedAt: null,
    ...overrides,
  };
  db.sessions.push(session);
  return session;
}

function seedReservation(overrides = {}) {
  const resv = {
    id: 'res1',
    tenantId: 't1',
    reservationNumber: 'RES-100200',
    status: 'CONFIRMED',
    workflowMode: 'RENTAL',
    bookingChannel: 'EXPEDIA',
    pickupLocationId: 'loc1',
    pickupAt: new Date(Date.now() + 2 * HOUR),
    returnAt: new Date(Date.now() + 50 * HOUR),
    vehicleId: null,
    vehicleTypeId: 'vt1',
    vehicleType: { name: 'Compact SUV' },
    customer: { firstName: 'Maria', lastName: 'Gonzalez', phone: '+1 (407) 555-1234' },
    ...overrides,
  };
  db.reservations.push(resv);
  return resv;
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function makeKioskReq(token) {
  const headers = token == null ? {} : { 'x-kiosk-token': token };
  return { get: (name) => headers[String(name).toLowerCase()] };
}

async function rejects(promise, { status, code } = {}) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof KioskError, `expected KioskError, got ${err?.name}: ${err?.message}`);
    if (status) assert.equal(err.status, status);
    if (code) assert.equal(err.code, code);
    return err;
  }
  throw new Error('expected rejection, promise resolved');
}

beforeEach(() => {
  installStubs();
  resetPairMissTracking();
  setKioskSmartMatcher(null); // default = interim runtime (no S30 lib)
});

// ---------------------------------------------------------------------------
// (a) Pairing
// ---------------------------------------------------------------------------

test('pairing happy path: consumes the code, issues token, stores only the hash', async () => {
  const device = seedDevice({
    pairingCodeHash: sha256Hex('123456'),
    pairingCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  const result = await kioskDeviceService.pairDevice({ pairingCode: '123456' });

  assert.ok(result.deviceToken.length >= 43); // 32 bytes base64url
  assert.equal(result.device.id, device.id);
  assert.equal(result.device.tenantId, 't1');
  assert.equal(device.tokenHash, sha256Hex(result.deviceToken));
  assert.equal(device.pairingCodeHash, null); // single-use: consumed
  assert.equal(device.pairingCodeExpiresAt, null);
  assert.equal(device.tokenVersion, 2);
  // the plaintext token never lands in the row
  assert.ok(!JSON.stringify(db.devices).includes(result.deviceToken));
});

test('pairing: expired code rejected 401', async () => {
  seedDevice({
    pairingCodeHash: sha256Hex('123456'),
    pairingCodeExpiresAt: new Date(Date.now() - 1000),
  });
  await rejects(kioskDeviceService.pairDevice({ pairingCode: '123456' }), { status: 401, code: 'INVALID_PAIRING_CODE' });
});

test('pairing: misses are charged to the CALLER IP — 5 misses lock that IP, other tenants/devices untouched', async () => {
  const device = seedDevice({
    pairingCodeHash: sha256Hex('123456'),
    pairingCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  const otherTenantDevice = seedDevice({
    id: 'devT2', tenantId: 't2', tokenHash: sha256Hex('t2-token'),
    pairingCodeHash: sha256Hex('654321'),
    pairingCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) {
    await rejects(kioskDeviceService.pairDevice({ pairingCode: '000000', ip: '203.0.113.9' }), { status: 401, code: 'INVALID_PAIRING_CODE' });
  }

  // no cross-device DB griefing: nobody's pairingAttempts moved
  assert.equal(device.pairingAttempts, 0);
  assert.equal(otherTenantDevice.pairingAttempts, 0);

  // the locked IP is refused even with the CORRECT code
  await rejects(kioskDeviceService.pairDevice({ pairingCode: '123456', ip: '203.0.113.9' }), { status: 429, code: 'PAIRING_LOCKED' });

  // a different IP (the legit tablet) still pairs both codes fine
  const paired = await kioskDeviceService.pairDevice({ pairingCode: '123456', ip: '198.51.100.7' });
  assert.ok(paired.deviceToken);
  const pairedT2 = await kioskDeviceService.pairDevice({ pairingCode: '654321', ip: '198.51.100.8' });
  assert.equal(pairedT2.device.tenantId, 't2');
});

test('pairing: malformed code rejected without leaking device state', async () => {
  seedDevice({
    pairingCodeHash: sha256Hex('123456'),
    pairingCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  await rejects(kioskDeviceService.pairDevice({ pairingCode: 'abc' }), { status: 401, code: 'INVALID_PAIRING_CODE' });
  await rejects(kioskDeviceService.pairDevice({}), { status: 401, code: 'INVALID_PAIRING_CODE' });
});

test('rotation: new token authenticates, old token dies', async () => {
  const device = seedDevice({ tokenHash: sha256Hex('old-token') });

  // old token works
  let res = makeRes();
  let called = false;
  await requireKioskDevice(makeKioskReq('old-token'), res, () => { called = true; });
  assert.equal(called, true);

  const { deviceToken: newToken } = await kioskDeviceService.rotateToken(device.id, { tenantId: 't1' });
  assert.equal(device.tokenVersion, 2);
  assert.ok(device.rotatedAt instanceof Date);

  // old token → 401, new token → passes
  res = makeRes();
  called = false;
  await requireKioskDevice(makeKioskReq('old-token'), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);

  res = makeRes();
  called = false;
  await requireKioskDevice(makeKioskReq(newToken), res, () => { called = true; });
  assert.equal(called, true);
});

// ---------------------------------------------------------------------------
// (b) Device auth middleware
// ---------------------------------------------------------------------------

test('requireKioskDevice: valid token attaches req.kioskDevice', async () => {
  seedDevice({ tokenHash: sha256Hex('good-token') });
  const req = makeKioskReq('good-token');
  const res = makeRes();
  let called = false;
  await requireKioskDevice(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.deepEqual(req.kioskDevice, {
    id: 'dev1', tenantId: 't1', locationId: 'loc1', name: 'Lobby 1', walkupEnabled: true,
  });
});

test('requireKioskDevice: missing / wrong / revoked → 401, next() never runs', async () => {
  seedDevice({ tokenHash: sha256Hex('good-token') });
  seedDevice({ id: 'dev2', tokenHash: sha256Hex('revoked-token'), status: 'REVOKED' });

  for (const token of [null, 'wrong-token', 'revoked-token']) {
    const res = makeRes();
    let called = false;
    await requireKioskDevice(makeKioskReq(token), res, () => { called = true; });
    assert.equal(called, false, `token ${token} should not pass`);
    assert.equal(res.statusCode, 401);
  }
});

// ---------------------------------------------------------------------------
// (c) Lookup: masked stub only + lockout
// ---------------------------------------------------------------------------

test('lookup by confirmation number returns the masked stub and nothing else', async () => {
  const device = seedDevice();
  seedSession();
  seedReservation();

  const stub = await kioskSessionService.lookupReservation('ks1', deviceCtx(device), {
    confirmationNumber: 'res-100200',
  });

  assert.deepEqual(Object.keys(stub).sort(), ['channel', 'maskedName', 'pickupWindow', 'reservationId', 'vehicleClassName']);
  assert.equal(stub.maskedName, 'Maria G.');
  assert.equal(stub.vehicleClassName, 'Compact SUV');
  assert.equal(stub.channel, 'EXPEDIA');

  const serialized = JSON.stringify(stub);
  assert.ok(!serialized.includes('Gonzalez'), 'full last name must never leave the server');
  assert.ok(!serialized.includes('4075551234') && !serialized.includes('555-1234'), 'phone must never leave the server');
  assert.ok(!/phone|email|dob|license/i.test(serialized), 'no PII keys in the stub');
});

test('lookup by lastName+phone matches server-side on normalized digits', async () => {
  const device = seedDevice();
  seedSession();
  seedReservation();

  const stub = await kioskSessionService.lookupReservation('ks1', deviceCtx(device), {
    lastName: 'gonzalez',
    phone: '407-555-1234',
  });
  assert.equal(stub.reservationId, 'res1');
});

test('lookup is scoped to the device location and pickup window', async () => {
  const device = seedDevice();
  seedSession();
  seedReservation({ id: 'resOther', reservationNumber: 'RES-OTHERLOC', pickupLocationId: 'loc2' });
  seedReservation({ id: 'resFar', reservationNumber: 'RES-NEXTWEEK', pickupAt: new Date(Date.now() + 100 * HOUR) });

  await rejects(
    kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'RES-OTHERLOC' }),
    { status: 404, code: 'RESERVATION_NOT_FOUND' },
  );
  await rejects(
    kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'RES-NEXTWEEK' }),
    { status: 404, code: 'RESERVATION_NOT_FOUND' },
  );
});

test('lookup lockout is per DEVICE: 5 misses lock it across sessions; other devices unaffected; lock expires', async () => {
  const device = seedDevice();
  const sessionA = seedSession({ id: 'ksA' });
  seedReservation();

  for (let i = 0; i < MAX_LOOKUP_MISSES; i += 1) {
    const err = await rejects(
      kioskSessionService.lookupReservation('ksA', deviceCtx(device), { confirmationNumber: 'RES-NOPE' }),
      { status: 404, code: 'RESERVATION_NOT_FOUND' },
    );
    assert.equal(err.details.attemptsRemaining, MAX_LOOKUP_MISSES - i - 1);
  }
  // telemetry stays on the session; ENFORCEMENT lives on the device
  assert.equal(sessionA.eventsJson.filter((e) => e.event === 'LOOKUP_MISS').length, MAX_LOOKUP_MISSES);
  assert.equal(device.lookupMisses, 0); // counter rearmed when the lock engaged
  assert.ok(device.lookupLockedUntil instanceof Date && device.lookupLockedUntil > new Date(), 'device locked');

  // a BRAND NEW session on the SAME device (idle-wipe) is still locked —
  // even with a VALID confirmation number
  seedSession({ id: 'ksB' });
  await rejects(
    kioskSessionService.lookupReservation('ksB', deviceCtx(device), { confirmationNumber: 'RES-100200' }),
    { status: 429, code: 'LOOKUP_LOCKED' },
  );

  // a DIFFERENT device at the same location is unaffected
  const device2 = seedDevice({ id: 'dev2', tokenHash: sha256Hex('dev2-token') });
  seedSession({ id: 'ksC', deviceId: 'dev2' });
  const stub = await kioskSessionService.lookupReservation('ksC', deviceCtx(device2), { confirmationNumber: 'RES-100200' });
  assert.equal(stub.reservationId, 'res1');

  // lock expiry: once lookupLockedUntil passes, the device works again and
  // the successful hit clears the stale lock
  device.lookupLockedUntil = new Date(Date.now() - 1000);
  const stubAfter = await kioskSessionService.lookupReservation('ksB', deviceCtx(device), { confirmationNumber: 'RES-100200' });
  assert.equal(stubAfter.reservationId, 'res1');
  assert.equal(device.lookupLockedUntil, null);
  assert.equal(device.lookupMisses, 0);
});

test('lookup: a successful hit resets the device miss counter', async () => {
  const device = seedDevice();
  seedSession();
  seedReservation();

  await rejects(kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'RES-NOPE' }), { status: 404 });
  await rejects(kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'RES-NOPE' }), { status: 404 });
  assert.equal(device.lookupMisses, 2);

  await kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'RES-100200' });
  assert.equal(device.lookupMisses, 0);
});

test('admin pairing-code reissue clears the device lookup lockout', async () => {
  const device = seedDevice({
    lookupMisses: 3,
    lookupLockedUntil: new Date(Date.now() + 10 * 60 * 1000),
    pairingAttempts: 4,
  });

  await kioskDeviceService.issuePairingCode(device.id, { tenantId: 't1' });
  assert.equal(device.lookupMisses, 0);
  assert.equal(device.lookupLockedUntil, null);
  assert.equal(device.pairingAttempts, 0);
});

test('maskCustomerName: masks to first name + last initial', () => {
  assert.equal(maskCustomerName('Maria', 'Gonzalez'), 'Maria G.');
  assert.equal(maskCustomerName('Jean-Luc', 'de la Cruz'), 'Jean-Luc D.');
  assert.equal(maskCustomerName('', ''), 'Guest');
});

// ---------------------------------------------------------------------------
// (d) Session-device binding
// ---------------------------------------------------------------------------

test('device B cannot touch device A sessions (404), same-tenant or not', async () => {
  const deviceA = seedDevice();
  const deviceB = seedDevice({ id: 'dev2', tokenHash: sha256Hex('b-token') });
  const deviceOtherTenant = seedDevice({ id: 'dev3', tenantId: 't2', tokenHash: sha256Hex('c-token') });
  seedSession({ deviceId: deviceA.id });

  await rejects(
    kioskSessionService.appendEvents('ks1', deviceCtx(deviceB), [{ step: 'LOOKUP', event: 'X' }]),
    { status: 404, code: 'SESSION_NOT_FOUND' },
  );
  await rejects(
    kioskSessionService.escalate('ks1', deviceCtx(deviceOtherTenant), { reason: 'nope' }),
    { status: 404, code: 'SESSION_NOT_FOUND' },
  );

  // the owner still can
  const result = await kioskSessionService.appendEvents('ks1', deviceCtx(deviceA), [{ step: 'LOOKUP', event: 'X' }]);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// (e) assign-vehicle race
// ---------------------------------------------------------------------------

function seedAssignScenario({ vehicles = 1 } = {}) {
  const device = seedDevice();
  seedSession({ reservationId: 'res1' });
  seedReservation();
  for (let i = 1; i <= vehicles; i += 1) {
    db.vehicles.push({
      id: `v${i}`, tenantId: 't1', status: 'AVAILABLE', vehicleTypeId: 'vt1',
      homeLocationId: 'loc1', make: 'Kia', model: 'Soul', year: 2025,
      color: 'White', plate: `KIA-00${i}`, internalNumber: `10${i}`, mileage: 1000 * i,
    });
  }
  return device;
}

test('assignVehicle: happy path claims the vehicle and opens the checkout session', async (t) => {
  const device = seedAssignScenario();
  const original = checkoutSessionService.createForReservation;
  const csCalls = [];
  checkoutSessionService.createForReservation = async (args) => { csCalls.push(args); return { id: 'cs1' }; };
  t.after(() => { checkoutSessionService.createForReservation = original; });

  const result = await kioskSessionService.assignVehicle('ks1', deviceCtx(device));

  assert.equal(result.vehicle.id, 'v1');
  assert.equal(result.vehicle.plate, 'KIA-001');
  assert.equal(result.checkoutSessionId, 'cs1');
  assert.equal(db.reservations[0].vehicleId, 'v1');
  assert.deepEqual(csCalls, [{ reservationId: 'res1', tenantId: 't1', actorUserId: null }]);
  assert.equal(db.sessions[0].checkoutSessionId, 'cs1');
});

test('assignVehicle race: two concurrent calls — one claim wins, both converge on the same unit', async (t) => {
  const device = seedAssignScenario({ vehicles: 2 });
  const original = checkoutSessionService.createForReservation;
  checkoutSessionService.createForReservation = async () => ({ id: 'cs1' });
  t.after(() => { checkoutSessionService.createForReservation = original; });

  const [a, b] = await Promise.all([
    kioskSessionService.assignVehicle('ks1', deviceCtx(device)),
    kioskSessionService.assignVehicle('ks1', deviceCtx(device)),
  ]);

  // exactly ONE vehicle ends up on the reservation; both callers agree on it
  assert.ok(db.reservations[0].vehicleId, 'reservation got a vehicle');
  assert.equal(a.vehicle.id, db.reservations[0].vehicleId);
  assert.equal(b.vehicle.id, db.reservations[0].vehicleId);
  // the second vehicle was never double-assigned anywhere
  const assigned = db.reservations.filter((r) => r.vehicleId).map((r) => r.vehicleId);
  assert.equal(new Set(assigned).size, assigned.length);
});

test('assignVehicle: conflicting candidate rolls back and falls to the next one', async (t) => {
  const device = seedAssignScenario({ vehicles: 2 });
  // v1 is out on an OPEN rental (ensureNoVehicleConflict inside the tx must
  // veto it) but its Vehicle row still says AVAILABLE — the drift case.
  seedReservation({
    id: 'resOpen', reservationNumber: 'RES-OPEN', status: 'CHECKED_OUT', vehicleId: 'v1',
    pickupAt: new Date(Date.now() - 30 * HOUR), returnAt: new Date(Date.now() - 2 * HOUR),
  });
  const original = checkoutSessionService.createForReservation;
  checkoutSessionService.createForReservation = async () => ({ id: 'cs1' });
  t.after(() => { checkoutSessionService.createForReservation = original; });

  const result = await kioskSessionService.assignVehicle('ks1', deviceCtx(device));
  assert.equal(result.vehicle.id, 'v2');
  assert.equal(db.reservations[0].vehicleId, 'v2');
});

test('assignVehicle: no available unit → 409 NO_VEHICLE_AVAILABLE (kiosk escalates)', async (t) => {
  const device = seedAssignScenario({ vehicles: 0 });
  const original = checkoutSessionService.createForReservation;
  checkoutSessionService.createForReservation = async () => { throw new Error('must not be called'); };
  t.after(() => { checkoutSessionService.createForReservation = original; });

  await rejects(kioskSessionService.assignVehicle('ks1', deviceCtx(device)), { status: 409, code: 'NO_VEHICLE_AVAILABLE' });
  assert.equal(db.reservations[0].vehicleId, null);
});

test('assignVehicle: unique-violation on checkout-session create converges on the winner session', async (t) => {
  const device = seedAssignScenario();
  // the other racer already created the checkout session for this reservation
  db.checkoutSessions.push({ id: 'csWinner', reservationId: 'res1' });
  const original = checkoutSessionService.createForReservation;
  checkoutSessionService.createForReservation = async () => {
    const err = new Error('Unique constraint failed on the fields: (`reservationId`)');
    err.code = 'P2002';
    throw err;
  };
  t.after(() => { checkoutSessionService.createForReservation = original; });

  const result = await kioskSessionService.assignVehicle('ks1', deviceCtx(device));
  assert.equal(result.checkoutSessionId, 'csWinner');
  assert.equal(db.sessions[0].checkoutSessionId, 'csWinner');
});

test('assignVehicle: pre-assigned reservation skips the pick and still opens checkout', async (t) => {
  const device = seedAssignScenario({ vehicles: 1 });
  db.reservations[0].vehicleId = 'v1';
  const original = checkoutSessionService.createForReservation;
  checkoutSessionService.createForReservation = async () => ({ id: 'cs9' });
  t.after(() => { checkoutSessionService.createForReservation = original; });

  const result = await kioskSessionService.assignVehicle('ks1', deviceCtx(device));
  assert.equal(result.vehicle.id, 'v1');
  assert.equal(result.checkoutSessionId, 'cs9');
});

// ---------------------------------------------------------------------------
// (f) Events cap + lastActivityAt
// ---------------------------------------------------------------------------

test('appendEvents: bumps lastActivityAt, mirrors the latest step', async () => {
  const device = seedDevice();
  const session = seedSession();
  const before = session.lastActivityAt.getTime();

  const result = await kioskSessionService.appendEvents('ks1', deviceCtx(device), [
    { step: 'LOOKUP', event: 'LOOKUP_SHOWN' },
    { step: 'ID', event: 'SCAN_STARTED', data: { attempt: 1 } },
  ]);

  assert.equal(result.eventCount, 2);
  assert.equal(result.dropped, 0);
  assert.equal(session.step, 'ID');
  assert.ok(session.lastActivityAt.getTime() > before, 'lastActivityAt bumped');
});

test('appendEvents: defensive cap at MAX_SESSION_EVENTS, overflow dropped', async () => {
  const device = seedDevice();
  const session = seedSession({
    eventsJson: Array.from({ length: MAX_SESSION_EVENTS - 2 }, (_, i) => ({ at: 'x', step: null, event: `E${i}`, data: null })),
  });

  const result = await kioskSessionService.appendEvents('ks1', deviceCtx(device), [
    { event: 'A' }, { event: 'B' }, { event: 'C' }, { event: 'D' },
  ]);

  assert.equal(result.eventCount, MAX_SESSION_EVENTS);
  assert.equal(result.dropped, 2);
  assert.equal(session.eventsJson.length, MAX_SESSION_EVENTS);
});

test('appendEvents: oversized event data is truncated, junk entries ignored', async () => {
  const device = seedDevice();
  const session = seedSession();

  const result = await kioskSessionService.appendEvents('ks1', deviceCtx(device), [
    { event: 'BIG', data: { blob: 'x'.repeat(5000) } },
    { notAnEvent: true },
    'garbage',
  ]);
  assert.equal(result.eventCount, 1);
  assert.deepEqual(session.eventsJson[0].data, { truncated: true });

  await rejects(
    kioskSessionService.appendEvents('ks1', deviceCtx(device), [{ noEvent: 1 }]),
    { status: 400 },
  );
});

// ---------------------------------------------------------------------------
// Session lifecycle odds and ends
// ---------------------------------------------------------------------------

test('createSession: WALKUP on a walkup-disabled device → 403', async () => {
  const device = seedDevice({ walkupEnabled: false });
  await rejects(
    kioskSessionService.createSession({ kind: 'WALKUP' }, deviceCtx(device)),
    { status: 403, code: 'WALKUP_DISABLED' },
  );
  const session = await kioskSessionService.createSession({ kind: 'PICKUP' }, deviceCtx(device));
  assert.equal(session.kind, 'PICKUP');
  assert.equal(session.outcome, 'IN_PROGRESS');
});

test('escalate: stamps outcome + reason + endedAt; terminal sessions refuse further work', async () => {
  const device = seedDevice();
  const session = seedSession();

  // B3 rider: reason is a closed enum — free text from a lobby tablet is 422.
  await rejects(
    kioskSessionService.escalate('ks1', deviceCtx(device), { reason: 'id scan failed 3 times' }),
    { status: 422, code: 'INVALID_ESCALATE_REASON' },
  );
  await rejects(
    kioskSessionService.escalate('ks1', deviceCtx(device), {}),
    { status: 422, code: 'INVALID_ESCALATE_REASON' },
  );
  assert.equal(session.outcome, 'IN_PROGRESS', 'invalid reason must not escalate');

  const result = await kioskSessionService.escalate('ks1', deviceCtx(device), { reason: 'id_scan_failed' });
  assert.equal(result.session.outcome, 'ESCALATED');
  assert.equal(session.escalatedReason, 'ID_SCAN_FAILED');
  assert.ok(session.endedAt instanceof Date);

  await rejects(
    kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'RES-100200' }),
    { status: 409, code: 'SESSION_NOT_IN_PROGRESS' },
  );
});

test('attachReservation: validates eligibility server-side and returns the masked summary', async () => {
  const device = seedDevice();
  const session = seedSession();
  seedReservation();
  seedReservation({ id: 'resCancelled', reservationNumber: 'RES-CXL', status: 'CANCELLED' });

  await rejects(
    kioskSessionService.attachReservation('ks1', deviceCtx(device), { reservationId: 'resCancelled' }),
    { status: 404, code: 'RESERVATION_NOT_FOUND' },
  );

  const summary = await kioskSessionService.attachReservation('ks1', deviceCtx(device), { reservationId: 'res1' });
  assert.equal(summary.maskedName, 'Maria G.');
  assert.equal(summary.bookingChannel, 'EXPEDIA');
  assert.equal(summary.vehicleAssigned, false);
  assert.equal(session.reservationId, 'res1');
  assert.ok(!/Gonzalez|555/.test(JSON.stringify(summary)));

  await rejects(
    kioskSessionService.attachReservation('ks1', deviceCtx(device), { reservationId: 'resCancelled' }),
    { status: 409, code: 'RESERVATION_ALREADY_ATTACHED' },
  );
});

// ---------------------------------------------------------------------------
// B3b backend gaps: pair location join, GET /device, PATCH /devices/:id
// ---------------------------------------------------------------------------

test('pairing response includes location {id, name} + tenant {name} for the kiosk header — and nothing else from Tenant', async () => {
  seedDevice({
    pairingCodeHash: sha256Hex('123456'),
    pairingCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  const result = await kioskDeviceService.pairDevice({ pairingCode: '123456', ip: '10.0.0.1' });
  assert.deepEqual(result.device.location, { id: 'loc1', name: 'Orlando — MCO' });
  assert.deepEqual(result.device.tenant, { name: 'International Rental Corp' });

  // NOTHING else from the Tenant row reaches a lobby device
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('settingsJson'), 'no settingsJson leak');
  assert.ok(!serialized.includes('DO-NOT-LEAK'), 'no tenant secrets leak');
  assert.ok(!serialized.includes('websiteTokenHash') && !serialized.includes('integrationConfig'));
});

test('getOwnDevice: a paired kiosk refreshes its own view + location + tenant name without re-pairing', async () => {
  const device = seedDevice({ name: 'Kiosk 1', walkupEnabled: false });

  const result = await kioskDeviceService.getOwnDevice(deviceCtx(device));
  assert.equal(result.device.id, 'dev1');
  assert.equal(result.device.name, 'Kiosk 1');
  assert.equal(result.device.walkupEnabled, false);
  assert.ok(['ONLINE', 'OFFLINE'].includes(result.device.connectivity));
  assert.deepEqual(result.device.location, { id: 'loc1', name: 'Orlando — MCO' });
  assert.deepEqual(result.device.tenant, { name: 'International Rental Corp' });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('settingsJson') && !serialized.includes('DO-NOT-LEAK'), 'tenant row never leaks past name');

  // a device ctx from another tenant can never read it
  await rejects(
    kioskDeviceService.getOwnDevice({ ...deviceCtx(device), tenantId: 't2' }),
    { status: 404, code: 'DEVICE_NOT_FOUND' },
  );
});

test('updateDevice: walk-up toggle + rename round-trip; cross-tenant 404; invalid body 422', async () => {
  const device = seedDevice({ walkupEnabled: true });

  // toggle round-trip
  let view = await kioskDeviceService.updateDevice('dev1', { walkupEnabled: false }, { tenantId: 't1' });
  assert.equal(view.walkupEnabled, false);
  assert.equal(device.walkupEnabled, false);
  view = await kioskDeviceService.updateDevice('dev1', { walkupEnabled: true, name: 'Kiosk Lobby A' }, { tenantId: 't1' });
  assert.equal(view.walkupEnabled, true);
  assert.equal(view.name, 'Kiosk Lobby A');
  assert.ok('connectivity' in view, 'updated view carries derived connectivity');

  // cross-tenant → 404 (never leaks existence)
  await rejects(
    kioskDeviceService.updateDevice('dev1', { walkupEnabled: false }, { tenantId: 't2' }),
    { status: 404, code: 'DEVICE_NOT_FOUND' },
  );
  assert.equal(device.walkupEnabled, true, 'cross-tenant patch never applied');

  // invalid bodies → 422, nothing changes
  await rejects(kioskDeviceService.updateDevice('dev1', { walkupEnabled: 'yes' }, { tenantId: 't1' }), { status: 422, code: 'INVALID_DEVICE_PATCH' });
  await rejects(kioskDeviceService.updateDevice('dev1', { name: '' }, { tenantId: 't1' }), { status: 422, code: 'INVALID_DEVICE_PATCH' });
  await rejects(kioskDeviceService.updateDevice('dev1', { name: 'x'.repeat(81) }, { tenantId: 't1' }), { status: 422, code: 'INVALID_DEVICE_PATCH' });
  await rejects(kioskDeviceService.updateDevice('dev1', {}, { tenantId: 't1' }), { status: 422, code: 'INVALID_DEVICE_PATCH' });
  assert.equal(device.name, 'Kiosk Lobby A');
});

// ---------------------------------------------------------------------------
// B3f: VozIA "Get Help" embed config
// ---------------------------------------------------------------------------

test('vozia-config: validation 422s, https-only, trailing slash stripped, round-trip + clear', async () => {
  // invalid hosts → 422, nothing stored
  for (const host of ['http://vozia.example.com', 'not-a-url', '', undefined,
    // R2: origin only — subpath-mounted hosts misconfigure the frontend's new URL(host).origin
    'https://vozia.example.com/some/path', 'https://vozia.example.com/chat', 'https://vozia.example.com/?q=1']) {
    await rejects(
      kioskDeviceService.updateVoziaSettings({ host, widgetKey: 'k1' }, { tenantId: 't1' }),
      { status: 422, code: 'INVALID_VOZIA_HOST' },
    );
  }
  assert.equal(db.settings.length, 0);

  // valid save: https enforced, trailing slash stripped, key stored
  const saved = await kioskDeviceService.updateVoziaSettings(
    { host: 'https://vozia.example.com/', widgetKey: ' kiosk-widget-123 ' },
    { tenantId: 't1' },
  );
  assert.deepEqual(saved.config, { host: 'https://vozia.example.com', widgetKey: 'kiosk-widget-123' });

  const read = await kioskDeviceService.getVoziaSettings({ tenantId: 't1' });
  assert.deepEqual(read.config, saved.config, 'admins read the full config back');

  // port is fine (origin-only rule rejects paths, not ports)
  const withPort = await kioskDeviceService.updateVoziaSettings({ host: 'https://vozia.example.com:8443' }, { tenantId: 't1' });
  assert.equal(withPort.config.host, 'https://vozia.example.com:8443');

  // widgetKey optional (rate-limit budget only, per KIOSK-EMBED.md)
  const noKey = await kioskDeviceService.updateVoziaSettings({ host: 'https://vozia.example.com' }, { tenantId: 't1' });
  assert.deepEqual(noKey.config, { host: 'https://vozia.example.com', widgetKey: null });

  // { host: null } clears
  const cleared = await kioskDeviceService.updateVoziaSettings({ host: null }, { tenantId: 't1' });
  assert.equal(cleared.config, null);
  assert.equal((await kioskDeviceService.getVoziaSettings({ tenantId: 't1' })).config, null);
});

test('device views carry vozia when configured, null when absent — and nothing else leaks', async () => {
  const device = seedDevice({
    pairingCodeHash: sha256Hex('123456'),
    pairingCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  // unconfigured → null (frontend goes dark/fail-soft)
  let own = await kioskDeviceService.getOwnDevice(deviceCtx(device));
  assert.equal(own.device.vozia, null);

  await kioskDeviceService.updateVoziaSettings(
    { host: 'https://vozia.example.com', widgetKey: 'kiosk-widget-123' },
    { tenantId: 't1' },
  );

  const paired = await kioskDeviceService.pairDevice({ pairingCode: '123456', ip: '10.0.0.9' });
  assert.deepEqual(paired.device.vozia, { host: 'https://vozia.example.com', widgetKey: 'kiosk-widget-123' });

  own = await kioskDeviceService.getOwnDevice(deviceCtx(device));
  assert.deepEqual(own.device.vozia, { host: 'https://vozia.example.com', widgetKey: 'kiosk-widget-123' });

  // exactly {host, widgetKey} — nothing else from the setting row or tenant
  assert.deepEqual(Object.keys(own.device.vozia).sort(), ['host', 'widgetKey']);
  const serialized = JSON.stringify(own);
  assert.ok(!serialized.includes('voziaKioskConfig') && !serialized.includes('DO-NOT-LEAK'));

  // a corrupted/legacy setting value fails soft to null
  db.settings.length = 0;
  db.settings.push({ key: 'tenant:t1:voziaKioskConfig', value: '{not json' });
  own = await kioskDeviceService.getOwnDevice(deviceCtx(device));
  assert.equal(own.device.vozia, null);
});

test('vozia-config PUT is wired behind requireRole(ADMIN, SUPER_ADMIN); GET stays module-gated only', async () => {
  const { kioskAdminRouter } = await import('./kiosk-admin.routes.js');
  const findRoute = (method) => kioskAdminRouter.stack.find(
    (layer) => layer.route?.path === '/vozia-config' && layer.route.methods[method],
  )?.route;

  const putRoute = findRoute('put');
  const getRoute = findRoute('get');
  assert.ok(putRoute && getRoute, 'both routes exist');
  assert.equal(putRoute.stack.length, 2, 'PUT carries the role gate + handler');
  assert.equal(getRoute.stack.length, 1, 'GET has no extra role gate');

  // exercise the WIRED middleware: OPS → 403, ADMIN → next()
  const roleGate = putRoute.stack[0].handle;
  const makeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };

  let res = makeRes();
  let nextCalled = false;
  roleGate({ user: { role: 'OPS', tenantId: 't1' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'OPS blocked');
  assert.equal(res.statusCode, 403);

  res = makeRes();
  nextCalled = false;
  roleGate({ user: { role: 'ADMIN', tenantId: 't1' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'ADMIN passes');

  res = makeRes();
  nextCalled = false;
  roleGate({ user: { role: 'SUPER_ADMIN' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'SUPER_ADMIN passes');
});

// ---------------------------------------------------------------------------
// B3g: smart confirmation lookup (matcher = S30 lib, mocked here)
// ---------------------------------------------------------------------------

// A contract-shaped MOCK of smartMatchReservation (NOT shipped logic — this
// is the S30/VozIA lib's future output, faked so the kiosk's variant/rescope
// branches are exercisable before the real lib lands). It returns ranked
// [{ reservation:{id}, matchType, confidence }] for a set of code variants.
function mockMatcher(variantMap) {
  return async ({ code }) => {
    const ids = variantMap[String(code || '').toUpperCase()] || [];
    return ids.map((id, i) => ({ reservation: { id }, matchType: 'variant', confidence: 90 - i }));
  };
}

test('B3g interim (no lib): exact code + name+phone still work; variant is dark (no fork)', async () => {
  const device = seedDevice();
  seedSession();
  seedReservation({ reservationNumber: 'TL-ZE40809640BA' });

  // exact still works
  const exact = await kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'TL-ZE40809640BA' });
  assert.equal(exact.reservationId, 'res1');

  // name+phone still works
  const byName = await kioskSessionService.lookupReservation('ks1', deviceCtx(device), { lastName: 'gonzalez', phone: '407-555-1234' });
  assert.equal(byName.reservationId, 'res1');

  // the OTA form (no TL- prefix) is a MISS in interim — no variant generation
  await rejects(
    kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'ZE40809640BA' }),
    { status: 404, code: 'RESERVATION_NOT_FOUND' },
  );
});

test('B3g variant: a wired matcher resolves the OTA form → single masked stub, matchType telemetry', async (t) => {
  const device = seedDevice();
  const session = seedSession();
  seedReservation({ reservationNumber: 'TL-ZE40809640BA' });
  // OTA gives "ZE40809640BA"; the lib maps it to the imported reservation id.
  setKioskSmartMatcher(mockMatcher({ ZE40809640BA: ['res1'] }));
  t.after(() => setKioskSmartMatcher(null));

  const stub = await kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'ZE40809640BA' });

  // masked stub ONLY — identical to today's exact shape
  assert.deepEqual(Object.keys(stub).sort(), ['channel', 'maskedName', 'pickupWindow', 'reservationId', 'vehicleClassName']);
  assert.equal(stub.reservationId, 'res1');
  assert.equal(stub.maskedName, 'Maria G.');
  // NO full confirmation number / phone / email / vehicle pre-verify
  const s = JSON.stringify(stub);
  assert.ok(!/ZE40809640BA|Gonzalez|555|KIA|plate/i.test(s), 'non-exact match stays fully masked');

  // matchType telemetry recorded (no PII)
  const ev = session.eventsJson.find((e) => e.event === 'LOOKUP_RESULT');
  assert.deepEqual(ev.data, { matchType: 'variant', candidateCount: 1 });
});

test('B3g variant re-scoping: matcher candidates outside the kiosk window/location are dropped', async (t) => {
  const device = seedDevice();
  seedSession();
  seedReservation({ id: 'resFar', reservationNumber: 'X1', pickupAt: new Date(Date.now() + 100 * HOUR) });
  seedReservation({ id: 'resOther', reservationNumber: 'X2', pickupLocationId: 'loc2' });
  // the matcher (which doesn't know the kiosk's window/location) returns both;
  // the kiosk re-fetches through its own scoping and both fall out → miss.
  setKioskSmartMatcher(mockMatcher({ ANYCODE: ['resFar', 'resOther'] }));
  t.after(() => setKioskSmartMatcher(null));

  await rejects(
    kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'ANYCODE' }),
    { status: 404, code: 'RESERVATION_NOT_FOUND' },
  );
});

test('B3g disambiguation: multiple candidates → NEEDS_MORE_INFO, never a list of reservations', async (t) => {
  const device = seedDevice();
  const session = seedSession();
  seedReservation({ id: 'resA', reservationNumber: 'CODEA', customer: { firstName: 'Juan', lastName: 'Perez', phone: '111' } });
  seedReservation({ id: 'resB', reservationNumber: 'CODEB', customer: { firstName: 'Jose', lastName: 'Perez', phone: '222' } });

  // (a) code/variant match with two candidates and no name → ask lastName
  setKioskSmartMatcher(mockMatcher({ DUP: ['resA', 'resB'] }));
  t.after(() => setKioskSmartMatcher(null));
  const byCode = await kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'DUP' });
  assert.deepEqual(byCode, { status: 'NEEDS_MORE_INFO', needs: 'lastName' });

  // (b) name match with two Perez and no date → ask pickupDate; no leak
  const byName = await kioskSessionService.lookupReservation('ks1', deviceCtx(device), { lastName: 'Perez' });
  assert.deepEqual(byName, { status: 'NEEDS_MORE_INFO', needs: 'pickupDate' });
  const serialized = JSON.stringify(byName);
  assert.ok(!/resA|resB|CODEA|CODEB|Juan|Jose|111|222/.test(serialized), 'no reservation list leaked in disambiguation');

  // ambiguity is NOT a miss — the device lockout counter is untouched
  assert.equal(device.lookupMisses, 0);
});

// The frontend's Today/Tomorrow buttons send pickupDate as the LOCATION-local
// (PR) wall-clock day — mirror that here (seeded loc1 has no tz config → PR).
const prDayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }).format(d);

test('B3g name+pickupDate: disambiguates to a single masked stub (interim, no lib needed)', async () => {
  const device = seedDevice();
  seedSession();
  const day1 = new Date(Date.now() + 3 * HOUR);
  const day2 = new Date(Date.now() + 27 * HOUR);
  seedReservation({ id: 'resA', reservationNumber: 'CODEA', pickupAt: day1, customer: { firstName: 'Juan', lastName: 'Perez', phone: '111' } });
  seedReservation({ id: 'resB', reservationNumber: 'CODEB', pickupAt: day2, customer: { firstName: 'Jose', lastName: 'Perez', phone: '222' } });

  const stub = await kioskSessionService.lookupReservation('ks1', deviceCtx(device), {
    lastName: 'Perez',
    pickupDate: prDayKey(day2), // location-local day, as the frontend sends
  });
  assert.equal(stub.reservationId, 'resB');
  assert.equal(stub.maskedName, 'Jose P.');
});

test('B3g samePickupDay compares in the LOCATION timezone, not UTC (PR AST edge)', () => {
  const tz = 'America/Puerto_Rico';
  // 2026-07-20 02:00 UTC = 2026-07-19 22:00 AST → the guest tapping "Today"
  // (2026-07-19 local) must still match, even though the UTC date is the 20th.
  const pickupAt = new Date('2026-07-20T02:00:00Z');
  assert.equal(samePickupDay(pickupAt, '2026-07-19', tz), true, 'matches the PR local day');
  assert.equal(samePickupDay(pickupAt, '2026-07-20', tz), false, 'does NOT match the UTC day');
  // a normal midday pickup still matches its own local date
  const midday = new Date('2026-07-19T16:00:00Z'); // 12:00 AST
  assert.equal(samePickupDay(midday, '2026-07-19', tz), true);
});

test('B3g anti-enum: NAME lookups feed the SAME per-device lockout (5 → 429)', async () => {
  const device = seedDevice();
  seedSession();

  for (let i = 0; i < MAX_LOOKUP_MISSES; i += 1) {
    const err = await rejects(
      kioskSessionService.lookupReservation('ks1', deviceCtx(device), { lastName: `Ghost${i}`, phone: '000' }),
      { status: 404, code: 'RESERVATION_NOT_FOUND' },
    );
    assert.equal(err.details.attemptsRemaining, MAX_LOOKUP_MISSES - i - 1);
  }
  assert.ok(device.lookupLockedUntil instanceof Date && device.lookupLockedUntil > new Date(), 'name misses lock the device');

  // and the lock blocks the next lookup regardless of type
  await rejects(
    kioskSessionService.lookupReservation('ks1', deviceCtx(device), { lastName: 'Real', pickupDate: '2030-01-01' }),
    { status: 429, code: 'LOOKUP_LOCKED' },
  );
});

test('B3g: fail matchType telemetry on a miss', async () => {
  const device = seedDevice();
  const session = seedSession();
  await rejects(
    kioskSessionService.lookupReservation('ks1', deviceCtx(device), { confirmationNumber: 'NOPE' }),
    { status: 404 },
  );
  const ev = session.eventsJson.find((e) => e.event === 'LOOKUP_RESULT');
  assert.deepEqual(ev.data, { matchType: 'fail', candidateCount: 0 });
});

// ---------------------------------------------------------------------------
// F1 Kiosk ↔ Valet remote assist (2026-09-03): binding + assist-view
// ---------------------------------------------------------------------------

test('F1 bind: sets, is idempotent, clears on null/"", device-scoped 404, validation 422', async () => {
  const device = seedDevice();
  const session = seedSession();

  const bound = await kioskSessionService.bindVoziaConversation('ks1', deviceCtx(device), { conversationId: ' conv_ABC-123 ' });
  assert.deepEqual(bound, { ok: true, sessionId: 'ks1', bound: true });
  assert.equal(session.voziaConversationId, 'conv_ABC-123', 'trimmed id persisted');
  const stamp = session.lastActivityAt;

  // idempotent: same id → no write (lastActivityAt untouched)
  await kioskSessionService.bindVoziaConversation('ks1', deviceCtx(device), { conversationId: 'conv_ABC-123' });
  assert.equal(session.lastActivityAt, stamp);

  // validation: free text / too long / path-ish → 422, binding untouched
  for (const bad of ['juan perez', 'a'.repeat(65), 'conv/../x', 'conv?x=1', 'conv.id', { id: 1 }]) {
    await rejects(
      kioskSessionService.bindVoziaConversation('ks1', deviceCtx(device), { conversationId: bad }),
      { status: 422, code: 'INVALID_CONVERSATION_ID' },
    );
  }
  assert.equal(session.voziaConversationId, 'conv_ABC-123');

  // clear on null and on ''
  let cleared = await kioskSessionService.bindVoziaConversation('ks1', deviceCtx(device), { conversationId: null });
  assert.deepEqual(cleared, { ok: true, sessionId: 'ks1', bound: false });
  assert.equal(session.voziaConversationId, null);
  await kioskSessionService.bindVoziaConversation('ks1', deviceCtx(device), { conversationId: 'conv2' });
  cleared = await kioskSessionService.bindVoziaConversation('ks1', deviceCtx(device), { conversationId: '' });
  assert.equal(cleared.bound, false);
  assert.equal(session.voziaConversationId, null);
  await kioskSessionService.bindVoziaConversation('ks1', deviceCtx(device), {});
  assert.equal(session.voziaConversationId, null);

  // never the secret: the payload's other fields are ignored entirely
  await kioskSessionService.bindVoziaConversation('ks1', deviceCtx(device), { conversationId: 'conv3', secret: 's3cret' });
  assert.ok(!JSON.stringify(session).includes('s3cret'));

  // device binding: another device (even same tenant) → 404
  const other = seedDevice({ id: 'dev2', tokenHash: sha256Hex('other') });
  await rejects(
    kioskSessionService.bindVoziaConversation('ks1', deviceCtx(other), { conversationId: 'conv9' }),
    { status: 404, code: 'SESSION_NOT_FOUND' },
  );
  assert.equal(session.voziaConversationId, 'conv3');
});

test('F1 bind: an ESCALATED session can still be bound (guest opens Get Help after escalating)', async () => {
  const device = seedDevice();
  const session = seedSession({ outcome: 'ESCALATED', escalatedReason: 'ID_SCAN_FAILED', endedAt: new Date() });
  const out = await kioskSessionService.bindVoziaConversation('ks1', deviceCtx(device), { conversationId: 'conv-esc' });
  assert.equal(out.bound, true);
  assert.equal(session.voziaConversationId, 'conv-esc');
});

// ── F3 prep: the binding becomes WRITE authority, so it needs an age and a limit ──
//
// F1 only READ through this binding. F3 writes through it — a remote agent types
// a guest's licence into THIS session — so a binding that outlives the guest is a
// standing permit over whoever sits down next. These pin the two locks.

test('F3 lock: a binding with no timestamp is DEAD — pre-migration rows fail closed', async () => {
  seedDevice();
  // Exactly the shape every row had before the TTL column existed.
  seedSession({ voziaConversationId: 'conv-1' });
  await assert.rejects(
    () => kioskSessionService.assistView({ tenantId: 't1' }, 'ks1', { conversationId: 'conv-1' }),
    (e) => e.status === 404 && e.code === 'SESSION_NOT_FOUND',
    'an unstamped binding must not resolve — a permit of unknown age is not a permit',
  );
});

test('F3 lock: a binding older than the TTL is DEAD, and says nothing about why', async () => {
  seedDevice();
  const stale = new Date(Date.now() - (VOZIA_BINDING_TTL_MIN + 1) * 60 * 1000);
  seedSession({ voziaConversationId: 'conv-1', voziaBoundAt: stale });
  await assert.rejects(
    () => kioskSessionService.assistView({ tenantId: 't1' }, 'ks1', { conversationId: 'conv-1' }),
    (e) => e.status === 404 && e.code === 'SESSION_NOT_FOUND',
    'expired must be indistinguishable from never-existed',
  );
  // One minute inside the window still resolves, so the TTL is a window and not an off-by-one.
  const fresh = new Date(Date.now() - (VOZIA_BINDING_TTL_MIN - 1) * 60 * 1000);
  seedSession({ id: 'ks9', voziaConversationId: 'conv-9', voziaBoundAt: fresh });
  const ok = await kioskSessionService.assistView({ tenantId: 't1' }, 'ks9', { conversationId: 'conv-9' });
  assert.equal(ok.outcome, 'IN_PROGRESS');
});

test('F3 lock: a FINISHED session cannot be bound, but an ESCALATED one can', async () => {
  const device = seedDevice();
  seedSession({ id: 'done1', outcome: 'COMPLETED' });
  await assert.rejects(
    () => kioskSessionService.bindVoziaConversation('done1', device, { conversationId: 'conv-x' }),
    (e) => e.status === 409 && e.code === 'SESSION_NOT_BINDABLE',
    "a finished guest's session must not be attachable to a new conversation",
  );
  seedSession({ id: 'aband1', outcome: 'ABANDONED' });
  await assert.rejects(
    () => kioskSessionService.bindVoziaConversation('aband1', device, { conversationId: 'conv-x' }),
    (e) => e.status === 409,
  );
  // ESCALATED is the whole point of the feature: the guest just said "I am stuck".
  seedSession({ id: 'esc1', outcome: 'ESCALATED' });
  const bound = await kioskSessionService.bindVoziaConversation('esc1', device, { conversationId: 'conv-esc2' });
  assert.equal(bound.bound, true, 'escalating IS asking for help — it must stay bindable');
});

test('F3 lock: UNBINDING is legal at every outcome, and stamps the age away', async () => {
  const device = seedDevice();
  // Releasing a permit must never be blocked by the state that makes release necessary.
  for (const outcome of ['IN_PROGRESS', 'ESCALATED', 'COMPLETED', 'ABANDONED']) {
    const id = `u-${outcome}`;
    seedSession({ id, outcome, voziaConversationId: 'conv-old', voziaBoundAt: new Date() });
    const out = await kioskSessionService.bindVoziaConversation(id, device, { conversationId: null });
    assert.equal(out.bound, false, `${outcome} must still be releasable`);
    const row = db.sessions.find((r) => r.id === id);
    assert.equal(row.voziaConversationId, null);
    assert.equal(row.voziaBoundAt, null, 'the age must go with the binding, or a re-bind inherits it');
  }
});

test('F1 assist-view: 404 (one indistinguishable error) for wrong tenant / wrong conversationId / unbound; 400 without conversationId or scope', async () => {
  seedDevice();
  seedSession({ voziaConversationId: 'conv-1', voziaBoundAt: new Date() });
  const unbound = seedSession({ id: 'ks2' });

  // happy path resolves (shape asserted in the next test)
  const ok = await kioskSessionService.assistView({ tenantId: 't1' }, 'ks1', { conversationId: 'conv-1' });
  assert.equal(ok.outcome, 'IN_PROGRESS');

  await rejects(kioskSessionService.assistView({ tenantId: 't2' }, 'ks1', { conversationId: 'conv-1' }), { status: 404, code: 'SESSION_NOT_FOUND' });
  await rejects(kioskSessionService.assistView({ tenantId: 't1' }, 'ks1', { conversationId: 'conv-2' }), { status: 404, code: 'SESSION_NOT_FOUND' });
  await rejects(kioskSessionService.assistView({ tenantId: 't1' }, 'ks2', { conversationId: 'conv-1' }), { status: 404, code: 'SESSION_NOT_FOUND' });
  await rejects(kioskSessionService.assistView({ tenantId: 't1' }, 'nope', { conversationId: 'conv-1' }), { status: 404, code: 'SESSION_NOT_FOUND' });
  assert.equal(unbound.voziaConversationId, undefined, 'read path never writes a binding');

  // an unbound row must not match an "empty" conversationId either (400, not a hit)
  await rejects(kioskSessionService.assistView({ tenantId: 't1' }, 'ks2', { conversationId: '' }), { status: 400, code: 'CONVERSATION_ID_REQUIRED' });
  await rejects(kioskSessionService.assistView({ tenantId: 't1' }, 'ks2', {}), { status: 400, code: 'CONVERSATION_ID_REQUIRED' });
  await rejects(kioskSessionService.assistView({ tenantId: 't1' }, 'ks1', { conversationId: 'not valid!' }), { status: 400, code: 'CONVERSATION_ID_REQUIRED' });
  // super-admin without ?tenantId → fail closed
  await rejects(kioskSessionService.assistView({}, 'ks1', { conversationId: 'conv-1' }), { status: 400, code: 'TENANT_SCOPE_REQUIRED' });
});

test('F1 assist-view: truth comes from SERVER columns, never from eventsJson; exact response shape', async () => {
  seedDevice();
  // Client-fed telemetry CLAIMS everything passed — none of it is server truth.
  const forged = [
    { at: '2026-09-03T14:00:00.000Z', step: 'ID', event: 'VERIFY_ID_PASSED', data: null },
    { at: '2026-09-03T14:00:01.000Z', step: 'ID', event: 'ID_PHOTOS_STORED', data: { storage: true, refs: [{ path: 'kiosk-id/ks1/license.jpg' }] } },
    { at: '2026-09-03T14:00:02.000Z', step: 'PAYMENT', event: 'SANDBOX_PAYMENT_STAMPED', data: null },
  ];
  seedSession({
    voziaConversationId: 'conv-1', voziaBoundAt: new Date(), step: 'PAYMENT', eventsJson: forged,
    reservationId: 'res1', checkoutSessionId: 'cs1',
    idVerifiedAt: null, idVerifyMethod: null, idPhotosStoredAt: null, paymentIntentState: null,
  });
  seedReservation({ vehicleId: null });
  db.checkoutSessions.push({ id: 'cs1', tenantId: 't1', reservationId: 'res1', currentStep: 'PAYMENT_PENDING' });

  let view = await kioskSessionService.assistView({ tenantId: 't1' }, 'ks1', { conversationId: 'conv-1' });
  assert.deepEqual(Object.keys(view), ['outcome', 'step', 'truth', 'timeline']);
  assert.deepEqual(view.truth, {
    idVerified: false, idVerifyMethod: null, vehicleAssigned: false,
    checkoutStep: 'PAYMENT_PENDING', paymentIntentState: null, idPhotosStored: false,
  });
  assert.equal(view.step, 'PAYMENT');
  assert.equal(view.timeline.length, 3, 'the forged events still show as telemetry…');
  assert.ok(!JSON.stringify(view).includes('kiosk-id/ks1'), '…but their data never leaves');

  // Now the SERVER stamps the columns → truth flips, events unchanged.
  Object.assign(db.sessions[0], {
    idVerifiedAt: new Date(), idVerifyMethod: 'STAFF_OVERRIDE', idPhotosStoredAt: new Date(), paymentIntentState: 'PAID',
  });
  db.reservations[0].vehicleId = 'veh1';
  db.checkoutSessions[0].currentStep = 'CLOSED';
  view = await kioskSessionService.assistView({ tenantId: 't1' }, 'ks1', { conversationId: 'conv-1' });
  assert.deepEqual(view.truth, {
    idVerified: true, idVerifyMethod: 'STAFF_OVERRIDE', vehicleAssigned: true,
    checkoutStep: 'CLOSED', paymentIntentState: 'PAID', idPhotosStored: true,
  });

  // No reservation / no checkout session yet → false / null, never a throw.
  seedSession({ id: 'ks3', voziaConversationId: 'conv-3', voziaBoundAt: new Date(), step: 'LOOKUP' });
  view = await kioskSessionService.assistView({ tenantId: 't1' }, 'ks3', { conversationId: 'conv-3' });
  assert.deepEqual(view.truth, {
    idVerified: false, idVerifyMethod: null, vehicleAssigned: false,
    checkoutStep: null, paymentIntentState: null, idPhotosStored: false,
  });
  assert.deepEqual(view.timeline, []);

  // A cross-tenant checkout-session / reservation id is not read (scoped lookups).
  seedSession({ id: 'ks4', voziaConversationId: 'conv-4', voziaBoundAt: new Date(), reservationId: 'resX', checkoutSessionId: 'csX' });
  db.reservations.push({ id: 'resX', tenantId: 't2', vehicleId: 'vehX' });
  db.checkoutSessions.push({ id: 'csX', tenantId: 't2', currentStep: 'CLOSED' });
  view = await kioskSessionService.assistView({ tenantId: 't1' }, 'ks4', { conversationId: 'conv-4' });
  assert.equal(view.truth.vehicleAssigned, false);
  assert.equal(view.truth.checkoutStep, null);
});

test('F1 timeline projection: enum-only names, step whitelist, code from reason/reasons[0], data never leaks, collapsing, cap', () => {
  const events = [
    { at: '2026-09-03T14:00:00.000Z', step: 'LOOKUP', event: 'STEP', data: null },
    { at: '2026-09-03T14:00:05.000Z', step: 'LOOKUP', event: 'LOOKUP_RESULT', data: { matchType: 'exact', candidateCount: 1 } },
    // consecutive duplicates → count (first `at` kept)
    { at: '2026-09-03T14:01:00.000Z', step: 'ID', event: 'VERIFY_ID_FAILED', data: { reasons: ['NAME_MISMATCH'], agreementNumber: 'RA-778899' } },
    { at: '2026-09-03T14:01:30.000Z', step: 'ID', event: 'VERIFY_ID_FAILED', data: { reasons: ['NAME_MISMATCH'] } },
    // same event, different code → separate entry
    { at: '2026-09-03T14:02:00.000Z', step: 'ID', event: 'VERIFY_ID_FAILED', data: { reasons: ['LICENSE_EXPIRED'] } },
    // free-text event name → DROPPED (not normalized)
    { at: '2026-09-03T14:02:10.000Z', step: 'ID', event: 'juan perez 787-555-0100', data: null },
    { at: '2026-09-03T14:02:11.000Z', step: 'ID', event: 'lowercase_event', data: null },
    // unknown / client-invented step → null; code from data.reason (F0 refusal)
    { at: '2026-09-03T14:03:00.000Z', step: 'WHATEVER', event: 'VOZIA_COMMAND_REFUSED', data: { command: 'flow_completed', reason: 'CHECKOUT_NOT_CLOSED' } },
    // data.code free text → no code; data.reason free text → no code
    { at: '2026-09-03T14:03:10.000Z', step: null, event: 'ESCALATED', data: { code: 'see staff at desk 3', reason: 'customer said no' } },
    // junk entries ignored
    null, 'garbage', { data: { x: 1 } }, { event: 42 },
    // bad timestamp → DROPPED (SHOULD-2: we never ship an entry we cannot order)
    { at: 'not-a-date', step: 'DONE', event: 'SESSION_WIPED', data: null },
    { at: '2026-09-03T14:04:00.000Z', step: 'DONE', event: 'SESSION_WIPED', data: null },
  ];
  const timeline = projectAssistTimeline(events);
  assert.deepEqual(timeline, [
    { at: '2026-09-03T14:00:00.000Z', step: 'LOOKUP', event: 'STEP', count: 1, code: null },
    { at: '2026-09-03T14:00:05.000Z', step: 'LOOKUP', event: 'LOOKUP_RESULT', count: 1, code: null },
    { at: '2026-09-03T14:01:00.000Z', step: 'ID', event: 'VERIFY_ID_FAILED', count: 2, code: 'NAME_MISMATCH' },
    { at: '2026-09-03T14:02:00.000Z', step: 'ID', event: 'VERIFY_ID_FAILED', count: 1, code: 'LICENSE_EXPIRED' },
    { at: '2026-09-03T14:03:00.000Z', step: null, event: 'VOZIA_COMMAND_REFUSED', count: 1, code: 'CHECKOUT_NOT_CLOSED' },
    { at: '2026-09-03T14:03:10.000Z', step: null, event: 'ESCALATED', count: 1, code: null },
    { at: '2026-09-03T14:04:00.000Z', step: 'DONE', event: 'SESSION_WIPED', count: 1, code: null },
  ]);
  const serialized = JSON.stringify(timeline);
  for (const leak of ['RA-778899', 'agreementNumber', 'matchType', 'exact', 'flow_completed', 'desk 3', 'customer said', 'juan', 'data']) {
    assert.ok(!serialized.includes(leak), `must not leak "${leak}"`);
  }
  assert.ok(timeline.every((e) => Object.keys(e).join(',') === 'at,step,event,count,code'));

  // cap: most recent ASSIST_TIMELINE_CAP entries survive (after collapsing)
  const many = Array.from({ length: MAX_SESSION_EVENTS }, (_, i) => ({ at: new Date(Date.UTC(2026, 8, 3, 0, 0, i)).toISOString(), step: 'ID', event: `E${i}`, data: null }));
  const capped = projectAssistTimeline(many);
  assert.equal(capped.length, ASSIST_TIMELINE_CAP);
  assert.equal(capped[0].event, `E${MAX_SESSION_EVENTS - ASSIST_TIMELINE_CAP}`);
  assert.equal(capped.at(-1).event, `E${MAX_SESSION_EVENTS - 1}`);
  // 500 identical events collapse to ONE entry with count 500
  const firstAt = new Date(Date.UTC(2026, 8, 3, 1, 0, 0)).toISOString();
  const same = Array.from({ length: MAX_SESSION_EVENTS }, (_, i) => ({ at: new Date(Date.UTC(2026, 8, 3, 1, 0, i)).toISOString(), step: 'ID', event: 'ID_PHOTO_EXTRACT', data: { ok: false } }));
  assert.deepEqual(projectAssistTimeline(same), [{ at: firstAt, step: 'ID', event: 'ID_PHOTO_EXTRACT', count: MAX_SESSION_EVENTS, code: null }]);
  // Innovation F1 SHOULD-2: an entry we cannot timestamp is dropped, not shipped
  // as `at: null` for the other side to defend against.
  assert.deepEqual(projectAssistTimeline([
    { at: 'x', step: 'ID', event: 'VERIFY_ID_FAILED', data: null },
    { at: null, step: 'ID', event: 'VERIFY_ID_FAILED', data: null },
    { at: firstAt, step: 'ID', event: 'VERIFY_ID_PASSED', data: null },
  ]), [{ at: firstAt, step: 'ID', event: 'VERIFY_ID_PASSED', count: 1, code: null }]);
  assert.deepEqual(projectAssistTimeline(null), []);
  assert.deepEqual(projectAssistTimeline('nope'), []);
});

test('F1 routes are wired: device POST (guarded) + admin GET under /admin/ (no device-router collision)', async () => {
  const { kioskRouter } = await import('./kiosk.routes.js');
  const { kioskAdminRouter } = await import('./kiosk-admin.routes.js');

  const bind = kioskRouter.stack.find((l) => l.route?.path === '/sessions/:id/vozia-conversation' && l.route.methods.post)?.route;
  assert.ok(bind, 'device binding route exists');
  // deviceGuards (meta + rate limit + requireKioskDevice) + handler
  assert.equal(bind.stack.length, 4, 'binding route carries the device guard stack');
  assert.ok(bind.stack.some((l) => l.handle === requireKioskDevice), 'requireKioskDevice is on the binding route');

  const view = kioskAdminRouter.stack.find((l) => l.route?.path === '/admin/sessions/:kioskSessionId/assist-view' && l.route.methods.get)?.route;
  assert.ok(view, 'admin assist-view route exists');
  assert.equal(view.stack.length, 1, 'no extra role gate — module + allowlist + binding are the gates');

  // The device router must NOT own anything under /admin/* (it is mounted
  // first and would shadow the authed router).
  assert.ok(!kioskRouter.stack.some((l) => String(l.route?.path || '').startsWith('/admin')));
  // …and the assist-view must not be reachable through a device-guarded path.
  assert.ok(!kioskRouter.stack.some((l) => String(l.route?.path || '').includes('assist-view')));
});
