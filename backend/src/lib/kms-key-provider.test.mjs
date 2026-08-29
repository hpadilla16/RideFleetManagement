/**
 * kms-key-provider.test.mjs — AWS KMS envelope key management for the field-
 * encryption DEK (R5). DB-free, SDK-free at runtime: the KMS client is MOCKED
 * (injected), so no network and no real AWS credentials are touched.
 *
 * What is pinned down:
 *   - KMS-enabled: the wrapped blob is KMS-Decrypted → the expected 32-byte DEK
 *     is injected into field-crypto, and — critically — that KMS-unwrapped key
 *     decrypts a value that was encrypted via the PLAINTEXT FIELD_ENC_KEY path
 *     (same-key continuity: existing `encf:v1` data stays valid).
 *   - KMS-disabled (default): no KMS call at all; field-crypto uses
 *     FIELD_ENC_KEY exactly as before (inert / backward-compatible).
 *   - KMS-enabled but Decrypt rejects / config missing / wrong-size key →
 *     THROWS (fail loud), and NEVER silently falls back to a different key.
 *
 * Run: npm run test:kms-key-provider
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  resolveFieldKey,
  isKmsEnabled,
  _resetKmsProviderForTests,
} from './kms-key-provider.js';
import {
  encryptField,
  decryptField,
  isFieldEncrypted,
  _resetFieldKeyCacheForTests,
} from './field-crypto.js';

// A fixed 32-byte key stands in for the operator's real DEK.
const DEK = crypto.randomBytes(32);

function cleanEnv() {
  delete process.env.FIELD_ENC_KMS_ENABLED;
  delete process.env.FIELD_ENC_KEY_WRAPPED;
  delete process.env.AWS_REGION;
  delete process.env.FIELD_ENCRYPTION_ENABLED;
  delete process.env.FIELD_ENC_KEY;
}

beforeEach(() => {
  cleanEnv();
  _resetKmsProviderForTests();
  _resetFieldKeyCacheForTests();
});

/** A mock KMS client: `.send()` returns the DEK as Plaintext and counts calls. */
function mockKms(plaintext = DEK) {
  const calls = [];
  return {
    calls,
    send(command) {
      calls.push(command);
      return Promise.resolve({ Plaintext: new Uint8Array(plaintext) });
    },
  };
}

/** A mock KMS client whose Decrypt rejects (wrong CMK / unreachable). */
function rejectingKms(message = 'AccessDeniedException') {
  const calls = [];
  return {
    calls,
    send(command) {
      calls.push(command);
      return Promise.reject(new Error(message));
    },
  };
}

// ---------------------------------------------------------------------------
// isKmsEnabled
// ---------------------------------------------------------------------------

test('isKmsEnabled is false by default and only truthy on "true"', () => {
  assert.equal(isKmsEnabled(), false);
  assert.equal(isKmsEnabled({ FIELD_ENC_KMS_ENABLED: 'false' }), false);
  assert.equal(isKmsEnabled({ FIELD_ENC_KMS_ENABLED: '1' }), false);
  assert.equal(isKmsEnabled({ FIELD_ENC_KMS_ENABLED: 'true' }), true);
  assert.equal(isKmsEnabled({ FIELD_ENC_KMS_ENABLED: 'TRUE' }), true);
});

// ---------------------------------------------------------------------------
// KMS-enabled happy path + SAME-KEY continuity
// ---------------------------------------------------------------------------

test('KMS-enabled: Decrypt yields the DEK and injects it into field-crypto', async () => {
  process.env.FIELD_ENC_KMS_ENABLED = 'true';
  process.env.FIELD_ENCRYPTION_ENABLED = 'true';
  process.env.AWS_REGION = 'us-east-1';
  process.env.FIELD_ENC_KEY_WRAPPED = Buffer.from('wrapped-blob').toString('base64');
  // NB: FIELD_ENC_KEY is deliberately ABSENT — proving the key came from KMS,
  // not the env var.
  const kms = mockKms();

  const r = await resolveFieldKey({ kmsClient: kms });
  assert.equal(r.source, 'kms');
  assert.ok(r.key.equals(DEK));
  assert.equal(kms.calls.length, 1, 'exactly one KMS Decrypt call');

  // The injected key round-trips through field-crypto.
  const ct = encryptField('DL-998877');
  assert.ok(isFieldEncrypted(ct));
  assert.equal(decryptField(ct), 'DL-998877');
});

test('SAME-KEY continuity: KMS-unwrapped key decrypts data written via the plaintext FIELD_ENC_KEY path', async () => {
  // 1) Plaintext path: encrypt a value using FIELD_ENC_KEY = base64(DEK).
  process.env.FIELD_ENCRYPTION_ENABLED = 'true';
  process.env.FIELD_ENC_KEY = DEK.toString('base64');
  _resetFieldKeyCacheForTests();
  const legacyCiphertext = encryptField('1990-05-20T00:00:00.000Z');
  assert.ok(isFieldEncrypted(legacyCiphertext));

  // 2) Switch to KMS: drop the plaintext env key entirely, unwrap the SAME DEK
  //    from KMS, and confirm the old ciphertext still decrypts.
  cleanEnv();
  _resetFieldKeyCacheForTests();
  _resetKmsProviderForTests();
  process.env.FIELD_ENC_KMS_ENABLED = 'true';
  process.env.FIELD_ENCRYPTION_ENABLED = 'true';
  process.env.AWS_REGION = 'eu-west-1';
  process.env.FIELD_ENC_KEY_WRAPPED = Buffer.from('same-key-blob').toString('base64');

  await resolveFieldKey({ kmsClient: mockKms(DEK) });

  assert.equal(
    decryptField(legacyCiphertext),
    '1990-05-20T00:00:00.000Z',
    'existing encf:v1 data must stay valid under the KMS-unwrapped key',
  );
});

test('resolveFieldKey caches — a second call does not hit KMS again', async () => {
  process.env.FIELD_ENC_KMS_ENABLED = 'true';
  process.env.AWS_REGION = 'us-east-1';
  process.env.FIELD_ENC_KEY_WRAPPED = Buffer.from('blob').toString('base64');
  const kms = mockKms();

  await resolveFieldKey({ kmsClient: kms });
  await resolveFieldKey({ kmsClient: kms });
  assert.equal(kms.calls.length, 1, 'DEK resolved once, then cached');
});

// ---------------------------------------------------------------------------
// KMS-disabled (inert / backward-compatible)
// ---------------------------------------------------------------------------

test('KMS-disabled: uses FIELD_ENC_KEY and makes NO KMS call', async () => {
  process.env.FIELD_ENCRYPTION_ENABLED = 'true';
  process.env.FIELD_ENC_KEY = DEK.toString('base64');
  _resetFieldKeyCacheForTests();
  const kms = mockKms();

  const r = await resolveFieldKey({ kmsClient: kms });
  assert.equal(r.source, 'plaintext-env');
  assert.equal(r.key, null);
  assert.equal(kms.calls.length, 0, 'disabled path must never call KMS');

  // field-crypto works off the plaintext env key exactly as before.
  const ct = encryptField('addr-line-1');
  assert.equal(decryptField(ct), 'addr-line-1');
});

// ---------------------------------------------------------------------------
// Fail-loud: never silently fall back to a different key
// ---------------------------------------------------------------------------

test('KMS-enabled but Decrypt rejects → throws, does NOT fall back', async () => {
  process.env.FIELD_ENC_KMS_ENABLED = 'true';
  process.env.FIELD_ENCRYPTION_ENABLED = 'true';
  process.env.AWS_REGION = 'us-east-1';
  process.env.FIELD_ENC_KEY_WRAPPED = Buffer.from('blob').toString('base64');
  // A stray env key that must NOT be used as a silent fallback.
  process.env.FIELD_ENC_KEY = crypto.randomBytes(32).toString('base64');
  _resetFieldKeyCacheForTests();

  await assert.rejects(
    () => resolveFieldKey({ kmsClient: rejectingKms('KMS unreachable') }),
    /KMS Decrypt of FIELD_ENC_KEY_WRAPPED failed/,
  );
});

test('KMS-enabled but AWS_REGION missing → throws', async () => {
  process.env.FIELD_ENC_KMS_ENABLED = 'true';
  process.env.FIELD_ENC_KEY_WRAPPED = Buffer.from('blob').toString('base64');
  await assert.rejects(
    () => resolveFieldKey({ kmsClient: mockKms() }),
    /AWS_REGION is not set/,
  );
});

test('KMS-enabled but FIELD_ENC_KEY_WRAPPED missing → throws', async () => {
  process.env.FIELD_ENC_KMS_ENABLED = 'true';
  process.env.AWS_REGION = 'us-east-1';
  await assert.rejects(
    () => resolveFieldKey({ kmsClient: mockKms() }),
    /FIELD_ENC_KEY_WRAPPED is missing/,
  );
});

test('KMS-enabled but decrypted DEK is the wrong size → throws', async () => {
  process.env.FIELD_ENC_KMS_ENABLED = 'true';
  process.env.AWS_REGION = 'us-east-1';
  process.env.FIELD_ENC_KEY_WRAPPED = Buffer.from('blob').toString('base64');
  await assert.rejects(
    () => resolveFieldKey({ kmsClient: mockKms(crypto.randomBytes(16)) }),
    /must be exactly 32 bytes/,
  );
});
