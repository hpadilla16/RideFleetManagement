/**
 * Ride Kiosk — Fase B3e L2 tests (self-service verified-name update).
 * Run: npm run test:kiosk  (node --test --test-force-exit)
 *
 * The code email goes through the REAL mailer via the MailerSend HTTP path
 * with a stubbed fetch (the possession code is captured from the intercepted
 * payload — it is hashed at rest, so the email is the only place to read it,
 * exactly like production). SMS is monkeypatched (tenant-config dependent).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { KioskError } from './kiosk-device.service.js';
import {
  kioskNameUpdateService,
  NAME_UPDATE_CODE_TTL_MIN,
  MAX_NAME_UPDATE_SENDS_PER_DEVICE_PER_HOUR,
  resetNameUpdateSendTracking,
  maskEmail,
  maskPhone,
} from './kiosk-name-update.service.js';
import { MAX_LOOKUP_MISSES } from './kiosk-session.service.js';
import { smsService } from '../sms/sms.service.js';

// ---------------------------------------------------------------------------
// Harness (kiosk suite family)
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
  db = { devices: [], sessions: [], reservations: [], customers: [], auditLogs: [], settings: [] };
  Object.assign(prisma.kioskDevice, delegateStub(() => db.devices));
  Object.assign(prisma.kioskSession, delegateStub(() => db.sessions));
  Object.assign(prisma.reservation, delegateStub(() => db.reservations));
  Object.assign(prisma.customer, delegateStub(() => db.customers));
  Object.assign(prisma.auditLog, delegateStub(() => db.auditLogs));
  Object.assign(prisma.appSetting, delegateStub(() => db.settings));
  prisma.$transaction = async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma));
}

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const DEVICE = { id: 'dev1', tenantId: 't1', locationId: 'loc1', name: 'Lobby 1', walkupEnabled: true };

function jpegPhoto(bytes = 4096) {
  const buf = Buffer.alloc(bytes, 0x44);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
const PHOTO = jpegPhoto();

const LICENSE_FIELDS = {
  firstName: 'Hector Eduardo',
  lastName: 'Padilla Luna',
  dateOfBirth: '1990-03-15',
  licenseNumber: 'P123-456-78-901',
  licenseState: 'FL',
  licenseExpiry: new Date(Date.now() + 2 * 365 * 24 * HOUR).toISOString(),
};

function seedDeviceRow(overrides = {}) {
  const device = {
    id: 'dev1', tenantId: 't1', locationId: 'loc1', name: 'Lobby 1',
    tokenHash: 'th', status: 'ACTIVE', walkupEnabled: true,
    pairingAttempts: 0, lookupMisses: 0, lookupLockedUntil: null,
    lastSeenAt: new Date(),
    ...overrides,
  };
  db.devices.push(device);
  return device;
}

function seedSession(overrides = {}) {
  const session = {
    id: 'ks1', tenantId: 't1', deviceId: 'dev1', kind: 'PICKUP',
    reservationId: 'res1', checkoutSessionId: 'cs1', step: 'ID',
    outcome: 'IN_PROGRESS', escalatedReason: null, eventsJson: [],
    idVerifiedAt: null, idVerifyMethod: null,
    nameMismatchAt: new Date(), nameUpdateCodeHash: null, nameUpdateCodeExpiresAt: null,
    assistUserId: null, assistGrantedAt: null,
    lastActivityAt: new Date(), startedAt: new Date(), endedAt: null,
    ...overrides,
  };
  db.sessions.push(session);
  return session;
}

function seedWorld({ customer = {} } = {}) {
  const cust = {
    id: 'cust1', tenantId: 't1', firstName: 'Maria', lastName: 'Gonzalez',
    email: 'maria@example.com', phone: '+1 407 555 1234',
    address1: '123 Main St', address2: null, city: 'Orlando', state: 'FL', zip: '32801', country: 'US', locale: 'es',
    licenseNumber: null, licenseState: null, dateOfBirth: null, idPhotoUrl: null,
    ...customer,
  };
  db.customers.push(cust);
  db.reservations.push({
    id: 'res1', tenantId: 't1', reservationNumber: 'RES-100200', status: 'CONFIRMED',
    workflowMode: 'RENTAL', pickupLocationId: 'loc1', customerId: cust.id,
    pickupAt: new Date(Date.now() + 2 * HOUR), returnAt: new Date(Date.now() + 50 * HOUR),
    pickupLocation: { locationConfig: JSON.stringify({ chargeAgeMin: 21 }) },
    customer: cust,
  });
  return cust;
}

function stubMailAndSms(t, { smsWorks = false } = {}) {
  const prevFetch = globalThis.fetch;
  const prevKey = process.env.MAILERSEND_API_KEY;
  const prevFrom = process.env.MAILERSEND_FROM;
  process.env.MAILERSEND_API_KEY = 'test-key';
  process.env.MAILERSEND_FROM = 'no-reply@test.local';
  const emails = [];
  globalThis.fetch = async (url, options) => {
    emails.push(JSON.parse(options.body));
    return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
  };
  const prevSms = smsService.sendCustom;
  const smsCalls = [];
  smsService.sendCustom = async (args) => {
    if (!smsWorks) throw new Error('SMS not configured for tenant');
    smsCalls.push(args);
    return { ok: true };
  };
  t.after(() => {
    globalThis.fetch = prevFetch;
    smsService.sendCustom = prevSms;
    if (prevKey === undefined) delete process.env.MAILERSEND_API_KEY; else process.env.MAILERSEND_API_KEY = prevKey;
    if (prevFrom === undefined) delete process.env.MAILERSEND_FROM; else process.env.MAILERSEND_FROM = prevFrom;
  });
  return { emails, smsCalls, codeFromLastEmail: () => emails.at(-1)?.text?.match(/(\d{6})/)?.[1] };
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
  resetNameUpdateSendTracking();
});

// ---------------------------------------------------------------------------

test('maskEmail / maskPhone never leak the destination', () => {
  assert.equal(maskEmail('hector@gmail.com'), 'h•••@gmail.com');
  assert.equal(maskEmail(''), null);
  assert.equal(maskPhone('+1 407 555 1234'), '•••1234');
  assert.equal(maskPhone('12'), null);
});

test('send-code: requires the server-recorded name-mismatch marker; masked destinations only', async (t) => {
  seedDeviceRow();
  seedWorld();
  const { emails } = stubMailAndSms(t);

  // no marker → not eligible (forged eventsJson can never open this)
  seedSession({ id: 'ksNoMark', nameMismatchAt: null });
  await rejects(
    kioskNameUpdateService.sendCode('ksNoMark', DEVICE),
    { status: 409, code: 'NAME_UPDATE_NOT_ELIGIBLE' },
  );
  assert.equal(emails.length, 0);

  const session = seedSession();
  const result = await kioskNameUpdateService.sendCode('ks1', DEVICE);

  assert.deepEqual(result.sent, { email: 'm•••@example.com', sms: null });
  assert.equal(result.expiresInMinutes, NAME_UPDATE_CODE_TTL_MIN);
  assert.ok(!JSON.stringify(result).includes('maria@example.com'), 'full email never leaves the server');
  assert.ok(session.nameUpdateCodeHash, 'code hashed at rest');
  assert.ok(!JSON.stringify(session).includes(emails.at(-1).text.match(/(\d{6})/)[1]), 'plaintext code not on the row');
  assert.equal(emails.length, 1);
});

test('confirm happy path: possession code → license-verified rename (in place for single-use customer) + audit + stamp', async (t) => {
  seedDeviceRow();
  const cust = seedWorld();
  const session = seedSession();
  const { codeFromLastEmail } = stubMailAndSms(t);

  await kioskNameUpdateService.sendCode('ks1', DEVICE);
  const code = codeFromLastEmail();

  const result = await kioskNameUpdateService.confirm('ks1', DEVICE, { code, fields: LICENSE_FIELDS, licensePhoto: PHOTO });

  assert.equal(result.verified, true);
  assert.equal(result.session.idVerifyMethod, 'SCAN_NAME_UPDATED');
  // in-place rename (customer has no other reservations)
  assert.equal(cust.firstName, 'Hector Eduardo');
  assert.equal(cust.lastName, 'Padilla Luna');
  assert.equal(db.customers.length, 1, 'no clone for a single-use customer');
  // license write-through (empty columns)
  assert.equal(cust.licenseNumber, 'P123-456-78-901');
  // stamp + marker cleared + code consumed
  assert.ok(session.idVerifiedAt instanceof Date);
  assert.equal(session.idVerifyMethod, 'SCAN_NAME_UPDATED');
  assert.equal(session.nameMismatchAt, null);
  assert.equal(session.nameUpdateCodeHash, null);
  // audit carries old + new names
  const audit = db.auditLogs.find((row) => String(row.metadata || '').includes('KIOSK_NAME_UPDATE'));
  assert.ok(audit);
  const meta = JSON.parse(audit.metadata);
  assert.equal(meta.oldName, 'Maria Gonzalez');
  assert.equal(meta.newName, 'Hector Eduardo Padilla Luna');
  assert.equal(meta.relinked, false);
});

test('confirm: shared customer history → clone-and-relink, original identity untouched', async (t) => {
  seedDeviceRow();
  const cust = seedWorld();
  // the customer has ANOTHER reservation — shared identity
  db.reservations.push({ id: 'res2', tenantId: 't1', customerId: cust.id, reservationNumber: 'RES-OTHER' });
  const session = seedSession();
  const { codeFromLastEmail } = stubMailAndSms(t);

  await kioskNameUpdateService.sendCode('ks1', DEVICE);
  await kioskNameUpdateService.confirm('ks1', DEVICE, { code: codeFromLastEmail(), fields: LICENSE_FIELDS, licensePhoto: PHOTO });

  assert.equal(cust.firstName, 'Maria', 'shared customer row NEVER mutated');
  assert.equal(db.customers.length, 2, 'clone created');
  const clone = db.customers[1];
  assert.equal(clone.firstName, 'Hector Eduardo');
  assert.equal(clone.email, 'maria@example.com', 'contact copied');
  assert.equal(db.reservations[0].customerId, clone.id, 'THIS reservation relinked');
  assert.equal(db.reservations[1].customerId, cust.id, 'other booking untouched');
  const meta = JSON.parse(db.auditLogs.find((r) => String(r.metadata || '').includes('KIOSK_NAME_UPDATE')).metadata);
  assert.equal(meta.relinked, true);
  assert.ok(session.idVerifiedAt instanceof Date);
});

test('confirm: wrong code ×5 → shared device lock; expired and unsent codes have distinct codes', async (t) => {
  const device = seedDeviceRow();
  seedWorld();
  const session = seedSession();
  const { codeFromLastEmail } = stubMailAndSms(t);

  // no code sent yet
  await rejects(
    kioskNameUpdateService.confirm('ks1', DEVICE, { code: '111111', fields: LICENSE_FIELDS }),
    { status: 409, code: 'CODE_NOT_SENT' },
  );

  await kioskNameUpdateService.sendCode('ks1', DEVICE);
  const realCode = codeFromLastEmail();
  const wrongCode = realCode === '000000' ? '000001' : '000000';

  for (let i = 0; i < MAX_LOOKUP_MISSES; i += 1) {
    const err = await rejects(
      kioskNameUpdateService.confirm('ks1', DEVICE, { code: wrongCode, fields: LICENSE_FIELDS }),
      { status: 401, code: 'INVALID_CODE' },
    );
    assert.equal(err.details.attemptsRemaining, MAX_LOOKUP_MISSES - i - 1);
  }
  assert.ok(device.lookupLockedUntil instanceof Date, 'device locked via the shared counter');
  await rejects(
    kioskNameUpdateService.confirm('ks1', DEVICE, { code: realCode, fields: LICENSE_FIELDS }),
    { status: 429, code: 'NAME_UPDATE_LOCKED' },
  );
  await rejects(kioskNameUpdateService.sendCode('ks1', DEVICE), { status: 429, code: 'NAME_UPDATE_LOCKED' });

  // expired code
  device.lookupLockedUntil = null;
  device.lookupMisses = 0;
  session.nameUpdateCodeExpiresAt = new Date(Date.now() - 1 * MIN);
  await rejects(
    kioskNameUpdateService.confirm('ks1', DEVICE, { code: realCode, fields: LICENSE_FIELDS }),
    { status: 410, code: 'CODE_EXPIRED' },
  );
});

test('confirm: code is single-use, and a valid code NEVER relaxes the rules (underage hard stop, no rename)', async (t) => {
  seedDeviceRow();
  const cust = seedWorld();
  const session = seedSession();
  const { codeFromLastEmail } = stubMailAndSms(t);

  await kioskNameUpdateService.sendCode('ks1', DEVICE);
  const code = codeFromLastEmail();

  const underage = await kioskNameUpdateService.confirm('ks1', DEVICE, {
    code,
    fields: { ...LICENSE_FIELDS, dateOfBirth: new Date(Date.now() - 18 * 365 * 24 * HOUR).toISOString() },
    licensePhoto: PHOTO,
  });
  assert.equal(underage.verified, false);
  assert.ok(underage.failureReasons.includes('UNDERAGE'));
  assert.equal(cust.firstName, 'Maria', 'no rename on rule failure');
  assert.equal(session.idVerifiedAt, null, 'no stamp');
  assert.equal(session.nameUpdateCodeHash, null, 'code consumed even on rule failure');

  // the consumed code cannot be replayed
  await rejects(
    kioskNameUpdateService.confirm('ks1', DEVICE, { code, fields: LICENSE_FIELDS, licensePhoto: PHOTO }),
    { status: 409, code: 'CODE_NOT_SENT' },
  );
});

test('send-code: SMS rides along only when the tenant channel works (masked)', async (t) => {
  seedDeviceRow();
  seedWorld();
  seedSession();
  const { smsCalls } = stubMailAndSms(t, { smsWorks: true });

  const result = await kioskNameUpdateService.sendCode('ks1', DEVICE);
  assert.deepEqual(result.sent, { email: 'm•••@example.com', sms: '•••1234' });
  assert.equal(smsCalls.length, 1);
  assert.ok(!JSON.stringify(result).includes('407'), 'full phone never leaves the server');
});

test('destinations: read-only masked preview — same gate as send-code, nothing written, binding enforced', async () => {
  seedDeviceRow();
  seedWorld();
  const session = seedSession();

  const result = await kioskNameUpdateService.destinations('ks1', DEVICE);
  assert.deepEqual(result, { email: 'm•••@example.com', sms: '•••1234' });

  // masks ONLY — no full contact anywhere in the response
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('maria@example.com'));
  assert.ok(!serialized.includes('407 555') && !serialized.includes('4075551234') && !serialized.includes('555'));

  // READ-ONLY: no code minted, nothing stamped, no telemetry burned
  assert.equal(session.nameUpdateCodeHash, null);
  assert.equal(session.nameUpdateCodeExpiresAt, null);
  assert.equal(session.eventsJson.length, 0);

  // gate: no server-recorded nameMismatchAt → 409
  seedSession({ id: 'ksNoMark', nameMismatchAt: null });
  await rejects(
    kioskNameUpdateService.destinations('ksNoMark', DEVICE),
    { status: 409, code: 'NAME_UPDATE_NOT_ELIGIBLE' },
  );

  // session-device binding like every other endpoint
  await rejects(
    kioskNameUpdateService.destinations('ks1', { ...DEVICE, id: 'dev2' }),
    { status: 404, code: 'SESSION_NOT_FOUND' },
  );

  // customer without a phone → sms null (email still masked)
  installStubs();
  seedDeviceRow();
  seedWorld({ customer: { phone: '' } });
  seedSession();
  const noPhone = await kioskNameUpdateService.destinations('ks1', DEVICE);
  assert.deepEqual(noPhone, { email: 'm•••@example.com', sms: null });
});

// ---------------------------------------------------------------------------
// B3e review round: M1 send brakes, R1 eligibility, R2 no-burn 404, R3 photo
// ---------------------------------------------------------------------------

test('M1(a): per-device hourly send budget — 7th send is 429 with the mailer called at most 6 times', async (t) => {
  seedDeviceRow();
  seedWorld();
  const session = seedSession();
  const { emails } = stubMailAndSms(t);

  for (let i = 0; i < MAX_NAME_UPDATE_SENDS_PER_DEVICE_PER_HOUR; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await kioskNameUpdateService.sendCode('ks1', DEVICE);
    // age the fresh code past the cooldown window so only the BUCKET brakes
    session.nameUpdateCodeExpiresAt = new Date(Date.now() + (NAME_UPDATE_CODE_TTL_MIN - 2) * 60 * 1000);
  }
  assert.equal(emails.length, MAX_NAME_UPDATE_SENDS_PER_DEVICE_PER_HOUR);

  await rejects(kioskNameUpdateService.sendCode('ks1', DEVICE), { status: 429, code: 'NAME_UPDATE_LOCKED' });
  assert.equal(emails.length, MAX_NAME_UPDATE_SENDS_PER_DEVICE_PER_HOUR, 'no email past the budget');

  // the budget is per DEVICE — a fresh session on the same tablet is capped too
  seedSession({ id: 'ksFresh' });
  await rejects(kioskNameUpdateService.sendCode('ksFresh', DEVICE), { status: 429, code: 'NAME_UPDATE_LOCKED' });
  assert.equal(emails.length, MAX_NAME_UPDATE_SENDS_PER_DEVICE_PER_HOUR);
});

test('M1(b): server-side resend cooldown while the code is fresh → 429 with retryInSeconds', async (t) => {
  seedDeviceRow();
  seedWorld();
  seedSession();
  const { emails } = stubMailAndSms(t);

  await kioskNameUpdateService.sendCode('ks1', DEVICE);
  const err = await rejects(kioskNameUpdateService.sendCode('ks1', DEVICE), { status: 429, code: 'NAME_UPDATE_COOLDOWN' });
  assert.ok(err.details.retryInSeconds >= 1 && err.details.retryInSeconds <= 60, `retryInSeconds hint (${err.details.retryInSeconds})`);
  assert.equal(emails.length, 1, 'cooldown blocked the resend');
});

test('R1: an already-verified session is not name-update eligible', async () => {
  seedDeviceRow();
  seedWorld();
  seedSession({ idVerifiedAt: new Date(), idVerifyMethod: 'SCAN' });

  await rejects(kioskNameUpdateService.sendCode('ks1', DEVICE), { status: 409, code: 'NAME_UPDATE_NOT_ELIGIBLE' });
  await rejects(kioskNameUpdateService.destinations('ks1', DEVICE), { status: 409, code: 'NAME_UPDATE_NOT_ELIGIBLE' });
});

test('R2: a 404 on the reservation fetch never burns a valid code', async (t) => {
  seedDeviceRow();
  seedWorld();
  const session = seedSession();
  const { codeFromLastEmail } = stubMailAndSms(t);

  await kioskNameUpdateService.sendCode('ks1', DEVICE);
  const code = codeFromLastEmail();

  // reservation vanishes (cancel/wipe race) → 404, code intact
  const resvRow = db.reservations.pop();
  await rejects(
    kioskNameUpdateService.confirm('ks1', DEVICE, { code, fields: LICENSE_FIELDS, licensePhoto: PHOTO }),
    { status: 404, code: 'RESERVATION_NOT_FOUND' },
  );
  assert.ok(session.nameUpdateCodeHash, 'code NOT consumed by the 404');

  // reservation back → the same code still works
  db.reservations.push(resvRow);
  const result = await kioskNameUpdateService.confirm('ks1', DEVICE, { code, fields: LICENSE_FIELDS, licensePhoto: PHOTO });
  assert.equal(result.verified, true);
});

test('R3: confirm without the license photo → 422 MISSING_PHOTO, code intact', async (t) => {
  seedDeviceRow();
  seedWorld();
  const session = seedSession();
  const { codeFromLastEmail } = stubMailAndSms(t);

  await kioskNameUpdateService.sendCode('ks1', DEVICE);
  const code = codeFromLastEmail();

  await rejects(
    kioskNameUpdateService.confirm('ks1', DEVICE, { code, fields: LICENSE_FIELDS }),
    { status: 422, code: 'MISSING_PHOTO' },
  );
  assert.ok(session.nameUpdateCodeHash, 'photo 422 never burns the code');
  assert.equal(session.idVerifiedAt, null);
});
