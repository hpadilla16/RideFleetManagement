import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Ensure a key is set before module import — module loadKey() is lazy
// (only invoked from encrypt/decrypt/isEncryptionConfigured), so import
// itself never throws. We still set a deterministic test key here.
const TEST_KEY = crypto.randomBytes(32).toString('base64');
process.env.INTEGRATION_ENC_KEY = TEST_KEY;

const mod = await import('./integration-crypto.js');
const { encrypt, decrypt, isEncryptionConfigured, _resetKeyCacheForTests } = mod;

test('round-trip — encrypt then decrypt yields the original plaintext', () => {
  const pt = 'PHPSESSID=abc123; csrf=xyz789; Path=/; HttpOnly';
  const ct = encrypt(pt);
  assert.notEqual(ct, pt);
  assert.equal(decrypt(ct), pt);
});

test('encrypt produces a different ciphertext each call (random IV)', () => {
  const pt = 'same-input';
  const a = encrypt(pt);
  const b = encrypt(pt);
  assert.notEqual(a, b);
  assert.equal(decrypt(a), pt);
  assert.equal(decrypt(b), pt);
});

test('encrypt handles unicode + long strings', () => {
  const pt = 'cookie=' + 'á'.repeat(5000) + '🚗';
  assert.equal(decrypt(encrypt(pt)), pt);
});

test('decrypt throws on tampered ciphertext', () => {
  const ct = encrypt('secret');
  const buf = Buffer.from(ct, 'base64');
  buf[buf.length - 1] ^= 0x01;  // flip a byte in the ciphertext
  const tampered = buf.toString('base64');
  assert.throws(() => decrypt(tampered));
});

test('decrypt throws when key changes between encrypt and decrypt', () => {
  const ct = encrypt('secret');
  process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
  assert.throws(() => decrypt(ct));
  // Restore for subsequent tests
  process.env.INTEGRATION_ENC_KEY = TEST_KEY;
  _resetKeyCacheForTests();
});

test('decrypt rejects malformed payloads', () => {
  assert.throws(() => decrypt(''));
  assert.throws(() => decrypt('not-base64-!@#$'));
  assert.throws(() => decrypt('aaaa'));  // too short
});

test('encrypt rejects non-string input', () => {
  assert.throws(() => encrypt(null));
  assert.throws(() => encrypt(undefined));
  assert.throws(() => encrypt(123));
  assert.throws(() => encrypt({}));
});

test('isEncryptionConfigured returns true with valid key', () => {
  assert.equal(isEncryptionConfigured(), true);
});

test('isEncryptionConfigured returns false with missing key', () => {
  const prior = process.env.INTEGRATION_ENC_KEY;
  delete process.env.INTEGRATION_ENC_KEY;
  _resetKeyCacheForTests();
  assert.equal(isEncryptionConfigured(), false);
  process.env.INTEGRATION_ENC_KEY = prior;
  _resetKeyCacheForTests();
});

test('rejects keys that decode to the wrong length', () => {
  process.env.INTEGRATION_ENC_KEY = Buffer.alloc(16).toString('base64');  // 16 bytes
  _resetKeyCacheForTests();
  assert.throws(() => encrypt('x'), /32 bytes/);
  process.env.INTEGRATION_ENC_KEY = TEST_KEY;
  _resetKeyCacheForTests();
});
