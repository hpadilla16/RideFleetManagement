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
import { redactSensitive } from './logger.js';

const REDACTED = '[redacted]';

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

test('non-object scalars pass through; circulars are bounded', () => {
  assert.equal(redactSensitive(42), 42);
  assert.equal(redactSensitive(null), null);
  const a = { name: 'Lot A' };
  a.self = a;
  const out = redactSensitive(a);
  assert.equal(out.self, '[circular]');
});
