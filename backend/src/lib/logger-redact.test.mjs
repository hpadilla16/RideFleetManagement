/**
 * Unit tests for redactSensitive() (beta.116 PII hardening + the 2026-06-10
 * conditional-`name` fix).
 *
 * The 2026-06-10 change: a bare `name`/`fullName` key is only redacted when
 * the SAME object carries another person-identifying key (email, phone, dob,
 * license, ssn, customerId...). Non-person names (vehicle/tenant/location
 * display names) must pass through so prod logs stay readable.
 *
 * Run: npm run test:logger
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import winston from 'winston';
import logger, { redactSensitive } from './logger.js';

const REDACTED = '[redacted]';

// ── 2026-07-16 PII-in-log-MESSAGE hardening ────────────────────────────────
// redactSensitive() only sees the META object. The Winston `redactFormat`
// scrubs meta by KEY; it does NOT scrub the human-readable message string
// (beyond base64 blobs). So PII interpolated into a message template literal
// reaches the log in cleartext. These helpers drive the REAL logger through a
// capture transport so we assert the actual end-to-end behavior, not a
// reimplementation of it.
function captureLogEntry(fn) {
  const entries = [];
  class CaptureTransport extends winston.Transport {
    log(info, next) { entries.push(info); next(); }
  }
  const capture = new CaptureTransport();
  // Mute the real Console transport so the assertions below don't spam output.
  const previouslySilent = logger.transports.map((t) => t.silent);
  logger.transports.forEach((t) => { t.silent = true; });
  logger.add(capture);
  try {
    fn();
  } finally {
    logger.remove(capture);
    logger.transports.forEach((t, i) => { t.silent = previouslySilent[i]; });
  }
  return entries[0];
}

test('person object: name redacted when email is present', () => {
  const out = redactSensitive({ name: 'Juan del Pueblo', email: 'juan@x.com' });
  assert.equal(out.name, REDACTED);
  assert.equal(out.email, REDACTED);
});

test('person object: fullName redacted when phone is present', () => {
  const out = redactSensitive({ fullName: 'Juan del Pueblo', phone: '787-555-1234' });
  assert.equal(out.fullName, REDACTED);
  assert.equal(out.phone, REDACTED);
});

test('person object: name redacted when customerId is present', () => {
  const out = redactSensitive({ customerId: 'cus_123', name: 'Juan del Pueblo' });
  assert.equal(out.name, REDACTED);
  assert.equal(out.customerId, 'cus_123'); // the id itself is not PII
});

test('vehicle-like object: name passes through (no person context)', () => {
  const out = redactSensitive({ name: '2024 Toyota Corolla', plate: 'ABC-123', vehicleId: 'veh_1' });
  assert.equal(out.name, '2024 Toyota Corolla');
  assert.equal(out.plate, 'ABC-123');
});

test('tenant-like object: bare name passes through', () => {
  const out = redactSensitive({ name: 'International Rental Corp' });
  assert.equal(out.name, 'International Rental Corp');
});

test('unconditional keys still always redacted', () => {
  const out = redactSensitive({
    email: 'a@b.com', phone: '1', dob: '2000-01-01',
    licenseNumber: 'L123', ssn: '000-00-0000', password: 'hunter2',
    firstName: 'Juan', lastName: 'Pueblo', cardOnFileToken: 'tok_1',
  });
  for (const k of Object.keys(out)) assert.equal(out[k], REDACTED, `key ${k}`);
});

test('context is per-object, not inherited by siblings', () => {
  const out = redactSensitive({
    customer: { name: 'Juan del Pueblo', phone: '787-555-1234' },
    vehicle: { name: '2024 Toyota Corolla' },
  });
  assert.equal(out.customer.name, REDACTED);
  assert.equal(out.vehicle.name, '2024 Toyota Corolla');
});

test('arrays of person objects are redacted element-wise', () => {
  const out = redactSensitive([
    { name: 'Juan', email: 'j@x.com' },
    { name: 'Fleet North Lot' },
  ]);
  assert.equal(out[0].name, REDACTED);
  assert.equal(out[1].name, 'Fleet North Lot');
});

test('null values under redact keys stay null', () => {
  const out = redactSensitive({ email: null, name: null });
  assert.equal(out.email, null);
  assert.equal(out.name, null);
});

test('data URLs / long base64 strings are truncated', () => {
  const dataUrl = `data:image/jpeg;base64,${'A'.repeat(600)}`;
  const bare = 'B'.repeat(600);
  const out = redactSensitive({ photo: dataUrl, blob: bare, short: 'ok' });
  assert.match(out.photo, /^\[base64 image \d+ bytes redacted\]$/);
  assert.match(out.blob, /^\[base64 image \d+ bytes redacted\]$/);
  assert.equal(out.short, 'ok');
});

// ── The two halves of the PII-in-logs contract ─────────────────────────────

test('logger: an email passed as a META key is masked end-to-end', () => {
  const entry = captureLogEntry(() => {
    logger.info('[email-agreement] sent', { agreementId: 'agr-1', email: 'juan@example.com' });
  });
  assert.equal(entry.email, REDACTED, 'meta key `email` must be masked by redactFormat');
  assert.equal(entry.agreementId, 'agr-1', 'non-PII meta must survive for debuggability');
  assert.doesNotMatch(
    JSON.stringify(entry), /juan@example\.com/,
    'the address must not survive anywhere in the serialized entry'
  );
});

test('logger: an email INTERPOLATED INTO THE MESSAGE STRING is NOT masked (the bug)', () => {
  // This is the whole reason the call sites must pass the recipient as meta.
  // redactFormat scrubs meta by key and only strips base64 from the message —
  // it has no way to find an address embedded in free text. This test pins
  // that limitation so nobody "fixes" a leak by rewording the message.
  const entry = captureLogEntry(() => {
    logger.info('[email-agreement] sent to juan@example.com for agreement agr-1');
  });
  assert.match(
    entry.message, /juan@example\.com/,
    'message strings bypass key-based redaction — PII must never be interpolated into them'
  );
});

test('logger: unredacted meta key `to` would leak — recipients must use `email`', () => {
  // Guards the checkin-emails / long-term-emails / sms-providers rename.
  // `to` is NOT in REDACT_KEYS, so it logs in cleartext.
  const leaky = captureLogEntry(() => {
    logger.info('[checkin-emails] invoice sent', { agreementId: 'a', to: 'juan@example.com' });
  });
  assert.equal(leaky.to, 'juan@example.com', '`to` is not a redacted key — hence the rename to `email`');

  const safe = captureLogEntry(() => {
    logger.info('[checkin-emails] invoice sent', { agreementId: 'a', email: 'juan@example.com' });
  });
  assert.equal(safe.email, REDACTED);
});

test('non-object scalars pass through; circulars are bounded', () => {
  assert.equal(redactSensitive(42), 42);
  assert.equal(redactSensitive(null), null);
  const a = { name: 'Lot A' };
  a.self = a;
  const out = redactSensitive(a);
  assert.equal(out.self, '[circular]');
});
