/**
 * AES-256-GCM encryption helper for tenant-scoped integration credentials.
 *
 * Why this exists: IntegrationCredential.encryptedPayload stores session
 * cookies and API tokens for external systems (TL International, future
 * partners). They live in Postgres so they survive Redis flushes and
 * pass through tenant-scoped backups, but they MUST be encrypted at rest
 * — exposing a raw franchise cookie would let anyone with DB read access
 * impersonate the franchise admin.
 *
 * Wire format (after base64 decode):
 *     [ 12 bytes IV ][ 16 bytes auth tag ][ N bytes ciphertext ]
 *
 * The IV is randomly generated for every encrypt() call (NEVER reuse an
 * IV with the same key in GCM — that breaks confidentiality). The auth
 * tag binds the ciphertext + IV together; if either is tampered with,
 * decrypt() throws.
 *
 * Key management: 32 bytes (256 bits) loaded from process.env.INTEGRATION_ENC_KEY,
 * base64-encoded. Generate one with:
 *
 *     openssl rand -base64 32
 *
 * Rotation strategy (V2): add INTEGRATION_ENC_KEY_PREVIOUS and try-both on
 * decrypt. V1 has a single key — rotate by re-pasting all cookies after
 * issuing a fresh key.
 */

import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;       // GCM standard
const TAG_BYTES = 16;      // 128-bit auth tag
const KEY_BYTES = 32;      // 256 bits

let cachedKey = null;

/**
 * Load + validate the encryption key from env. Cached after first call.
 * Throws synchronously if the key is missing or malformed — that's the
 * fail-fast we want at module import time.
 */
function loadKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.INTEGRATION_ENC_KEY;
  if (!raw || typeof raw !== 'string') {
    throw new Error(
      'INTEGRATION_ENC_KEY env var is required (base64-encoded 32-byte key; ' +
      'generate with: openssl rand -base64 32)'
    );
  }
  let buf;
  try {
    buf = Buffer.from(raw.trim(), 'base64');
  } catch (e) {
    throw new Error(`INTEGRATION_ENC_KEY is not valid base64: ${e.message}`);
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `INTEGRATION_ENC_KEY must decode to exactly ${KEY_BYTES} bytes ` +
      `(got ${buf.length}); generate with: openssl rand -base64 32`
    );
  }
  cachedKey = buf;
  return cachedKey;
}

/**
 * Encrypt a plaintext string. Returns a base64 string suitable for
 * storage in a TEXT column.
 *
 * @param {string} plaintext
 * @returns {string} base64(iv || authTag || ciphertext)
 */
export function encrypt(plaintext) {
  return encryptWithKey(loadKey(), plaintext);
}

/**
 * Keyed variant of encrypt() — same wire format, caller-supplied key.
 * Added 2026-08-23 so field-level PII encryption (field-crypto.js, its own
 * FIELD_ENC_KEY) reuses this exact primitive instead of re-implementing GCM.
 *
 * @param {Buffer} key — 32-byte key
 * @param {string} plaintext
 * @returns {string} base64(iv || authTag || ciphertext)
 */
export function encryptWithKey(key, plaintext) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError(`encryptWithKey(): key must be a ${KEY_BYTES}-byte Buffer`);
  }
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt(): plaintext must be a string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt a payload produced by encrypt(). Throws on tamper / wrong key.
 *
 * @param {string} payload — base64(iv || authTag || ciphertext)
 * @returns {string} plaintext
 */
export function decrypt(payload) {
  return decryptWithKey(loadKey(), payload);
}

/**
 * Keyed variant of decrypt() — same wire format, caller-supplied key.
 *
 * @param {Buffer} key — 32-byte key
 * @param {string} payload — base64(iv || authTag || ciphertext)
 * @returns {string} plaintext
 */
export function decryptWithKey(key, payload) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError(`decryptWithKey(): key must be a ${KEY_BYTES}-byte Buffer`);
  }
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new TypeError('decrypt(): payload must be a non-empty string');
  }
  let buf;
  try {
    buf = Buffer.from(payload, 'base64');
  } catch (e) {
    throw new Error(`decrypt(): payload is not valid base64: ${e.message}`);
  }
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('decrypt(): payload is too short to be a valid GCM ciphertext');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Check whether the encryption key is configured (without throwing).
 * Useful for boot-time guards: skip auto-loading credentials if the
 * key is missing in dev.
 */
export function isEncryptionConfigured() {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

// Test seam — allow tests to flush the cached key after process.env mutation.
export function _resetKeyCacheForTests() {
  cachedKey = null;
}
