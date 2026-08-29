/**
 * field-crypto.test.mjs — the field-level PII encryption contract (Phase 1).
 *
 * DB-free: exercises the pure helpers plus the extension hooks with a stubbed
 * `query` — no Prisma client, no Postgres. What is pinned down:
 *   - AES-256-GCM round-trip through the self-identifying `encf:v1:` format
 *   - dual-read: plaintext (not-yet-backfilled) values pass through unchanged
 *   - inert-by-default: flag off → writes stay plaintext, byte for byte
 *   - flag ON without a valid key → the write THROWS (never silent plaintext,
 *     never garbage)
 *   - decrypt failure (wrong key / tamper) → null, not a throw and not
 *     ciphertext leaking to a UI or DSAR export
 *   - DOB: DateTime column cannot hold ciphertext, so writes move it to
 *     dateOfBirthEnc and reads restore a Date on dateOfBirth
 *   - the GDPR redaction sentinel is never encrypted (erasure stays
 *     verifiable in the raw database)
 *
 * Run: npm run test:field-crypto
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  FIELD_ENC_MAP,
  FIELD_ENC_PREFIX,
  isFieldEncrypted,
  isFieldEncryptionEnabled,
  encryptField,
  decryptField,
  applyFieldEncryption,
  decryptResultTree,
  augmentDobSelects,
  fieldCryptoExtension,
  _resetFieldKeyCacheForTests,
} from './field-crypto.js';
import { REDACTION } from '../modules/customers/customer-pii-map.js';

const KEY = crypto.randomBytes(32).toString('base64');

function enableCrypto(key = KEY) {
  process.env.FIELD_ENCRYPTION_ENABLED = 'true';
  if (key === null) delete process.env.FIELD_ENC_KEY;
  else process.env.FIELD_ENC_KEY = key;
  _resetFieldKeyCacheForTests();
}

function disableCrypto() {
  delete process.env.FIELD_ENCRYPTION_ENABLED;
  delete process.env.FIELD_ENC_KEY;
  _resetFieldKeyCacheForTests();
}

beforeEach(() => disableCrypto());

// ---------------------------------------------------------------------------
// Round-trip + format
// ---------------------------------------------------------------------------

test('round-trip: encryptField -> decryptField restores the plaintext', () => {
  enableCrypto();
  const ct = encryptField('D123-456-789');
  assert.notEqual(ct, 'D123-456-789');
  assert.equal(decryptField(ct), 'D123-456-789');
});

test('ciphertext is self-identifying and carries the key-version tag', () => {
  enableCrypto();
  const ct = encryptField('123 Calle Sol');
  assert.ok(ct.startsWith(`${FIELD_ENC_PREFIX}v1:`), `expected encf:v1: prefix, got ${ct.slice(0, 12)}`);
  assert.ok(isFieldEncrypted(ct));
  assert.equal(isFieldEncrypted('123 Calle Sol'), false);
});

test('every encrypt uses a fresh IV — same plaintext, different ciphertext', () => {
  enableCrypto();
  assert.notEqual(encryptField('same'), encryptField('same'));
});

// ---------------------------------------------------------------------------
// Dual-read
// ---------------------------------------------------------------------------

test('dual-read: plaintext and non-strings pass through decryptField untouched', () => {
  enableCrypto();
  assert.equal(decryptField('plain old value'), 'plain old value');
  assert.equal(decryptField(''), '');
  assert.equal(decryptField(null), null);
  assert.equal(decryptField(undefined), undefined);
});

test('decrypt failure (wrong key) returns null, never throws or leaks ciphertext', () => {
  enableCrypto();
  const ct = encryptField('secret');
  enableCrypto(crypto.randomBytes(32).toString('base64')); // rotate to a DIFFERENT key
  assert.equal(decryptField(ct), null);
});

test('decrypt with no key configured returns null (dual-read stays non-fatal)', () => {
  enableCrypto();
  const ct = encryptField('secret');
  disableCrypto();
  assert.equal(decryptField(ct), null);
});

// ---------------------------------------------------------------------------
// Inert by default / fail loudly
// ---------------------------------------------------------------------------

test('flag off: applyFieldEncryption leaves string writes byte-for-byte untouched', () => {
  assert.equal(isFieldEncryptionEnabled(), false);
  const data = { licenseNumber: 'D999', city: 'San Juan', firstName: 'Ana' };
  applyFieldEncryption(FIELD_ENC_MAP.customer, data);
  assert.equal(data.licenseNumber, 'D999');
  assert.equal(data.city, 'San Juan');
  assert.equal(data.firstName, 'Ana');
});

test('flag on without a key: the write throws loudly', () => {
  enableCrypto(null);
  assert.throws(
    () => applyFieldEncryption(FIELD_ENC_MAP.customer, { licenseNumber: 'D999' }),
    /FIELD_ENC_KEY/,
  );
});

test('flag on with a malformed key: the write throws loudly', () => {
  enableCrypto('too-short');
  assert.throws(
    () => applyFieldEncryption(FIELD_ENC_MAP.customer, { licenseNumber: 'D999' }),
    /FIELD_ENC_KEY/,
  );
});

// ---------------------------------------------------------------------------
// Write mapping
// ---------------------------------------------------------------------------

test('flag on: mapped string fields are encrypted in place; unmapped stay put', () => {
  enableCrypto();
  const data = { licenseNumber: 'D999', address1: 'Calle 1', firstName: 'Ana', email: 'a@b.c' };
  applyFieldEncryption(FIELD_ENC_MAP.customer, data);
  assert.ok(isFieldEncrypted(data.licenseNumber));
  assert.ok(isFieldEncrypted(data.address1));
  assert.equal(data.firstName, 'Ana'); // name is searched — Phase 2, declined
  assert.equal(data.email, 'a@b.c');   // searched — Phase 2, declined
  assert.equal(decryptField(data.licenseNumber), 'D999');
});

test('update `{ set: v }` wrappers are preserved', () => {
  enableCrypto();
  const data = { licenseNumber: { set: 'D999' } };
  applyFieldEncryption(FIELD_ENC_MAP.customer, data);
  assert.ok(typeof data.licenseNumber === 'object' && 'set' in data.licenseNumber);
  assert.ok(isFieldEncrypted(data.licenseNumber.set));
});

test('idempotent: already-encrypted values are never double-encrypted', () => {
  enableCrypto();
  const once = encryptField('D999');
  const data = { licenseNumber: once };
  applyFieldEncryption(FIELD_ENC_MAP.customer, data);
  assert.equal(data.licenseNumber, once);
});

test('null / empty / absent fields are untouched', () => {
  enableCrypto();
  const data = { licenseNumber: null, address1: '', address2: undefined };
  applyFieldEncryption(FIELD_ENC_MAP.customer, data);
  assert.equal(data.licenseNumber, null);
  assert.equal(data.address1, '');
  assert.equal(data.address2, undefined);
});

test('the GDPR redaction sentinel is stored verbatim, not encrypted', () => {
  enableCrypto();
  const data = { licenseNumber: REDACTION };
  applyFieldEncryption(FIELD_ENC_MAP.customer, data);
  assert.equal(data.licenseNumber, REDACTION); // pins field-crypto's local sentinel to the map's
});

// ---------------------------------------------------------------------------
// DOB — the DateTime column split
// ---------------------------------------------------------------------------

test('flag on: dateOfBirth moves to dateOfBirthEnc (encrypted ISO), DateTime nulled', () => {
  enableCrypto();
  const dob = new Date('1990-05-17T00:00:00.000Z');
  const data = { dateOfBirth: dob };
  applyFieldEncryption(FIELD_ENC_MAP.customer, data);
  assert.equal(data.dateOfBirth, null);
  assert.ok(isFieldEncrypted(data.dateOfBirthEnc));
  assert.equal(decryptField(data.dateOfBirthEnc), '1990-05-17T00:00:00.000Z');
});

test('flag off: dateOfBirth stays a plaintext Date; stale ciphertext is cleared', () => {
  const dob = new Date('1990-05-17T00:00:00.000Z');
  const data = { dateOfBirth: dob };
  applyFieldEncryption(FIELD_ENC_MAP.customer, data);
  assert.equal(data.dateOfBirth, dob);
  assert.equal(data.dateOfBirthEnc, null); // rollback safety: Enc can never shadow a newer plaintext
});

test('clearing dateOfBirth clears BOTH columns (erasure path)', () => {
  enableCrypto();
  const data = { dateOfBirth: null };
  applyFieldEncryption(FIELD_ENC_MAP.customer, data);
  assert.equal(data.dateOfBirth, null);
  assert.equal(data.dateOfBirthEnc, null);
});

test('dateOfBirth: undefined means "not touching it" — companion left alone', () => {
  enableCrypto();
  const data = { firstName: 'Ana' };
  applyFieldEncryption(FIELD_ENC_MAP.customer, data);
  assert.ok(!('dateOfBirthEnc' in data));
});

// ---------------------------------------------------------------------------
// Read walker
// ---------------------------------------------------------------------------

test('decryptResultTree decrypts nested includes and arrays; Dates survive', () => {
  enableCrypto();
  const createdAt = new Date();
  const row = {
    id: 'r1',
    createdAt,
    customer: {
      licenseNumber: encryptField('D999'),
      city: encryptField('Ponce'),
      firstName: 'Ana',
    },
    additionalDrivers: [
      { licenseNumber: encryptField('X111'), notes: 'plain' },
    ],
  };
  decryptResultTree(row);
  assert.equal(row.customer.licenseNumber, 'D999');
  assert.equal(row.customer.city, 'Ponce');
  assert.equal(row.customer.firstName, 'Ana');
  assert.equal(row.additionalDrivers[0].licenseNumber, 'X111');
  assert.equal(row.additionalDrivers[0].notes, 'plain');
  assert.equal(row.createdAt, createdAt);
});

test('decryptResultTree restores dateOfBirth from dateOfBirthEnc and strips the Enc key', () => {
  enableCrypto();
  const row = {
    dateOfBirth: null,
    dateOfBirthEnc: encryptField('1990-05-17T00:00:00.000Z'),
  };
  decryptResultTree(row);
  assert.ok(row.dateOfBirth instanceof Date);
  assert.equal(row.dateOfBirth.toISOString(), '1990-05-17T00:00:00.000Z');
  assert.ok(!('dateOfBirthEnc' in row));
});

test('decryptResultTree: pre-backfill rows (plain DOB, Enc null) keep their Date', () => {
  const dob = new Date('1980-01-02T00:00:00.000Z');
  const row = { dateOfBirth: dob, dateOfBirthEnc: null };
  decryptResultTree(row);
  assert.equal(row.dateOfBirth, dob);
  assert.ok(!('dateOfBirthEnc' in row));
});

test('decryptResultTree: undecryptable DOB ciphertext yields null, not a fake date', () => {
  enableCrypto();
  const enc = encryptField('1990-05-17T00:00:00.000Z');
  enableCrypto(crypto.randomBytes(32).toString('base64'));
  const row = { dateOfBirth: null, dateOfBirthEnc: enc };
  decryptResultTree(row);
  assert.equal(row.dateOfBirth, null);
});

// ---------------------------------------------------------------------------
// Select augmentation
// ---------------------------------------------------------------------------

test('augmentDobSelects adds dateOfBirthEnc beside every selected dateOfBirth', () => {
  const args = {
    select: { id: true, dateOfBirth: true },
    include: {
      customer: { select: { dateOfBirth: true, firstName: true } },
      vehicle: { select: { vin: true } },
    },
  };
  augmentDobSelects({ select: args.select });
  augmentDobSelects(args.include);
  assert.equal(args.select.dateOfBirthEnc, true);
  assert.equal(args.include.customer.select.dateOfBirthEnc, true);
  assert.ok(!('dateOfBirthEnc' in args.include.vehicle.select));
});

// ---------------------------------------------------------------------------
// The extension hook — the single choke point, exercised with a stubbed query
// ---------------------------------------------------------------------------

test('extension: Customer.update encrypts mapped args and decrypts the result', async () => {
  enableCrypto();
  let captured = null;
  const hook = fieldCryptoExtension.query.$allModels.$allOperations;
  const result = await hook({
    model: 'Customer',
    operation: 'update',
    args: { where: { id: 'c1' }, data: { licenseNumber: 'D999', firstName: 'Ana' } },
    query: async (args) => {
      captured = args;
      return { id: 'c1', licenseNumber: args.data.licenseNumber, firstName: 'Ana' };
    },
  });
  assert.ok(isFieldEncrypted(captured.data.licenseNumber), 'ciphertext must reach the DB');
  assert.equal(captured.data.firstName, 'Ana');
  assert.equal(result.licenseNumber, 'D999', 'caller must get plaintext back');
});

test('extension: upsert encrypts both create and update payloads', async () => {
  enableCrypto();
  let captured = null;
  const hook = fieldCryptoExtension.query.$allModels.$allOperations;
  await hook({
    model: 'LoanerAgreement',
    operation: 'upsert',
    args: {
      where: { id: 'l1' },
      create: { licenseNumber: 'A1' },
      update: { licenseNumber: 'A2' },
    },
    query: async (args) => { captured = args; return {}; },
  });
  assert.ok(isFieldEncrypted(captured.create.licenseNumber));
  assert.ok(isFieldEncrypted(captured.update.licenseNumber));
});

test('extension: createMany encrypts every row of the data array', async () => {
  enableCrypto();
  let captured = null;
  const hook = fieldCryptoExtension.query.$allModels.$allOperations;
  await hook({
    model: 'AgreementDriver',
    operation: 'createMany',
    args: { data: [{ licenseNumber: 'A' }, { licenseNumber: 'B' }] },
    query: async (args) => { captured = args; return { count: 2 }; },
  });
  assert.ok(captured.data.every((d) => isFieldEncrypted(d.licenseNumber)));
});

test('extension: unmapped models write through untouched', async () => {
  enableCrypto();
  let captured = null;
  const hook = fieldCryptoExtension.query.$allModels.$allOperations;
  await hook({
    model: 'Vehicle',
    operation: 'update',
    args: { where: { id: 'v1' }, data: { state: 'ACTIVE', city: 'irrelevant' } },
    query: async (args) => { captured = args; return {}; },
  });
  assert.equal(captured.data.state, 'ACTIVE');
  assert.equal(captured.data.city, 'irrelevant');
});

test('extension: flag off is a byte-for-byte passthrough on writes (inert by default)', async () => {
  const hook = fieldCryptoExtension.query.$allModels.$allOperations;
  let captured = null;
  await hook({
    model: 'Customer',
    operation: 'create',
    args: { data: { licenseNumber: 'D999', address1: 'Calle 1' } },
    query: async (args) => { captured = args; return { ...args.data }; },
  });
  assert.equal(captured.data.licenseNumber, 'D999');
  assert.equal(captured.data.address1, 'Calle 1');
});

test('extension: reads dual-read even when the flag is OFF but the key remains', async () => {
  enableCrypto();
  const ct = encryptField('D999');
  process.env.FIELD_ENCRYPTION_ENABLED = 'false'; // rollback: flag off, key kept
  _resetFieldKeyCacheForTests();
  const hook = fieldCryptoExtension.query.$allModels.$allOperations;
  const result = await hook({
    model: 'Customer',
    operation: 'findUnique',
    args: { where: { id: 'c1' } },
    query: async () => ({ id: 'c1', licenseNumber: ct }),
  });
  assert.equal(result.licenseNumber, 'D999');
});

test('extension: $queryRaw rows are decrypted (covers the customers list query)', async () => {
  enableCrypto();
  const rows = [
    { id: 'c1', licenseNumber: encryptField('D999'), dateOfBirthEnc: encryptField('1990-05-17T00:00:00.000Z'), dateOfBirth: null },
  ];
  const result = await fieldCryptoExtension.query.$queryRaw({
    args: {},
    query: async () => rows,
  });
  assert.equal(result[0].licenseNumber, 'D999');
  assert.ok(result[0].dateOfBirth instanceof Date);
  assert.ok(!('dateOfBirthEnc' in result[0]));
});

// ---------------------------------------------------------------------------
// Field map shape — catches accidental scope drift
// ---------------------------------------------------------------------------

test('the field map never names the searched Phase-2 fields', () => {
  for (const [model, spec] of Object.entries(FIELD_ENC_MAP)) {
    for (const banned of ['firstName', 'lastName', 'email', 'phone', 'telephone', 'customerEmail', 'customerPhone']) {
      assert.ok(!(spec.strings || []).includes(banned), `${model}.${banned} is searched — Phase 2 was declined`);
    }
  }
});
