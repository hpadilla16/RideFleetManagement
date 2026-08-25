/**
 * setting-secret-crypto.js — encrypted-at-rest secrets INSIDE AppSetting JSON
 * blobs (first user: the VoltSwitch GPS credentials in telematicsConfig).
 *
 * WHY: IntegrationCredential rows are AES-256-GCM encrypted via
 * integration-crypto, and customer PII columns via field-crypto — but secrets
 * that live as plain values inside an AppSetting JSON blob (settings-page
 * configs) were stored plaintext. They are masked on read, which protects the
 * UI, not the database. This module closes that gap without a schema change:
 * the secret value itself becomes a self-identifying ciphertext string inside
 * the same JSON field.
 *
 * FORMAT: `enci:v1:<base64(iv || authTag || ciphertext)>` — the payload is
 * EXACTLY integration-crypto's wire format under INTEGRATION_ENC_KEY (the
 * integration-credential key, because these ARE integration credentials).
 * The `v1` tag is the KEY VERSION, mirroring field-crypto's `encf:v<N>:`
 * rotation scheme: rotation adds a new tag + key and decrypt picks by tag.
 *
 * DUAL-READ, FOREVER: decryptSettingSecret() passes any non-prefixed value
 * through untouched, so config blobs saved before this existed keep working
 * with no big-bang migration. Writes encrypt; carries lazily re-encrypt (see
 * carrySettingSecret); scripts/backfill-telematics-credential-encryption.mjs
 * walks the backlog for rows that are never re-saved.
 *
 * FAILURE POSTURE (learned from the 2026-08-13 save-erased-the-creds bug):
 *   - encrypt of a NEW secret with no key configured THROWS
 *     (ENCRYPTION_NOT_CONFIGURED) — never silently store a new secret
 *     plaintext once encryption is the standard, and never store garbage.
 *   - CARRYING a stored value on save never throws and never round-trips
 *     through decrypt: ciphertext is kept verbatim, plaintext is re-encrypted
 *     only when the key is available. A missing/wrong key can therefore never
 *     turn a save into an erase.
 *   - decrypt failure logs and returns '' (never the raw ciphertext): readers
 *     see "no credentials", connectors report not-ready, nothing leaks.
 */

import { encrypt, decrypt, isEncryptionConfigured } from './integration-crypto.js';
import logger from './logger.js';

export const SETTING_SECRET_PREFIX = 'enci:';
const WRITE_VERSION = 'v1';

/** True when `value` carries the self-identifying ciphertext prefix. */
export function isSettingSecretEncrypted(value) {
  return typeof value === 'string' && value.startsWith(SETTING_SECRET_PREFIX);
}

/**
 * Encrypt a NEW secret value for storage inside an AppSetting JSON blob.
 * '' stays '' (nothing to protect); an already-encrypted value passes through
 * (idempotent — never double-encrypt). THROWS when a real plaintext arrives
 * and INTEGRATION_ENC_KEY is not configured.
 *
 * @param {string} plaintext
 * @returns {string} `enci:v1:<payload>`, or '' for blank input
 */
export function encryptSettingSecret(plaintext) {
  const raw = String(plaintext ?? '').trim();
  if (!raw) return '';
  if (isSettingSecretEncrypted(raw)) return raw;
  if (!isEncryptionConfigured()) {
    const err = new Error('Cannot save credential: encryption key (INTEGRATION_ENC_KEY) is not configured');
    err.code = 'ENCRYPTION_NOT_CONFIGURED';
    throw err;
  }
  return `${SETTING_SECRET_PREFIX}${WRITE_VERSION}:${encrypt(raw)}`;
}

/**
 * Carry a STORED value forward on a save that did not change it
 * (blank-means-keep). Never decrypt→re-encrypt (a bad key must not corrupt or
 * erase the stored value) and never throw:
 *   - ciphertext → kept verbatim;
 *   - legacy plaintext + key configured → lazily re-encrypted (the migration
 *     path: any save upgrades the blob);
 *   - legacy plaintext + no key → kept plaintext, unchanged behavior.
 *
 * @param {unknown} stored — the raw value as read from the DB blob
 * @returns {string}
 */
export function carrySettingSecret(stored) {
  const raw = typeof stored === 'string' ? stored.trim() : '';
  if (!raw) return '';
  if (isSettingSecretEncrypted(raw)) return raw;
  if (!isEncryptionConfigured()) return raw;
  return encryptSettingSecret(raw);
}

/**
 * Dual-read decrypt: `enci:` ciphertext → plaintext; anything else (legacy
 * plaintext, undefined, non-strings) passes through untouched. Decrypt
 * FAILURE (unknown version, missing key, tamper) logs and returns '' — a
 * settings read must not 500, and returning raw ciphertext to the UI or to a
 * connector login would be worse than "no credentials".
 *
 * @param {unknown} value
 * @returns {unknown} plaintext, the original value, or '' on decrypt failure
 */
export function decryptSettingSecret(value) {
  if (!isSettingSecretEncrypted(value)) return value;
  const rest = value.slice(SETTING_SECRET_PREFIX.length);
  const sep = rest.indexOf(':');
  const version = sep > 0 ? rest.slice(0, sep) : null;
  const payload = sep > 0 ? rest.slice(sep + 1) : '';
  if (version !== WRITE_VERSION || !payload) {
    logger.error('setting-secret-crypto: cannot decrypt setting secret — unknown version or malformed payload', { version });
    return '';
  }
  try {
    return decrypt(payload);
  } catch (e) {
    logger.error('setting-secret-crypto: setting secret decryption failed (missing/wrong key or tamper)', { error: e.message });
    return '';
  }
}
