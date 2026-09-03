/**
 * Ride Kiosk — Fase B3a tests (2026-07-05): verify-id, T&C sign → CLOSED
 * (anti-beta.152 pinned), sandbox payment gate, complete/lockbox gating.
 * Run: npm run test:kiosk  (node --test --test-force-exit)
 *
 * The sign test drives the REAL checkoutSessionService (transition +
 * stampSideEffect + saveCustomerSignature + the CLOSED cascade) against
 * in-memory prisma stubs — no mocked state machine.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { KioskError, deviceConnectivity, DEVICE_OFFLINE_AFTER_MS } from './kiosk-device.service.js';
import {
  kioskCheckoutService,
  namesMatch,
  KIOSK_DEFAULT_MIN_RENTAL_AGE,
  MAX_ID_EXTRACTS_PER_SESSION,
  MAX_ID_EXTRACTS_PER_DEVICE_PER_HOUR,
  resetExtractRateTracking,
  resetKioskPresenceThrottle,
} from './kiosk-checkout.service.js';
import { readEvents } from '../checkout-session/state-machine.js';
import { MAX_SESSION_EVENTS } from './kiosk-session.service.js';
import { kioskSessionService, ESCALATE_REASONS } from './kiosk-session.service.js';
import { sectionsForAgreement } from '../checkout-session/terms-content.js';
import { customerInspectionService } from '../customer-inspection/customer-inspection.service.js';

// ---------------------------------------------------------------------------
// In-memory prisma stubs (kiosk.test.mjs style + count/deleteMany/upsert).
// ---------------------------------------------------------------------------

let db;

function condMatch(rowVal, cond) {
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'mode') continue;
    if (op === 'not') {
      if (val === null ? rowVal == null : rowVal === val) return false;
    } else if (op === 'in') {
      if (!val.includes(rowVal)) return false;
    } else if (op === 'notIn') {
      if (val.includes(rowVal)) return false;
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

function installStubs() {
  db = {
    devices: [], sessions: [], reservations: [], vehicles: [], checkoutSessions: [],
    agreements: [], initials: [], inspections: [], fuelReadings: [], mileageEntries: [],
    auditLogs: [], loanerAgreements: [], settings: [], customerInspections: [],
    handoffTokens: [], customers: [], presences: [],
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
  prisma.appSetting.upsert = async ({ where, create, update }) => {
    const existing = db.settings.find((r) => r.key === where.key);
    if (existing) return applyData(existing, update);
    const row = { ...create };
    db.settings.push(row);
    return row;
  };
  Object.assign(prisma.checkoutPresence, delegateStub(() => db.presences));
  Object.assign(prisma.customerInspection, delegateStub(() => db.customerInspections));
  Object.assign(prisma.handoffToken, delegateStub(() => db.handoffTokens));
  Object.assign(prisma.customer, delegateStub(() => db.customers));
  db.locations = [{ id: 'loc1', tenantId: 't1', name: 'Main' }, { id: 'loc2', tenantId: 't1', name: 'Airport' }];
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

  // fn form + array form (saveCustomerSignature uses the array form).
  prisma.$transaction = async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma));
}

const HOUR = 60 * 60 * 1000;
const DEVICE = { id: 'dev1', tenantId: 't1', locationId: 'loc1', name: 'Lobby 1', walkupEnabled: true };
const INITIAL_PNG = `data:image/png;base64,${'A'.repeat(300)}`;

function seedKioskSession(overrides = {}) {
  const session = {
    id: 'ks1', tenantId: 't1', deviceId: 'dev1', kind: 'PICKUP',
    reservationId: 'res1', checkoutSessionId: 'cs1', step: 'SIGN',
    outcome: 'IN_PROGRESS', escalatedReason: null, eventsJson: [],
    idVerifiedAt: null,
    lastActivityAt: new Date(), startedAt: new Date(), endedAt: null,
    ...overrides,
  };
  db.sessions.push(session);
  return session;
}

function seedWorld({ checkout = {}, agreement = {}, reservation = {}, customer = {} } = {}) {
  const cust = {
    id: 'cust1', tenantId: 't1', firstName: 'Maria', lastName: 'Gonzalez',
    email: 'maria@example.com', phone: '+1 407 555 1234',
    licenseNumber: null, licenseState: null, dateOfBirth: null, idPhotoUrl: null,
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
  db.fuelReadings.push({ id: 'fr1', vehicleId: 'v1', fuelFraction: 0.75, createdAt: new Date() });
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
    customerSignedAt: null, finishedAt: null,
    // pre-set so the CLOSED cascade's auto-email early-returns (no SMTP in tests)
    autoEmailedAt: new Date(),
    // embedded relation (the stub ignores `include`) — used by the
    // closedSession customer-inspection path
    reservation: resvRow,
    ...checkout,
  });
}

function allInitials() {
  return sectionsForAgreement({ declinedInsurance: false })
    .map((s) => ({ sectionKey: s.key, initialDataUrl: INITIAL_PNG }));
}

const SIGNATURE = `data:image/png;base64,${'B'.repeat(300)}`;

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
  resetExtractRateTracking();
  resetKioskPresenceThrottle();
  delete process.env.KIOSK_PAYMENT_SANDBOX;
  delete process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
});

// ---------------------------------------------------------------------------
// namesMatch (pure)
// ---------------------------------------------------------------------------

test('namesMatch: case/accents/middle names tolerated, different people rejected', () => {
  const stored = { storedFirst: 'Maria', storedLast: 'Gonzalez' };
  assert.equal(namesMatch({ scannedFirst: 'MARIA', scannedLast: 'GONZALEZ', ...stored }), true);
  assert.equal(namesMatch({ scannedFirst: 'María José', scannedLast: 'González Rivera', ...stored }), true);
  assert.equal(namesMatch({ scannedFirst: 'JOSÉ', scannedLast: 'GONZALEZ', storedFirst: 'Jose', storedLast: 'Gonzalez' }), true);
  assert.equal(namesMatch({ scannedFirst: 'Maria', scannedLast: 'Rivera', ...stored }), false);
  assert.equal(namesMatch({ scannedFirst: 'Pedro', scannedLast: 'Gonzalez', ...stored }), false);
  assert.equal(namesMatch({ scannedFirst: '', scannedLast: 'Gonzalez', ...stored }), false);
});

test('namesMatch: first-name prefix goes scanned→stored ONLY (B3a review S2)', () => {
  // license "WILL" vs stored "William" — nickname/truncated scan accepted
  assert.equal(namesMatch({ scannedFirst: 'Will', scannedLast: 'Smith', storedFirst: 'William', storedLast: 'Smith' }), true);
  // stored "Jose" must NOT accept a scanned "Josefina" (different person —
  // this was the false-accept the reverse prefix allowed before S2)
  assert.equal(namesMatch({ scannedFirst: 'Josefina', scannedLast: 'Gonzalez', storedFirst: 'Jose', storedLast: 'Gonzalez' }), false);
  // two-surname stored vs single scanned surname still tolerated
  assert.equal(namesMatch({ scannedFirst: 'Maria', scannedLast: 'Gonzalez', storedFirst: 'Maria', storedLast: 'González Rivera' }), true);
});

// ---------------------------------------------------------------------------
// verify-id
// ---------------------------------------------------------------------------

const GOOD_SCAN = {
  firstName: 'María',
  lastName: 'GONZALEZ',
  dateOfBirth: '1990-03-15',
  licenseNumber: 'D123-456-78-901',
  licenseState: 'FL',
  licenseExpiry: new Date(Date.now() + 2 * 365 * 24 * HOUR).toISOString(),
};

test('verify-id: pass — booleans only, license write-through fills empty customer columns', async () => {
  seedKioskSession();
  seedWorld();

  const result = await kioskCheckoutService.verifyId('ks1', DEVICE, { aamvaFields: GOOD_SCAN });

  assert.equal(result.verified, true);
  assert.deepEqual(result.checks, { nameMatches: true, ageOk: true, licenseNotExpired: true });
  assert.deepEqual(result.failureReasons, []);
  assert.equal(result.escalateSuggested, false);

  // NEVER echo stored PII to the lobby screen
  const serialized = JSON.stringify(result);
  assert.ok(!/1990|D123|Gonzalez|dateOfBirth|licenseNumber/i.test(serialized), 'no DOB/license/name echo');

  // counter-style write-through (only empty columns)
  const cust = db.customers[0];
  assert.equal(cust.licenseNumber, 'D123-456-78-901');
  assert.equal(cust.licenseState, 'FL');
  assert.ok(cust.dateOfBirth instanceof Date);
  assert.equal(db.sessions[0].eventsJson.at(-1).event, 'VERIFY_ID_PASSED');
});

test('verify-id: does not clobber staff-entered license data', async () => {
  seedKioskSession();
  seedWorld({ customer: { licenseNumber: 'STAFF-ENTERED', licenseState: 'PR' } });
  await kioskCheckoutService.verifyId('ks1', DEVICE, { aamvaFields: GOOD_SCAN });
  assert.equal(db.customers[0].licenseNumber, 'STAFF-ENTERED');
  assert.equal(db.customers[0].licenseState, 'PR');
});

test('verify-id: name mismatch / underage / expiring license each fail with reason codes', async () => {
  seedKioskSession();
  seedWorld();

  const mismatch = await kioskCheckoutService.verifyId('ks1', DEVICE, {
    aamvaFields: { ...GOOD_SCAN, firstName: 'Pedro', lastName: 'Rivera' },
  });
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.checks.nameMatches, false);
  assert.ok(mismatch.failureReasons.includes('NAME_MISMATCH'));

  const underage = await kioskCheckoutService.verifyId('ks1', DEVICE, {
    aamvaFields: { ...GOOD_SCAN, dateOfBirth: new Date(Date.now() - 18 * 365 * 24 * HOUR).toISOString() },
  });
  assert.equal(underage.checks.ageOk, false);
  assert.ok(underage.failureReasons.includes('UNDERAGE'));
  assert.equal(underage.minimumAge, 21);

  const expiring = await kioskCheckoutService.verifyId('ks1', DEVICE, {
    aamvaFields: { ...GOOD_SCAN, licenseExpiry: new Date(Date.now() + 10 * HOUR).toISOString() },
  });
  assert.equal(expiring.checks.licenseNotExpired, false);
  assert.ok(expiring.failureReasons.includes('LICENSE_EXPIRES_BEFORE_RETURN'));
  // failed scans never write through
  assert.equal(db.customers[0].licenseNumber, null);
});

test('verify-id: default minimum age applies when location config has none', async () => {
  seedKioskSession();
  seedWorld({ reservation: { pickupLocation: { locationConfig: null } } });
  const result = await kioskCheckoutService.verifyId('ks1', DEVICE, { aamvaFields: GOOD_SCAN });
  assert.equal(result.minimumAge, KIOSK_DEFAULT_MIN_RENTAL_AGE);
});

test('verify-id: second failure suggests escalation', async () => {
  seedKioskSession();
  seedWorld();
  const bad = { aamvaFields: { ...GOOD_SCAN, lastName: 'Rivera' } };

  const first = await kioskCheckoutService.verifyId('ks1', DEVICE, bad);
  assert.equal(first.escalateSuggested, false);
  const second = await kioskCheckoutService.verifyId('ks1', DEVICE, bad);
  assert.equal(second.escalateSuggested, true);
  assert.equal(db.sessions[0].eventsJson.filter((e) => e.event === 'VERIFY_ID_FAILED').length, 2);
});

// ---------------------------------------------------------------------------
// agreement (K7)
// ---------------------------------------------------------------------------

test('agreement: sections + masked summary + stamps, no PII', async () => {
  seedKioskSession();
  seedWorld();

  const data = await kioskCheckoutService.getAgreement('ks1', DEVICE);

  assert.equal(data.checkoutSession.id, 'cs1');
  assert.equal(data.checkoutSession.currentStep, 'CONFIRMING');
  assert.equal(data.agreement.agreementNumber, 'RA-0001');
  assert.equal(data.agreement.total, 167.25);
  assert.equal(data.agreement.securityDepositAmount, 200);
  assert.equal(data.summary.maskedName, 'Maria G.');
  assert.equal(data.summary.vehicle.plate, 'KIA-001');
  assert.ok(data.sections.length > 3);
  assert.ok(data.sections.every((s) => s.key && s.body && s.signed === false));
  assert.ok(!/Gonzalez|555|maria@/.test(JSON.stringify(data)), 'no PII in agreement payload');
});

// ---------------------------------------------------------------------------
// sandbox payment gate
// ---------------------------------------------------------------------------

test('sandbox-payment: hard 403 when KIOSK_PAYMENT_SANDBOX is not "true"', async () => {
  seedKioskSession();
  seedWorld();
  await rejects(kioskCheckoutService.sandboxPayment('ks1', DEVICE), { status: 403, code: 'SANDBOX_DISABLED' });

  process.env.KIOSK_PAYMENT_SANDBOX = 'false';
  await rejects(kioskCheckoutService.sandboxPayment('ks1', DEVICE), { status: 403, code: 'SANDBOX_DISABLED' });
  assert.equal(db.checkoutSessions[0].paymentCompletedAt, null, 'no stamp while disabled');
});

test('sandbox-payment: stamps paymentCompletedAt when enabled (demo only, no payment rows)', async () => {
  process.env.KIOSK_PAYMENT_SANDBOX = 'true';
  seedKioskSession();
  seedWorld();

  const result = await kioskCheckoutService.sandboxPayment('ks1', DEVICE);
  assert.equal(result.sandbox, true);
  assert.ok(db.checkoutSessions[0].paymentCompletedAt instanceof Date);
  assert.equal(db.sessions[0].eventsJson.at(-1).event, 'SANDBOX_PAYMENT_STAMPED');
});

// ---------------------------------------------------------------------------
// sign → CLOSED (anti-beta.152 regression pins)
// ---------------------------------------------------------------------------

test('sign: gates on the SERVER-recorded ID verify stamp (eventsJson is never consulted)', async () => {
  seedKioskSession({
    // forged client-side telemetry must NOT unlock signing
    eventsJson: [{ at: 'x', step: 'ID', event: 'VERIFY_ID_PASSED', data: null }],
  });
  seedWorld({ checkout: { paymentCompletedAt: new Date() } });

  await rejects(
    kioskCheckoutService.sign('ks1', DEVICE, { sectionInitials: allInitials(), signature: SIGNATURE }),
    { status: 409, code: 'ID_VERIFY_REQUIRED' },
  );
  assert.equal(db.checkoutSessions[0].currentStep, 'CONFIRMING');
});

test('verify-id pass stamps idVerifiedAt server-side, then sign proceeds', async () => {
  seedKioskSession();
  seedWorld({ checkout: { paymentCompletedAt: new Date() } });

  await rejects(
    kioskCheckoutService.sign('ks1', DEVICE, { sectionInitials: allInitials(), signature: SIGNATURE }),
    { status: 409, code: 'ID_VERIFY_REQUIRED' },
  );

  const verify = await kioskCheckoutService.verifyId('ks1', DEVICE, { aamvaFields: GOOD_SCAN });
  assert.equal(verify.verified, true);
  assert.ok(db.sessions[0].idVerifiedAt instanceof Date, 'server-side stamp recorded');

  const result = await kioskCheckoutService.sign('ks1', DEVICE, { sectionInitials: allInitials(), signature: SIGNATURE });
  assert.equal(result.checkoutSession.currentStep, 'CLOSED');
});

test('attaching a DIFFERENT reservation clears the ID verify stamp', async () => {
  const session = seedKioskSession({ reservationId: null, idVerifiedAt: new Date() });
  seedWorld();

  await kioskSessionService.attachReservation('ks1', DEVICE, { reservationId: 'res1' });
  assert.equal(session.idVerifiedAt, null, 'stamp cleared — the verify belonged to no/another reservation');
});

test('sign: requires payment stamp and complete initials', async () => {
  seedKioskSession({ idVerifiedAt: new Date() });
  seedWorld();

  await rejects(
    kioskCheckoutService.sign('ks1', DEVICE, { sectionInitials: allInitials(), signature: SIGNATURE }),
    { status: 409, code: 'PAYMENT_REQUIRED' },
  );

  db.checkoutSessions[0].paymentCompletedAt = new Date();
  await rejects(
    kioskCheckoutService.sign('ks1', DEVICE, { sectionInitials: allInitials().slice(1), signature: SIGNATURE }),
    { status: 400, code: 'INITIALS_INCOMPLETE' },
  );
  await rejects(
    kioskCheckoutService.sign('ks1', DEVICE, { sectionInitials: allInitials(), signature: 'too-short' }),
    { status: 400, code: 'SIGNATURE_REQUIRED' },
  );
  assert.equal(db.checkoutSessions[0].currentStep, 'CONFIRMING', 'no transition on failed validation');
});

test('sign: drives the REAL state machine to CLOSED; contract metrics + mileage entry recorded (anti-beta.152)', async () => {
  seedKioskSession({ idVerifiedAt: new Date() });
  seedWorld({ checkout: { paymentCompletedAt: new Date() } });

  const result = await kioskCheckoutService.sign('ks1', DEVICE, {
    sectionInitials: allInitials(),
    signature: SIGNATURE,
    signerName: 'Maria Gonzalez',
  });

  assert.equal(result.ok, true);
  assert.equal(result.checkoutSession.currentStep, 'CLOSED');

  const cs = db.checkoutSessions[0];
  assert.equal(cs.currentStep, 'CLOSED');
  assert.ok(cs.tcCompletedAt instanceof Date, 'T&C stamped via initials, NOT pre-stamped earlier');
  assert.ok(cs.inspectionCompletedAt instanceof Date);
  assert.ok(cs.customerSignedAt instanceof Date);
  assert.ok(cs.finishedAt instanceof Date);

  // every section carries an initial on the agreement
  const expectedSections = sectionsForAgreement({ declinedInsurance: false });
  assert.equal(db.initials.length, expectedSections.length);

  const agreement = db.agreements[0];
  // ANTI-beta.152: contract metrics are NEVER '-' on a kiosk checkout —
  // odometerOut stamped from Vehicle.mileage, fuelOut from the latest reading.
  assert.equal(agreement.odometerOut, 45210, 'odometerOut stamped from Vehicle.mileage');
  assert.equal(agreement.fuelOut, 0.75, 'fuelOut stamped from latest fuel reading');
  assert.equal(agreement.status, 'FINALIZED');
  assert.equal(agreement.tcSignatureDataUrl, SIGNATURE);

  // ...and the mileage-history entry was recorded by the CLOSED cascade.
  assert.equal(db.mileageEntries.length, 1);
  assert.equal(db.mileageEntries[0].vehicleId, 'v1');
  assert.equal(db.mileageEntries[0].mileage, 45210);
  assert.equal(db.mileageEntries[0].source, 'CHECKOUT');

  // reservation checked out + vehicle synced to ON_RENT
  assert.equal(db.reservations[0].status, 'CHECKED_OUT');
  assert.equal(db.vehicles[0].status, 'ON_RENT');

  assert.equal(db.sessions[0].eventsJson.at(-1).event, 'SIGN_COMPLETED');
});

test('sign: staff-staged agreement metrics are never overwritten', async () => {
  seedKioskSession({ idVerifiedAt: new Date() });
  seedWorld({
    checkout: { paymentCompletedAt: new Date() },
    agreement: { odometerOut: 45000, fuelOut: 0.5 },
  });

  await kioskCheckoutService.sign('ks1', DEVICE, { sectionInitials: allInitials(), signature: SIGNATURE });

  const agreement = db.agreements[0];
  assert.equal(agreement.odometerOut, 45000, 'staged odometer wins over Vehicle.mileage');
  assert.equal(agreement.fuelOut, 0.5, 'staged fuel wins over latest reading');
  // mileage entry uses the agreement's (staged) checkout odometer
  assert.equal(db.mileageEntries[0].mileage, 45000);
});

// ---------------------------------------------------------------------------
// sign — M2 P3 (2026-08-17): race-hardened walk. Another surface (counter /
// RideOps) transitioning the SAME CheckoutSession mid-loop used to strand the
// sign half-applied. The injection point: the walk's first transition reads
// the session AFTER customerSignedAt is stamped — we mutate the row there,
// exactly like a concurrent write landing between the kiosk's snapshot and
// its transition.
// ---------------------------------------------------------------------------

/**
 * Arms a one-shot concurrent write: the first checkoutSession.findUnique that
 * observes customerSignedAt set (= the walk's first internal read) applies
 * `foreignPatch` to the row first — simulating another surface's transition
 * committing just before the kiosk's.
 */
function armConcurrentWrite(foreignPatch) {
  const orig = prisma.checkoutSession.findUnique;
  let fired = false;
  prisma.checkoutSession.findUnique = async (args) => {
    const row = await orig(args);
    if (!fired && row && row.customerSignedAt && row.currentStep === 'CONFIRMING') {
      fired = true;
      Object.assign(row, foreignPatch(row));
    }
    return row;
  };
}

test('sign: concurrent transition mid-walk → re-fetch + resume to CLOSED (no dupes, full cascade)', async () => {
  seedKioskSession({ idVerifiedAt: new Date() });
  seedWorld({ checkout: { paymentCompletedAt: new Date() } });

  armConcurrentWrite((row) => ({
    currentStep: 'TC_PENDING',
    stateVersion: (row.stateVersion || 0) + 1,
    events: JSON.stringify([...readEvents(row.events), {
      kind: 'TRANSITION', from: 'CONFIRMING', to: 'TC_PENDING',
      actorUserId: 'counter-agent', at: new Date().toISOString(),
    }]),
  }));

  const result = await kioskCheckoutService.sign('ks1', DEVICE, {
    sectionInitials: allInitials(), signature: SIGNATURE, signerName: 'Maria Gonzalez',
  });

  assert.equal(result.ok, true);
  assert.equal(result.checkoutSession.currentStep, 'CLOSED');

  const cs = db.checkoutSessions[0];
  assert.equal(cs.currentStep, 'CLOSED', 'walk resumed from the server state and finished');

  // Idempotent resume: the step the OTHER surface took is not re-taken — one
  // TRANSITION per from-step, strictly forward, ending in CLOSED.
  const transitions = readEvents(cs.events).filter((e) => e.kind === 'TRANSITION');
  const froms = transitions.map((t) => t.from);
  assert.equal(new Set(froms).size, froms.length, `no duplicated transition: ${froms.join('→')}`);
  assert.equal(transitions.at(-1).to, 'CLOSED');
  assert.equal(transitions[0].actorUserId, 'counter-agent', 'foreign hop kept its own attribution');

  // The CLOSED cascade still ran exactly once (anti-beta.152 invariants hold).
  assert.equal(db.reservations[0].status, 'CHECKED_OUT');
  assert.equal(db.agreements[0].status, 'FINALIZED');
  assert.equal(db.vehicles[0].status, 'ON_RENT');
  assert.equal(db.mileageEntries.length, 1);
});

test('sign: another surface CLOSED the session mid-walk → exit OK, no extra transitions', async () => {
  seedKioskSession({ idVerifiedAt: new Date() });
  seedWorld({ checkout: { paymentCompletedAt: new Date() } });

  armConcurrentWrite(() => ({ currentStep: 'CLOSED', finishedAt: new Date() }));

  const result = await kioskCheckoutService.sign('ks1', DEVICE, {
    sectionInitials: allInitials(), signature: SIGNATURE,
  });

  assert.equal(result.ok, true, 'kiosk complete must not blow up because another surface finished');
  assert.equal(result.checkoutSession.currentStep, 'CLOSED');
  const transitions = readEvents(db.checkoutSessions[0].events).filter((e) => e.kind === 'TRANSITION');
  assert.equal(transitions.length, 0, 'kiosk appended no transition of its own — the other surface owns the close');
});

test('sign: another surface CANCELLED mid-walk → 409 CHECKOUT_TERMINAL (never a fake success)', async () => {
  seedKioskSession({ idVerifiedAt: new Date() });
  seedWorld({ checkout: { paymentCompletedAt: new Date() } });

  armConcurrentWrite(() => ({ currentStep: 'CANCELLED', finishedAt: new Date() }));

  await rejects(
    kioskCheckoutService.sign('ks1', DEVICE, { sectionInitials: allInitials(), signature: SIGNATURE }),
    { status: 409, code: 'CHECKOUT_TERMINAL' },
  );
  assert.notEqual(db.reservations[0].status, 'CHECKED_OUT', 'no cascade on a cancelled checkout');
});

// ---------------------------------------------------------------------------
// presence hook (M2 P1) — loadCheckoutSessionFor reports KIOSK presence
// ---------------------------------------------------------------------------

test('kiosk touching a checkout session reports throttled KIOSK presence with the device name', async () => {
  seedKioskSession({ idVerifiedAt: new Date() });
  seedWorld({ checkout: { paymentCompletedAt: new Date() } });

  await kioskCheckoutService.sign('ks1', DEVICE, { sectionInitials: allInitials(), signature: SIGNATURE });
  // fire-and-forget write — let the microtask settle
  await new Promise((r) => setImmediate(r));

  assert.equal(db.presences.length, 1, 'one presence row (throttle collapses repeat touches)');
  assert.equal(db.presences[0].surface, 'KIOSK');
  assert.equal(db.presences[0].sessionId, 'cs1');
  assert.equal(db.presences[0].actorUserId, null, 'device has no user identity');
  assert.equal(db.presences[0].displayLabel, 'Lobby 1', 'chip shows the device name');
});

// ---------------------------------------------------------------------------
// complete (keys) — lockbox gating
// ---------------------------------------------------------------------------

test('complete: refuses before CLOSED (lockbox code never leaks early)', async () => {
  seedKioskSession();
  seedWorld({ checkout: { currentStep: 'PAID', paymentCompletedAt: new Date() } });
  db.settings.push({
    key: 'tenant:t1:kioskKeyHandoffConfig',
    value: JSON.stringify({ loc1: { mode: 'LOCKBOX', lockboxNote: 'Box 4 — code 2468' } }),
  });

  await rejects(kioskCheckoutService.complete('ks1', DEVICE), { status: 409, code: 'CHECKOUT_NOT_CLOSED' });
  assert.equal(db.sessions[0].outcome, 'IN_PROGRESS');
});

test('complete: CLOSED → lockbox config for the device location + COMPLETED lifecycle', async () => {
  seedKioskSession();
  seedWorld({ checkout: { currentStep: 'CLOSED', autoEmailedAt: new Date() } });
  db.settings.push({
    key: 'tenant:t1:kioskKeyHandoffConfig',
    value: JSON.stringify({ loc1: { mode: 'LOCKBOX', lockboxNote: 'Box 4 — code 2468' } }),
  });

  const result = await kioskCheckoutService.complete('ks1', DEVICE);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'COMPLETED');
  assert.deepEqual(result.keyHandoff, { mode: 'LOCKBOX', lockboxNote: 'Box 4 — code 2468' });
  assert.equal(result.contractEmail.sent, true); // fired on the CLOSED transition
  assert.equal(result.customerInspection.sent, false); // tenant setting off

  const session = db.sessions[0];
  assert.equal(session.outcome, 'COMPLETED');
  assert.equal(session.step, 'DONE');
  assert.ok(session.endedAt instanceof Date);
});

test('complete: defaults to STAFF handoff when no config exists', async () => {
  seedKioskSession();
  seedWorld({ checkout: { currentStep: 'CLOSED' } });
  const result = await kioskCheckoutService.complete('ks1', DEVICE);
  assert.deepEqual(result.keyHandoff, { mode: 'STAFF', lockboxNote: null });
});

// ---------------------------------------------------------------------------
// escalate enum (B3 rider) — service-level sanity beyond kiosk.test.mjs
// ---------------------------------------------------------------------------

test('escalate: every enum reason is accepted, anything else is 422', async () => {
  seedWorld();
  for (const reason of ESCALATE_REASONS) {
    installStubs();
    db.devices.push({ id: 'dev1', tenantId: 't1', locationId: 'loc1' });
    seedKioskSession();
    const result = await kioskSessionService.escalate('ks1', DEVICE, { reason });
    assert.equal(result.session.outcome, 'ESCALATED');
    assert.equal(db.sessions[0].escalatedReason, reason);
  }

  installStubs();
  seedKioskSession();
  await rejects(
    kioskSessionService.escalate('ks1', DEVICE, { reason: 'BECAUSE' }),
    { status: 422, code: 'INVALID_ESCALATE_REASON' },
  );
});

// ---------------------------------------------------------------------------
// B3a review round: M1 prod gate, M3 idempotent complete, M4 photo guard,
// S4 age parity, key-handoff admin config, deviceConnectivity
// ---------------------------------------------------------------------------

test('sandbox-payment: fail-closed in production even with the flag on (M1)', async (t) => {
  const prevNodeEnv = process.env.NODE_ENV;
  t.after(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    delete process.env.KIOSK_PAYMENT_SANDBOX_ALLOW_PROD;
  });

  seedKioskSession();
  seedWorld();
  process.env.KIOSK_PAYMENT_SANDBOX = 'true';
  process.env.NODE_ENV = 'production';

  await rejects(kioskCheckoutService.sandboxPayment('ks1', DEVICE), { status: 403, code: 'SANDBOX_DISABLED' });
  assert.equal(db.checkoutSessions[0].paymentCompletedAt, null, 'no stamp in prod without the double key');

  // explicit double key opens it (deliberate act only)
  process.env.KIOSK_PAYMENT_SANDBOX_ALLOW_PROD = 'true';
  const result = await kioskCheckoutService.sandboxPayment('ks1', DEVICE);
  assert.equal(result.sandbox, true);
});

test('verify-id: junk/oversized photos are rejected 422 BEFORE anything is written (M4)', async () => {
  seedKioskSession();
  seedWorld();

  // not an image (base64 of text) — fallback mode (storage flag unset)
  await rejects(
    kioskCheckoutService.verifyId('ks1', DEVICE, {
      aamvaFields: GOOD_SCAN,
      licensePhoto: `data:image/png;base64,${Buffer.from('not an image at all, just text').toString('base64')}`,
    }),
    { status: 422, code: 'INVALID_PHOTO' },
  );
  assert.equal(db.customers[0].idPhotoUrl, null, 'no fallback write for junk payloads');
  assert.equal(db.sessions[0].idVerifiedAt, null, 'no verify stamp on 422');

  // oversized (11MB with a valid JPEG magic header)
  const big = Buffer.alloc(11 * 1024 * 1024, 0x20);
  big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  await rejects(
    kioskCheckoutService.verifyId('ks1', DEVICE, {
      aamvaFields: GOOD_SCAN,
      selfiePhoto: `data:image/jpeg;base64,${big.toString('base64')}`,
    }),
    { status: 422, code: 'INVALID_PHOTO' },
  );
  assert.equal(db.customers[0].idPhotoUrl, null);
});

test('verify-id: valid license photo persists via the base64 fallback (validated first)', async () => {
  seedKioskSession();
  seedWorld();
  const jpeg = Buffer.alloc(4096, 0x11);
  jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff;
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

  const result = await kioskCheckoutService.verifyId('ks1', DEVICE, {
    aamvaFields: GOOD_SCAN,
    licensePhoto: dataUrl,
  });
  assert.equal(result.verified, true);
  assert.equal(db.customers[0].idPhotoUrl, dataUrl, 'validated license lands in the legacy slot');
  // F1 truth: the SERVER stamps idPhotosStoredAt when a license photo landed
  assert.ok(db.sessions[0].idPhotosStoredAt instanceof Date, 'idPhotosStoredAt stamped');
});

test('F1 idPhotosStoredAt: not stamped without a license photo (no photo / selfie only / column already filled)', async () => {
  seedKioskSession();
  seedWorld();
  const jpeg = Buffer.alloc(4096, 0x11);
  jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff;
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

  // no photo at all
  await kioskCheckoutService.verifyId('ks1', DEVICE, { aamvaFields: GOOD_SCAN });
  assert.equal(db.sessions[0].idPhotosStoredAt, undefined, 'no photo → no stamp');

  // selfie only: not a license → no stamp (fallback mode has no selfie column anyway)
  db.sessions[0].idVerifiedAt = null;
  await kioskCheckoutService.verifyId('ks1', DEVICE, { aamvaFields: GOOD_SCAN, selfiePhoto: dataUrl });
  assert.equal(db.sessions[0].idPhotosStoredAt, undefined, 'selfie only → no stamp');

  // fallback mode with the legacy column ALREADY filled: nothing is stored → honest false
  db.customers[0].idPhotoUrl = 'data:image/jpeg;base64,PRE-EXISTING';
  db.sessions[0].idVerifiedAt = null;
  await kioskCheckoutService.verifyId('ks1', DEVICE, { aamvaFields: GOOD_SCAN, licensePhoto: dataUrl });
  assert.equal(db.customers[0].idPhotoUrl, 'data:image/jpeg;base64,PRE-EXISTING', 'never clobbers');
  assert.equal(db.sessions[0].idPhotosStoredAt, undefined, 'nothing stored → no stamp');
  // a client-fed ID_PHOTOS_STORED event must not be mistaken for the stamp
  db.sessions[0].eventsJson.push({ at: 'x', step: 'ID', event: 'ID_PHOTOS_STORED', data: { storage: true } });
  assert.equal(db.sessions[0].idPhotosStoredAt, undefined);
});

test('verify-id age parity (S4): implausible DOB and configured max age get their own codes', async () => {
  seedKioskSession();
  seedWorld({
    reservation: { pickupLocation: { locationConfig: JSON.stringify({ chargeAgeMin: 21, chargeAgeMax: 75 }) } },
  });

  // garbage DOB (year 0959-style import) → DOB_IMPLAUSIBLE, not "underage"
  const implausible = await kioskCheckoutService.verifyId('ks1', DEVICE, {
    aamvaFields: { ...GOOD_SCAN, dateOfBirth: '0959-01-01' },
  });
  assert.ok(implausible.failureReasons.includes('DOB_IMPLAUSIBLE'));
  assert.ok(!implausible.failureReasons.includes('UNDERAGE'));

  // over the configured chargeAgeMax → AGE_ABOVE_MAX
  const tooOld = await kioskCheckoutService.verifyId('ks1', DEVICE, {
    aamvaFields: { ...GOOD_SCAN, dateOfBirth: '1940-01-01' },
  });
  assert.ok(tooOld.failureReasons.includes('AGE_ABOVE_MAX'));
  assert.equal(tooOld.maximumAge, 75);

  // in-range still passes with the max configured
  const fine = await kioskCheckoutService.verifyId('ks1', DEVICE, { aamvaFields: GOOD_SCAN });
  assert.equal(fine.checks.ageOk, true);
});

test('complete is idempotent (M3): retried /complete never re-creates inspections or re-emails', async () => {
  seedKioskSession();
  seedWorld({ checkout: { currentStep: 'CLOSED' } });
  // tenant has customer-led inspection ON…
  db.settings.push({ key: 'tenant:t1:customerInspectionConfig', value: JSON.stringify({ enabled: true }) });
  // …and the CHECKOUT inspection for this reservation already exists
  // (row-level dedupe mirror of the CHECKIN path).
  db.customerInspections.push({
    id: 'ci-existing', tenantId: 't1', vehicleId: 'v1', reservationId: 'res1',
    phase: 'CHECKOUT', status: 'SENT', emailTo: 'maria@example.com', sentAt: new Date(),
  });

  const first = await kioskCheckoutService.complete('ks1', DEVICE);
  assert.equal(first.outcome, 'COMPLETED');
  assert.equal(first.customerInspection.sent, false, 'deduped — nothing re-sent');
  assert.equal(db.customerInspections.length, 1, 'no duplicate inspection row');

  const second = await kioskCheckoutService.complete('ks1', DEVICE);
  assert.equal(second.ok, true);
  assert.equal(second.outcome, 'COMPLETED');
  assert.equal(second.customerInspection.sent, false);
  assert.equal(db.customerInspections.length, 1, 'retry created nothing');
  assert.equal(db.handoffTokens.length, 0, 'retry minted nothing');
});

test('key-handoff admin config: validation 422s + round-trip', async () => {
  // unknown location id → 422
  await rejects(
    kioskCheckoutService.updateKeyHandoffSettings({
      config: { 'loc-ghost': { mode: 'LOCKBOX', lockboxNote: 'x' } },
    }, { tenantId: 't1' }),
    { status: 422, code: 'UNKNOWN_LOCATION_IDS' },
  );
  // bad mode → 422
  await rejects(
    kioskCheckoutService.updateKeyHandoffSettings({
      config: { loc1: { mode: 'DRONE_DROP' } },
    }, { tenantId: 't1' }),
    { status: 422, code: 'INVALID_KEY_HANDOFF_MODE' },
  );
  // missing config → 400
  await rejects(kioskCheckoutService.updateKeyHandoffSettings({}, { tenantId: 't1' }), { status: 400 });

  const saved = await kioskCheckoutService.updateKeyHandoffSettings({
    config: {
      loc1: { mode: 'LOCKBOX', lockboxNote: 'Box 4 — code 2468' },
      default: { mode: 'STAFF', lockboxNote: 'ignored for STAFF' },
    },
  }, { tenantId: 't1' });
  assert.deepEqual(saved.config.loc1, { mode: 'LOCKBOX', lockboxNote: 'Box 4 — code 2468' });
  assert.deepEqual(saved.config.default, { mode: 'STAFF', lockboxNote: null });

  const read = await kioskCheckoutService.getKeyHandoffSettings({ tenantId: 't1' });
  assert.deepEqual(read.config, saved.config);

  // and complete() resolves the saved LOCKBOX entry for the device location
  seedKioskSession();
  seedWorld({ checkout: { currentStep: 'CLOSED' } });
  const completed = await kioskCheckoutService.complete('ks1', DEVICE);
  assert.deepEqual(completed.keyHandoff, { mode: 'LOCKBOX', lockboxNote: 'Box 4 — code 2468' });
});

test('deviceConnectivity: ONLINE within 15 min of lastSeenAt, OFFLINE past it', () => {
  const now = Date.now();
  assert.equal(deviceConnectivity({ lastSeenAt: new Date(now - 60_000) }, now), 'ONLINE');
  assert.equal(deviceConnectivity({ lastSeenAt: new Date(now - DEVICE_OFFLINE_AFTER_MS - 1) }, now), 'OFFLINE');
  assert.equal(deviceConnectivity({ lastSeenAt: null }, now), 'OFFLINE');
});

// ---------------------------------------------------------------------------
// B3b gap #2: complete() surfaces the inspection link (K8 on-screen QR)
// ---------------------------------------------------------------------------

test('complete: first completion returns customerInspection.link; retries never re-mint', async (t) => {
  seedKioskSession();
  seedWorld({ checkout: { currentStep: 'CLOSED' } });

  // Stub the real send (SMTP-free): same return shape sendCustomerInspection
  // produces on the closedSession path, including the /inspect/:token link.
  const original = customerInspectionService.sendCustomerInspection;
  const calls = [];
  customerInspectionService.sendCustomerInspection = async (args) => {
    calls.push(args);
    return {
      ok: true,
      inspectionId: 'ci-1',
      emailTo: 'maria@example.com',
      expiresAt: new Date(Date.now() + 24 * HOUR),
      link: 'http://localhost:3000/inspect/tok-abc123',
    };
  };
  t.after(() => { customerInspectionService.sendCustomerInspection = original; });

  const first = await kioskCheckoutService.complete('ks1', DEVICE);
  assert.equal(first.customerInspection.sent, true);
  assert.equal(first.customerInspection.link, 'http://localhost:3000/inspect/tok-abc123');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sessionId: 'cs1', actorUserId: null, closedSession: true });

  // retry: COMPLETED outcome short-circuits — no re-mint, no link echo
  const second = await kioskCheckoutService.complete('ks1', DEVICE);
  assert.equal(second.customerInspection.sent, false);
  assert.equal('link' in second.customerInspection, false, 'retries never expose a link');
  assert.equal(calls.length, 1, 'send path never re-invoked');
});

test('closedSession sendCustomerInspection dedupe result carries no link (complete stays linkless)', async () => {
  seedKioskSession();
  seedWorld({ checkout: { currentStep: 'CLOSED' } });
  db.settings.push({ key: 'tenant:t1:customerInspectionConfig', value: JSON.stringify({ enabled: true }) });
  db.customerInspections.push({
    id: 'ci-existing', tenantId: 't1', vehicleId: 'v1', reservationId: 'res1',
    phase: 'CHECKOUT', status: 'SENT', emailTo: 'maria@example.com', sentAt: new Date(),
  });

  const result = await kioskCheckoutService.complete('ks1', DEVICE);
  assert.equal(result.customerInspection.sent, false);
  assert.equal('link' in result.customerInspection, false);
});

// ---------------------------------------------------------------------------
// QA rider: /sign partial-failure resume (pinned regression)
// ---------------------------------------------------------------------------

test('sign resumes after a mid-cascade failure with zero double side-effects; post-CLOSED retry is 409', async (t) => {
  seedKioskSession({ idVerifiedAt: new Date() });
  seedWorld({ checkout: { paymentCompletedAt: new Date() } });

  // Inject a failure on the transition INTO FINALIZING (mid-walk, after all
  // stamps + signature but before the CLOSED cascade).
  //
  // M2-H8 (2026-08-17): the injection moved from `update` to `updateMany` —
  // transition() now commits through a conditional updateMany (compare-and-set
  // on currentStep). Same injection point in behavior terms (the write that
  // moves the step), same assertions below; only the delegate changed. Left on
  // `update` it silently stopped firing and the whole resume regression went
  // untested while still reporting green.
  const realUpdateMany = prisma.checkoutSession.updateMany;
  let failFinalizing = true;
  prisma.checkoutSession.updateMany = async (args) => {
    if (failFinalizing && args?.data?.currentStep === 'FINALIZING') {
      throw new Error('injected mid-cascade failure');
    }
    return realUpdateMany(args);
  };
  t.after(() => { prisma.checkoutSession.updateMany = realUpdateMany; });

  await assert.rejects(
    kioskCheckoutService.sign('ks1', DEVICE, {
      sectionInitials: allInitials(), signature: SIGNATURE, signerName: 'Maria Gonzalez',
    }),
    /injected mid-cascade failure/,
  );

  // Parked at a LEGAL intermediate step with every stamp intact.
  const cs = db.checkoutSessions[0];
  assert.equal(cs.currentStep, 'CUSTOMER_SIGN_PENDING', 'parked at the last successful step');
  assert.ok(cs.tcCompletedAt instanceof Date);
  assert.ok(cs.inspectionCompletedAt instanceof Date);
  assert.ok(cs.customerSignedAt instanceof Date);
  const tcStampedAt = cs.tcCompletedAt;
  const expectedSections = sectionsForAgreement({ declinedInsurance: false });
  assert.equal(db.initials.length, expectedSections.length, 'initials written once');
  assert.equal(db.mileageEntries.length, 0, 'cascade side-effects not reached yet');
  assert.equal(db.agreements[0].status, 'DRAFT');

  // Retry: resumes the walk from where it parked and reaches CLOSED.
  failFinalizing = false;
  const retry = await kioskCheckoutService.sign('ks1', DEVICE, {
    sectionInitials: allInitials(), signature: SIGNATURE, signerName: 'Maria Gonzalez',
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.checkoutSession.currentStep, 'CLOSED');
  assert.equal(cs.currentStep, 'CLOSED');

  // NO double side-effects.
  assert.equal(db.mileageEntries.length, 1, 'exactly one mileage entry');
  assert.equal(db.initials.length, expectedSections.length, 'no duplicate initials rows (upsert)');
  assert.equal(cs.tcCompletedAt, tcStampedAt, 'tcCompletedAt stamped once — retry skipped the re-stamp');
  assert.equal(db.agreements[0].status, 'FINALIZED');
  assert.equal(db.reservations[0].status, 'CHECKED_OUT');
  assert.equal(db.vehicles[0].status, 'ON_RENT');

  // Post-CLOSED crash edge: another /sign retry → 409 CHECKOUT_TERMINAL
  // (frontend routes this to /complete).
  await rejects(
    kioskCheckoutService.sign('ks1', DEVICE, { sectionInitials: allInitials(), signature: SIGNATURE }),
    { status: 409, code: 'CHECKOUT_TERMINAL' },
  );
});

// ---------------------------------------------------------------------------
// B3d: id-photo-extract (advisory OCR — primary ID path)
// ---------------------------------------------------------------------------

function jpegPhoto(bytes = 4096) {
  const buf = Buffer.alloc(bytes, 0x33);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function stubAnthropic(t, payload) {
  const prevFetch = globalThis.fetch;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevAllow = process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR;
  const calls = [];
  process.env.ANTHROPIC_API_KEY = 'env-test-key';
  // 2026-08-27: the platform key alone is no longer enough to make a call —
  // tenant t1 has to be named for this feature. These tests are about the
  // EXTRACT path, so they opt it in explicitly; the fail-closed default is
  // asserted in the "no tenant key" test below and in
  // lib/tenant-provider-credential.test.mjs.
  process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR = 't1';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
      text: async () => '',
    };
  };
  t.after(() => {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevAllow === undefined) delete process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR;
    else process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR = prevAllow;
  });
  return calls;
}

test('id-photo-extract happy path: advisory fields returned, telemetry PII-free, nothing stamped', async (t) => {
  seedKioskSession();
  seedWorld();
  const calls = stubAnthropic(t, {
    fields: {
      firstName: 'Maria', lastName: 'Gonzalez', dateOfBirth: '1990-03-15',
      licenseNumber: 'D123-456-78-901', licenseState: 'fl', licenseExpiry: '2030-01-01',
    },
    confidence: 92,
    notes: null,
  });

  const result = await kioskCheckoutService.idPhotoExtract('ks1', DEVICE, { photo: jpegPhoto() });

  assert.deepEqual(result.fields, {
    firstName: 'Maria', lastName: 'Gonzalez', dateOfBirth: '1990-03-15',
    licenseNumber: 'D123-456-78-901', licenseState: 'FL', licenseExpiry: '2030-01-01',
  });
  assert.equal(result.confidence, 92);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.attemptsRemaining, 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(JSON.parse(calls[0].options.body).model, 'claude-haiku-4-5-20251001');

  // ADVISORY: nothing stamped, nothing written to the customer
  const session = db.sessions[0];
  assert.equal(session.idVerifiedAt, null);
  assert.equal(db.customers[0].licenseNumber, null);

  // telemetry counts only — never the extracted PII
  const event = session.eventsJson.find((e) => e.event === 'ID_PHOTO_EXTRACT');
  assert.deepEqual(event.data, { ok: true, nullFields: 0, confidence: 92 });
  assert.ok(!JSON.stringify(session.eventsJson).includes('Gonzalez'));
});

test('id-photo-extract: unreadable fields pass through as nulls with warnings', async (t) => {
  seedKioskSession();
  seedWorld();
  stubAnthropic(t, {
    fields: {
      firstName: 'Maria', lastName: null, dateOfBirth: null,
      licenseNumber: null, licenseState: null, licenseExpiry: null,
    },
    confidence: 35,
    notes: 'photo is blurry; only the given name is legible',
  });

  const result = await kioskCheckoutService.idPhotoExtract('ks1', DEVICE, { photo: jpegPhoto() });
  assert.equal(result.fields.firstName, 'Maria');
  assert.equal(result.fields.lastName, null);
  assert.equal(result.fields.licenseExpiry, null);
  assert.ok(result.warnings.includes('UNREADABLE_FIELDS'));
  assert.ok(result.warnings.includes('LOW_CONFIDENCE'));
  assert.equal(db.sessions[0].eventsJson.at(-1).data.nullFields, 5);
});

test('id-photo-extract: cost cap at 5 → 429 EXTRACT_LIMIT + escalateSuggested, provider never called', async (t) => {
  seedKioskSession({
    eventsJson: Array.from({ length: 5 }, () => ({ at: 'x', step: 'ID', event: 'ID_PHOTO_EXTRACT', data: { ok: true } })),
  });
  seedWorld();
  const calls = stubAnthropic(t, {});

  const err = await rejects(
    kioskCheckoutService.idPhotoExtract('ks1', DEVICE, { photo: jpegPhoto() }),
    { status: 429, code: 'EXTRACT_LIMIT' },
  );
  assert.equal(err.details.escalateSuggested, true);
  assert.equal(calls.length, 0, 'no provider call past the cap');
});

test('id-photo-extract: no tenant key → 503 OCR_UNAVAILABLE even WITH a platform key in env; junk photo → 422; binding 404', async (t) => {
  // 2026-08-27, strengthened. This used to delete ANTHROPIC_API_KEY to reach
  // the 503, which only proved "no key anywhere". The guarantee now is bigger:
  // the platform key is present and usable, and a tenant nobody opted in STILL
  // sends no driver's licence photo to a third party. (Same defect class as the
  // Corpusa citation-OCR incident.)
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevAllow = process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR;
  process.env.ANTHROPIC_API_KEY = 'env-test-key';
  delete process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR;
  const prevFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; throw new Error('must not be called'); };
  t.after(() => {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevAllow !== undefined) process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR = prevAllow;
  });

  seedKioskSession();
  seedWorld();

  await rejects(
    kioskCheckoutService.idPhotoExtract('ks1', DEVICE, { photo: jpegPhoto() }),
    { status: 503, code: 'OCR_UNAVAILABLE' },
  );

  // junk photo rejected BEFORE any key/provider logic
  await rejects(
    kioskCheckoutService.idPhotoExtract('ks1', DEVICE, {
      photo: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`,
    }),
    { status: 422, code: 'INVALID_PHOTO' },
  );
  await rejects(
    kioskCheckoutService.idPhotoExtract('ks1', DEVICE, {}),
    { status: 422, code: 'MISSING_PHOTO' },
  );

  // session-device binding like every other endpoint
  await rejects(
    kioskCheckoutService.idPhotoExtract('ks1', { ...DEVICE, id: 'dev2' }, { photo: jpegPhoto() }),
    { status: 404, code: 'SESSION_NOT_FOUND' },
  );
  assert.equal(called, 0);
});

test('id-photo-extract: provider failure burns an attempt and returns 502 with attemptsRemaining', async (t) => {
  seedKioskSession();
  seedWorld();
  const prevFetch = globalThis.fetch;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevAllow = process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR;
  process.env.ANTHROPIC_API_KEY = 'env-test-key';
  process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR = 't1'; // opted in — see stubAnthropic
  globalThis.fetch = async () => ({ ok: false, status: 529, json: async () => ({}), text: async () => 'overloaded' });
  t.after(() => {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevAllow === undefined) delete process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR;
    else process.env.PLATFORM_KEY_ALLOW_KIOSK_ID_OCR = prevAllow;
  });

  const err = await rejects(
    kioskCheckoutService.idPhotoExtract('ks1', DEVICE, { photo: jpegPhoto() }),
    { status: 502, code: 'EXTRACT_FAILED' },
  );
  assert.equal(err.details.attemptsRemaining, 4);
  assert.deepEqual(db.sessions[0].eventsJson.at(-1).data, { ok: false }, 'failed attempt still counted');
});

// ---------------------------------------------------------------------------
// B3c/B3d review M1: the OCR cap cannot be evaded
// ---------------------------------------------------------------------------

test('id-photo-extract M1: a full eventsJson (frozen counter) fails CLOSED — 429, provider never called', async (t) => {
  seedKioskSession({
    // filling the event log via POST /events used to freeze the extract
    // count below 5 → unlimited provider calls
    eventsJson: Array.from({ length: MAX_SESSION_EVENTS }, (_, i) => ({ at: 'x', step: 'ID', event: `SPAM_${i}`, data: null })),
  });
  seedWorld();
  const calls = stubAnthropic(t, {});

  const err = await rejects(
    kioskCheckoutService.idPhotoExtract('ks1', DEVICE, { photo: jpegPhoto() }),
    { status: 429, code: 'EXTRACT_LIMIT' },
  );
  assert.equal(err.details.escalateSuggested, true);
  assert.equal(calls.length, 0, 'provider never called with a frozen counter');
});

test('id-photo-extract M1: extraction requires an attached reservation (kills mint-and-extract)', async (t) => {
  seedKioskSession({ reservationId: null });
  seedWorld();
  const calls = stubAnthropic(t, {});

  await rejects(
    kioskCheckoutService.idPhotoExtract('ks1', DEVICE, { photo: jpegPhoto() }),
    { status: 422, code: 'NO_RESERVATION_ATTACHED' },
  );
  assert.equal(calls.length, 0);
});

test('id-photo-extract M1: per-DEVICE hourly bucket caps across sessions; fresh device unaffected', async (t) => {
  seedWorld();
  const payload = {
    fields: { firstName: 'M', lastName: 'G', dateOfBirth: '1990-03-15', licenseNumber: 'D1', licenseState: 'FL', licenseExpiry: '2030-01-01' },
    confidence: 90,
    notes: null,
  };
  const calls = stubAnthropic(t, payload);

  // burn the device budget across fresh sessions (mint-burn-repeat)
  const sessionsNeeded = Math.ceil(MAX_ID_EXTRACTS_PER_DEVICE_PER_HOUR / MAX_ID_EXTRACTS_PER_SESSION);
  for (let s = 0; s < sessionsNeeded; s += 1) {
    seedKioskSession({ id: `ksA${s}` });
    for (let i = 0; i < MAX_ID_EXTRACTS_PER_SESSION; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await kioskCheckoutService.idPhotoExtract(`ksA${s}`, DEVICE, { photo: jpegPhoto() });
    }
  }
  assert.equal(calls.length, MAX_ID_EXTRACTS_PER_DEVICE_PER_HOUR);

  // a brand-new session on the SAME device is now capped — per-session slots don't help
  seedKioskSession({ id: 'ksFresh' });
  const err = await rejects(
    kioskCheckoutService.idPhotoExtract('ksFresh', DEVICE, { photo: jpegPhoto() }),
    { status: 429, code: 'EXTRACT_LIMIT' },
  );
  assert.equal(err.details.escalateSuggested, true);
  assert.equal(calls.length, MAX_ID_EXTRACTS_PER_DEVICE_PER_HOUR, 'no provider call past the device budget');

  // a DIFFERENT device at the counter still works
  seedKioskSession({ id: 'ksDev2', deviceId: 'dev2' });
  const result = await kioskCheckoutService.idPhotoExtract('ksDev2', { ...DEVICE, id: 'dev2' }, { photo: jpegPhoto() });
  assert.equal(result.fields.firstName, 'M');
  assert.equal(calls.length, MAX_ID_EXTRACTS_PER_DEVICE_PER_HOUR + 1);
});

// ---------------------------------------------------------------------------
// B3e L1: token-subset matcher — canonical suite (Hector's real FL case)
// ---------------------------------------------------------------------------

test('namesMatch B3e canonical: FL license "PADILLA LUNA HECTOR EDUARDO JR" matches stored "Hector Padilla" under BOTH OCR splits', () => {
  const stored = { storedFirst: 'Hector', storedLast: 'Padilla' };
  // split A: OCR read the given names into firstName
  assert.equal(namesMatch({ scannedFirst: 'HECTOR EDUARDO JR', scannedLast: 'PADILLA LUNA', ...stored }), true);
  // split B: FL fronts read surname-first — fields swapped by the OCR
  assert.equal(namesMatch({ scannedFirst: 'PADILLA LUNA', scannedLast: 'HECTOR EDUARDO JR', ...stored }), true);
  // suffix stripped, accents tolerated
  assert.equal(namesMatch({ scannedFirst: 'HÉCTOR EDUARDO', scannedLast: 'PADILLA LUNA JR', ...stored }), true);
});

test('namesMatch B3e negative controls: wrong person never rides the token pool', () => {
  const license = { scannedFirst: 'HECTOR EDUARDO JR', scannedLast: 'PADILLA LUNA' };
  // Maria ∉ pool → NO_MATCH even though Padilla matches
  assert.equal(namesMatch({ ...license, storedFirst: 'Maria', storedLast: 'Padilla' }), false);
  // completely different person
  assert.equal(namesMatch({ ...license, storedFirst: 'Juan', storedLast: 'Rivera' }), false);
  // family false-accept control: two surname hits but wrong given name
  assert.equal(namesMatch({
    scannedFirst: 'PEDRO', scannedLast: 'GONZALEZ RIVERA',
    storedFirst: 'Maria', storedLast: 'Gonzalez Rivera',
  }), false);
  // single-token safety rail: a lone repeated token must not match a license
  // that merely CONTAINS it
  assert.equal(namesMatch({ ...license, storedFirst: 'Hector', storedLast: 'Hector' }), false);
});

test('verify-id stamps the server-side nameMismatchAt marker ONLY on a name-only failure', async () => {
  seedKioskSession();
  seedWorld();
  const session = db.sessions[0];

  // name mismatch with rules passing → marker set
  await kioskCheckoutService.verifyId('ks1', DEVICE, {
    aamvaFields: { ...GOOD_SCAN, firstName: 'Pedro', lastName: 'Rivera' },
  });
  assert.ok(session.nameMismatchAt instanceof Date, 'marker stamped');

  // mixed failure (underage too) does NOT refresh eligibility semantics —
  // marker only set when NAME_MISMATCH is the lone reason
  session.nameMismatchAt = null;
  await kioskCheckoutService.verifyId('ks1', DEVICE, {
    aamvaFields: { ...GOOD_SCAN, firstName: 'Pedro', lastName: 'Rivera', dateOfBirth: new Date(Date.now() - 18 * 365 * 24 * HOUR).toISOString() },
  });
  assert.equal(session.nameMismatchAt, null, 'mixed failures never stamp the marker');

  // a later PASSING verify clears it
  session.nameMismatchAt = new Date();
  await kioskCheckoutService.verifyId('ks1', DEVICE, { aamvaFields: GOOD_SCAN });
  assert.equal(session.nameMismatchAt, null, 'cleared on pass');
});
