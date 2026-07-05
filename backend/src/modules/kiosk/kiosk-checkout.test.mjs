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
} from './kiosk-checkout.service.js';
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
    handoffTokens: [], customers: [],
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
  const realUpdate = prisma.checkoutSession.update;
  let failFinalizing = true;
  prisma.checkoutSession.update = async (args) => {
    if (failFinalizing && args?.data?.currentStep === 'FINALIZING') {
      throw new Error('injected mid-cascade failure');
    }
    return realUpdate(args);
  };
  t.after(() => { prisma.checkoutSession.update = realUpdate; });

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
