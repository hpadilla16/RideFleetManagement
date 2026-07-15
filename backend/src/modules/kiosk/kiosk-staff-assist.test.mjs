/**
 * Ride Kiosk — Fase B3c tests (Staff Assist).
 * Run: npm run test:kiosk  (node --test --test-force-exit)
 *
 * PIN verification runs through the REAL authService.verifyLockPin (bcrypt
 * hash comparison — never reimplemented); prisma is stubbed in-memory like
 * the sibling kiosk suites.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-kiosk-staff-assist-0123456789';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { KioskError } from './kiosk-device.service.js';
import { kioskDeviceService } from './kiosk-device.service.js';
import { kioskStaffAssistService, ASSIST_GRANT_TTL_MIN } from './kiosk-staff-assist.service.js';
import { kioskCheckoutService } from './kiosk-checkout.service.js';
import { MAX_LOOKUP_MISSES } from './kiosk-session.service.js';
import { sectionsForAgreement } from '../checkout-session/terms-content.js';

// ---------------------------------------------------------------------------
// In-memory prisma stubs (same harness family as kiosk-checkout.test.mjs).
// ---------------------------------------------------------------------------

let db;

function condMatch(rowVal, cond) {
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'mode') continue;
    if (op === 'not') {
      if (val === null ? rowVal == null : rowVal === val) return false;
    } else if (op === 'in') {
      if (!val.includes(rowVal)) return false;
    } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (rowVal == null) return false;
      if (op === 'gt' && !(rowVal > val)) return false;
      if (op === 'gte' && !(rowVal >= val)) return false;
      if (op === 'lt' && !(rowVal < val)) return false;
      if (op === 'lte' && !(rowVal <= val)) return false;
    } else if (op === 'equals') {
      if (String(rowVal ?? '').toLowerCase() !== String(val ?? '').toLowerCase()) return false;
    } else if (op === 'is') {
      if (!matches(rowVal || {}, val)) return false;
    } else {
      if (!matches(rowVal || {}, { [op]: val })) return false;
    }
  }
  return true;
}

function matches(row, where) {
  return Object.entries(where || {}).every(([key, val]) => {
    if (val === undefined) return true;
    if (key === 'OR') return val.some((clause) => matches(row, clause));
    if (key === 'AND') return val.every((clause) => matches(row, clause));
    if (key === 'NOT') return !matches(row, val);
    if (val === null) return row[key] == null;
    if (val instanceof Date || typeof val !== 'object') return row[key] === val;
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
    count: async ({ where } = {}) => rows().filter((r) => matches(r, where)).length,
    create: async ({ data } = {}) => {
      const row = { id: `row_${++seq}`, ...data };
      rows().push(row);
      return row;
    },
    createMany: async ({ data } = {}) => {
      const list = Array.isArray(data) ? data : [data];
      list.forEach((entry) => rows().push({ id: `row_${++seq}`, ...entry }));
      return { count: list.length };
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
    deleteMany: async ({ where } = {}) => {
      const keep = rows().filter((r) => !matches(r, where));
      const count = rows().length - keep.length;
      rows().splice(0, rows().length, ...keep);
      return { count };
    },
    groupBy: async () => [],
  };
}

const PIN = '2468';
const PIN_HASH = bcrypt.hashSync(PIN, 4);

function installStubs() {
  db = {
    devices: [], sessions: [], reservations: [], vehicles: [], checkoutSessions: [],
    agreements: [], initials: [], inspections: [], fuelReadings: [], mileageEntries: [],
    auditLogs: [], loanerAgreements: [], settings: [], customerInspections: [],
    handoffTokens: [], customers: [], users: [], locations: [],
  };
  Object.assign(prisma.kioskDevice, delegateStub(() => db.devices));
  Object.assign(prisma.kioskSession, delegateStub(() => db.sessions));
  Object.assign(prisma.reservation, delegateStub(() => db.reservations));
  Object.assign(prisma.vehicle, delegateStub(() => db.vehicles));
  Object.assign(prisma.checkoutSession, delegateStub(() => db.checkoutSessions));
  Object.assign(prisma.rentalAgreement, delegateStub(() => db.agreements));
  Object.assign(prisma.rentalAgreementInspection, delegateStub(() => db.inspections));
  Object.assign(prisma.vehicleFuelReading, delegateStub(() => db.fuelReadings));
  Object.assign(prisma.vehicleMileageEntry, delegateStub(() => db.mileageEntries));
  Object.assign(prisma.auditLog, delegateStub(() => db.auditLogs));
  Object.assign(prisma.loanerAgreement, delegateStub(() => db.loanerAgreements));
  Object.assign(prisma.appSetting, delegateStub(() => db.settings));
  Object.assign(prisma.customerInspection, delegateStub(() => db.customerInspections));
  Object.assign(prisma.handoffToken, delegateStub(() => db.handoffTokens));
  Object.assign(prisma.customer, delegateStub(() => db.customers));
  Object.assign(prisma.user, delegateStub(() => db.users));
  Object.assign(prisma.location, delegateStub(() => db.locations));

  Object.assign(prisma.agreementSectionInitial, delegateStub(() => db.initials));
  prisma.agreementSectionInitial.upsert = async ({ where, create, update }) => {
    const { agreementId, sectionKey } = where.agreementId_sectionKey;
    const existing = db.initials.find((r) => r.agreementId === agreementId && r.sectionKey === sectionKey);
    if (existing) return applyData(existing, update);
    const row = { id: `ini_${db.initials.length + 1}`, ...create };
    db.initials.push(row);
    return row;
  };

  prisma.$transaction = async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma));
}

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const DEVICE = { id: 'dev1', tenantId: 't1', locationId: 'loc1', name: 'Lobby 1', walkupEnabled: true };

function jpegDataUrl(bytes = 4096, fill = 0x11) {
  const buf = Buffer.alloc(bytes, fill);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
const FRONT = jpegDataUrl(4096, 0x11);
const BACK = jpegDataUrl(4096, 0x22);

function seedDeviceRow(overrides = {}) {
  const device = {
    id: 'dev1', tenantId: 't1', locationId: 'loc1', name: 'Lobby 1',
    tokenHash: 'th', tokenVersion: 1, pairingCodeHash: null, pairingCodeExpiresAt: null,
    pairingAttempts: 0, lookupMisses: 0, lookupLockedUntil: null,
    status: 'ACTIVE', walkupEnabled: true, lastSeenAt: new Date(),
    ...overrides,
  };
  db.devices.push(device);
  return device;
}

function seedStaff() {
  db.users.push(
    { id: 'u-admin', tenantId: 't1', fullName: 'Ana Admin', email: 'ana@x.com', role: 'ADMIN', isActive: true, isServiceAccount: false, lockPinHash: PIN_HASH },
    { id: 'u-agent', tenantId: 't1', fullName: 'Beto Agent', email: 'beto@x.com', role: 'AGENT', isActive: true, isServiceAccount: false, lockPinHash: null },
    { id: 'u-off', tenantId: 't1', fullName: 'Carla Off', email: 'carla@x.com', role: 'OPS', isActive: false, isServiceAccount: false, lockPinHash: PIN_HASH },
    { id: 'u-svc', tenantId: 't1', fullName: 'VozIA Bot', email: 'bot@x.com', role: 'AGENT', isActive: true, isServiceAccount: true, lockPinHash: PIN_HASH },
    { id: 'u-super', tenantId: 't1', fullName: 'Root Super', email: 'root@x.com', role: 'SUPER_ADMIN', isActive: true, isServiceAccount: false, lockPinHash: PIN_HASH },
    { id: 'u-other', tenantId: 't2', fullName: 'Otro Tenant', email: 'otro@x.com', role: 'ADMIN', isActive: true, isServiceAccount: false, lockPinHash: PIN_HASH },
  );
}

function seedSession(overrides = {}) {
  const session = {
    id: 'ks1', tenantId: 't1', deviceId: 'dev1', kind: 'PICKUP',
    reservationId: 'res1', checkoutSessionId: 'cs1', step: 'ID',
    outcome: 'ESCALATED', escalatedReason: 'ID_SCAN_FAILED', eventsJson: [],
    idVerifiedAt: null, idVerifyMethod: null, assistUserId: null, assistGrantedAt: null,
    lastActivityAt: new Date(), startedAt: new Date(), endedAt: new Date(),
    ...overrides,
  };
  db.sessions.push(session);
  return session;
}

function seedWorld({ checkout = {}, agreement = {}, reservation = {}, customer = {} } = {}) {
  const cust = {
    id: 'cust1', tenantId: 't1', firstName: 'Maria', lastName: 'Gonzalez',
    email: 'maria@example.com', phone: '+1 407 555 1234',
    licenseNumber: null, licenseState: null, dateOfBirth: null,
    idPhotoUrl: null, licenseBackUrl: null,
    ...customer,
  };
  db.customers.push(cust);
  const resvRow = {
    id: 'res1', tenantId: 't1', reservationNumber: 'RES-100200', status: 'CONFIRMED',
    workflowMode: 'RENTAL', bookingChannel: 'EXPEDIA', pickupLocationId: 'loc1',
    pickupAt: new Date(Date.now() + 2 * HOUR), returnAt: new Date(Date.now() + 50 * HOUR),
    vehicleId: 'v1', vehicleTypeId: 'vt1',
    vehicleType: { name: 'Compact SUV' },
    pickupLocation: { locationConfig: JSON.stringify({ chargeAgeMin: 21 }) },
    customer: cust,
    vehicle: { id: 'v1', make: 'Kia', model: 'Soul', year: 2025, color: 'White', plate: 'KIA-001', internalNumber: '101' },
    rentalAgreement: { id: 'ra1' },
    ...reservation,
  };
  db.reservations.push(resvRow);
  db.vehicles.push({ id: 'v1', tenantId: 't1', status: 'AVAILABLE', mileage: 45210 });
  db.agreements.push({
    id: 'ra1', agreementNumber: 'RA-0001', reservationId: 'res1', tenantId: 't1',
    declinedInsurance: false, status: 'DRAFT',
    subtotal: 150, taxes: 17.25, fees: 0, total: 167.25, securityDepositAmount: 200,
    odometerOut: null, fuelOut: null,
    ...agreement,
  });
  db.checkoutSessions.push({
    id: 'cs1', reservationId: 'res1', agreementId: 'ra1', tenantId: 't1',
    currentStep: 'CONFIRMING', events: '[]',
    tcCompletedAt: null, paymentCompletedAt: null, inspectionCompletedAt: null,
    customerSignedAt: null, finishedAt: null, autoEmailedAt: new Date(),
    reservation: resvRow,
    ...checkout,
  });
}

const GOOD_FIELDS = {
  firstName: 'Maria', lastName: 'Gonzalez',
  dateOfBirth: '1990-03-15',
  licenseNumber: 'D123-456', licenseState: 'FL',
  licenseExpiry: new Date(Date.now() + 2 * 365 * 24 * HOUR).toISOString(),
};

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

async function unlockAsAdmin() {
  return kioskStaffAssistService.unlock('ks1', DEVICE, { userId: 'u-admin', pin: PIN });
}

beforeEach(() => {
  installStubs();
  delete process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
});

// ---------------------------------------------------------------------------
// Staff list
// ---------------------------------------------------------------------------

test('staff list: only for assistable sessions; names-only; filtered to active tenant staff roles', async () => {
  seedDeviceRow();
  seedStaff();
  seedWorld();

  // not assistable: IN_PROGRESS with no verify failures
  seedSession({ id: 'ksOk', outcome: 'IN_PROGRESS', escalatedReason: null, endedAt: null });
  await rejects(
    kioskStaffAssistService.listAssistStaff('ksOk', DEVICE),
    { status: 409, code: 'NOT_ASSISTABLE' },
  );

  // ESCALATED → assistable
  seedSession();
  const result = await kioskStaffAssistService.listAssistStaff('ks1', DEVICE);
  assert.deepEqual(result.staff, [
    { id: 'u-admin', name: 'Ana Admin', hasPin: true },
    { id: 'u-agent', name: 'Beto Agent', hasPin: false },
  ], 'active ADMIN/OPS/AGENT of THIS tenant only — no inactive, no service accounts, no SUPER_ADMIN, no other tenant');

  // names-only: nothing sensitive leaves the server
  const serialized = JSON.stringify(result);
  assert.ok(!/email|@x\.com|role|lockPinHash|ADMIN|AGENT/.test(serialized), 'no emails/roles/hashes in the picker payload');

  // escalateSuggested state (2 server-side verify failures) also opens it
  seedSession({
    id: 'ksSuggested', outcome: 'IN_PROGRESS', escalatedReason: null, endedAt: null,
    eventsJson: [
      { at: 'x', step: 'ID', event: 'VERIFY_ID_FAILED', data: null },
      { at: 'x', step: 'ID', event: 'VERIFY_ID_FAILED', data: null },
    ],
  });
  const suggested = await kioskStaffAssistService.listAssistStaff('ksSuggested', DEVICE);
  assert.equal(suggested.staff.length, 2);
});

// ---------------------------------------------------------------------------
// Unlock (PIN)
// ---------------------------------------------------------------------------

test('unlock: happy path mints a 10-min grant + audit row; wrong PIN feeds the shared device lockout', async () => {
  const device = seedDeviceRow();
  seedStaff();
  seedWorld();
  const session = seedSession();

  // NO_PIN_SET is its own clear code
  await rejects(
    kioskStaffAssistService.unlock('ks1', DEVICE, { userId: 'u-agent', pin: '0000' }),
    { status: 409, code: 'NO_PIN_SET' },
  );
  // staff outside the tenant/roles/active set → 404
  for (const userId of ['u-other', 'u-off', 'u-svc', 'u-super', 'u-ghost']) {
    await rejects(
      kioskStaffAssistService.unlock('ks1', DEVICE, { userId, pin: PIN }),
      { status: 404, code: 'STAFF_NOT_FOUND' },
    );
  }

  // wrong PIN ×5 → device locked (shared lookup counter)
  for (let i = 0; i < MAX_LOOKUP_MISSES; i += 1) {
    const err = await rejects(
      kioskStaffAssistService.unlock('ks1', DEVICE, { userId: 'u-admin', pin: '9999' }),
      { status: 401, code: 'INVALID_PIN' },
    );
    assert.equal(err.details.attemptsRemaining, MAX_LOOKUP_MISSES - i - 1);
  }
  assert.ok(device.lookupLockedUntil instanceof Date && device.lookupLockedUntil > new Date(), 'device locked');
  await rejects(
    kioskStaffAssistService.unlock('ks1', DEVICE, { userId: 'u-admin', pin: PIN }),
    { status: 429, code: 'STAFF_ASSIST_LOCKED' },
  );

  // admin pairing-code reissue clears the lockout (same recovery as lookup)
  await kioskDeviceService.issuePairingCode('dev1', { tenantId: 't1' });
  assert.equal(device.lookupLockedUntil, null);

  const unlocked = await unlockAsAdmin();
  assert.equal(unlocked.ok, true);
  assert.equal(unlocked.grant.userId, 'u-admin');
  assert.equal(unlocked.grant.name, 'Ana Admin');
  assert.ok(unlocked.grant.expiresAt instanceof Date);
  assert.equal(session.assistUserId, 'u-admin');
  assert.ok(session.assistGrantedAt instanceof Date);
  assert.equal(device.lookupMisses, 0, 'counter rearmed on success');

  const audit = db.auditLogs.find((row) => String(row.metadata || '').includes('kiosk_staff_assist_unlock'));
  assert.ok(audit, 'unlock audit row written');
  assert.equal(audit.actorUserId, 'u-admin');
});

// ---------------------------------------------------------------------------
// Staff verify-id
// ---------------------------------------------------------------------------

test('staff verify-id: requires a live grant; expired grant → 403', async () => {
  seedDeviceRow();
  seedStaff();
  seedWorld();
  seedSession(); // no grant

  await rejects(
    kioskStaffAssistService.staffVerifyId('ks1', DEVICE, { fields: GOOD_FIELDS, licenseFrontPhoto: FRONT, licenseBackPhoto: BACK }),
    { status: 403, code: 'ASSIST_GRANT_REQUIRED' },
  );

  // expired grant (11 min old)
  db.sessions[0].assistUserId = 'u-admin';
  db.sessions[0].assistGrantedAt = new Date(Date.now() - (ASSIST_GRANT_TTL_MIN + 1) * MIN);
  await rejects(
    kioskStaffAssistService.staffVerifyId('ks1', DEVICE, { fields: GOOD_FIELDS, licenseFrontPhoto: FRONT, licenseBackPhoto: BACK }),
    { status: 403, code: 'ASSIST_GRANT_REQUIRED' },
  );
});

test('staff verify-id: BOTH photos mandatory + validated; nothing written on 422', async () => {
  seedDeviceRow();
  seedStaff();
  seedWorld();
  const session = seedSession({ assistUserId: 'u-admin', assistGrantedAt: new Date() });

  await rejects(
    kioskStaffAssistService.staffVerifyId('ks1', DEVICE, { fields: GOOD_FIELDS, licenseFrontPhoto: FRONT }),
    { status: 422, code: 'MISSING_PHOTO' },
  );
  await rejects(
    kioskStaffAssistService.staffVerifyId('ks1', DEVICE, {
      fields: GOOD_FIELDS,
      licenseFrontPhoto: FRONT,
      licenseBackPhoto: `data:image/png;base64,${Buffer.from('junk not an image').toString('base64')}`,
    }),
    { status: 422, code: 'INVALID_PHOTO' },
  );
  assert.equal(session.idVerifiedAt, null);
  assert.equal(db.customers[0].idPhotoUrl, null);
  assert.equal(db.customers[0].licenseBackUrl, null);
  assert.equal(session.outcome, 'ESCALATED', 'session untouched');
});

test('staff verify-id: the override bypasses the SCAN, never the rules — underage stays a hard stop', async () => {
  seedDeviceRow();
  seedStaff();
  seedWorld();
  const session = seedSession({ assistUserId: 'u-admin', assistGrantedAt: new Date() });

  const result = await kioskStaffAssistService.staffVerifyId('ks1', DEVICE, {
    fields: { ...GOOD_FIELDS, dateOfBirth: new Date(Date.now() - 18 * 365 * 24 * HOUR).toISOString() },
    licenseFrontPhoto: FRONT,
    licenseBackPhoto: BACK,
  });

  assert.equal(result.verified, false);
  assert.ok(result.failureReasons.includes('UNDERAGE'));
  assert.equal(result.minimumAge, 21);
  assert.equal(session.idVerifiedAt, null, 'NO verify stamp');
  assert.equal(session.outcome, 'ESCALATED', 'session STAYS escalated');
  assert.equal(session.assistGrantedAt !== null, true, 'grant not consumed by a failed attempt');
  const audit = db.auditLogs.find((row) => String(row.metadata || '').includes('"verified":false'));
  assert.ok(audit, 'rejected override is audited too');
});

test('staff verify-id happy path: STAFF_OVERRIDE stamp, audit, outcome back to IN_PROGRESS, photos stored, sign() unblocked', async () => {
  seedDeviceRow();
  seedStaff();
  seedWorld({ checkout: { paymentCompletedAt: new Date() } });
  const session = seedSession();

  await unlockAsAdmin();
  const result = await kioskStaffAssistService.staffVerifyId('ks1', DEVICE, {
    fields: GOOD_FIELDS,
    licenseFrontPhoto: FRONT,
    licenseBackPhoto: BACK,
  });

  assert.equal(result.verified, true);
  assert.deepEqual(result.checks, { ageOk: true, licenseNotExpired: true });
  assert.equal(result.session.outcome, 'IN_PROGRESS');
  assert.equal(result.session.idVerifyMethod, 'STAFF_OVERRIDE');

  assert.ok(session.idVerifiedAt instanceof Date);
  assert.equal(session.idVerifyMethod, 'STAFF_OVERRIDE');
  assert.equal(session.assistUserId, 'u-admin', 'who assisted stays persisted');
  assert.equal(session.assistGrantedAt, null, 'grant consumed');
  assert.equal(session.outcome, 'IN_PROGRESS');
  assert.equal(session.escalatedReason, null);
  assert.equal(session.endedAt, null);

  // fields write-through (empty columns only) + BOTH photos (fallback mode:
  // front → idPhotoUrl, back → licenseBackUrl)
  const cust = db.customers[0];
  assert.equal(cust.licenseNumber, 'D123-456');
  assert.equal(cust.licenseState, 'FL');
  assert.ok(cust.dateOfBirth instanceof Date);
  assert.equal(cust.idPhotoUrl, FRONT);
  assert.equal(cust.licenseBackUrl, BACK);

  // telemetry + audit
  assert.ok(session.eventsJson.some((e) => e.event === 'STAFF_ASSIST_VERIFY'));
  const audit = db.auditLogs.find((row) => String(row.metadata || '').includes('"verified":true'));
  assert.ok(audit);
  assert.equal(audit.actorUserId, 'u-admin');

  // the guest flow continues: sign() now passes the ID_VERIFY_REQUIRED gate
  const signed = await kioskCheckoutService.sign('ks1', DEVICE, {
    sectionInitials: sectionsForAgreement({ declinedInsurance: false })
      .map((s) => ({ sectionKey: s.key, initialDataUrl: `data:image/png;base64,${'A'.repeat(300)}` })),
    signature: `data:image/png;base64,${'B'.repeat(300)}`,
  });
  assert.equal(signed.checkoutSession.currentStep, 'CLOSED');
});
