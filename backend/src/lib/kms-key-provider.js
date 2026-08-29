/**
 * kms-key-provider.js — AWS KMS envelope key management for the field-
 * encryption data key (DEK). Maps to R5 in
 * doc/field-level-pii-encryption-design-2026-08-23.md (§4 key management).
 *
 * WHY: today the DEK is a plaintext env var `FIELD_ENC_KEY` (base64 32 bytes),
 * loaded directly by lib/field-crypto.js. That means the raw key sits on the
 * host. Envelope encryption removes it: the DEK is stored KMS-ENCRYPTED
 * (`FIELD_ENC_KEY_WRAPPED`, base64 KMS ciphertext) and unwrapped into memory
 * ONCE at startup via AWS KMS Decrypt. The plaintext DEK never lands on disk.
 *
 * SAME KEY, DIFFERENT SOURCE: the DEK unwrapped from KMS is byte-for-byte the
 * SAME 32-byte key that `FIELD_ENC_KEY` holds today (the operator wraps the
 * current key with scripts/kms-wrap-key.mjs — it is not a new key). So every
 * existing `encf:v1:` ciphertext keeps decrypting unchanged. We change WHERE
 * the key comes from, not the key.
 *
 * ENV CONTRACT:
 *   FIELD_ENC_KMS_ENABLED  — opt-in switch. Unset/false → INERT: no AWS SDK is
 *                            loaded, no KMS call is made, field-crypto reads
 *                            FIELD_ENC_KEY exactly as before (zero behavior
 *                            change — production runs this until it opts in).
 *   FIELD_ENC_KEY_WRAPPED  — base64 KMS ciphertext of the DEK (required when
 *                            enabled). Produced by scripts/kms-wrap-key.mjs.
 *   AWS_REGION             — KMS region (required when enabled).
 *   AWS creds              — the STANDARD AWS SDK credential chain: env
 *                            AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+
 *                            optional AWS_SESSION_TOKEN), or an EC2/ECS
 *                            instance role. No custom cred scheme here — the
 *                            SDK resolves them.
 *
 * FAIL LOUD: with KMS enabled, ANY failure (missing config, KMS unreachable,
 * wrong CMK, non-32-byte plaintext) THROWS. main.js turns that throw into a
 * hard boot failure. We NEVER silently fall back to a different key — a wrong
 * key would corrupt every read and write of encrypted PII.
 *
 * BOOTSTRAP: resolveFieldKey() is async (KMS Decrypt is a network call) and is
 * awaited ONCE in main.js before the server accepts traffic. It hands the
 * resolved DEK to field-crypto via initFieldKey(); from then on field-crypto's
 * per-op encrypt/decrypt stay synchronous against the in-memory key on the hot
 * path.
 *
 * ROTATION (future, not implemented here): field-crypto's `encf:v<N>:` version
 * tag is the rotation seam — a v2 key would get its own wrapped blob and its
 * own initFieldKey(dek, 'v2'); old rows keep decrypting via v1. This provider
 * only resolves the current (v1) DEK today.
 *
 * FOLLOW-UP: INTEGRATION_ENC_KEY (integration-crypto.js) is still a plaintext
 * env var — the same wrap/unwrap pattern can be applied to it later.
 */

import { initFieldKey } from './field-crypto.js';
import logger from './logger.js';

const KEY_BYTES = 32;

// Resolved once, then cached for the process lifetime. { source, key }.
let cached = null;

/** True when the envelope-encryption switch is on. */
export function isKmsEnabled(env = process.env) {
  return String(env.FIELD_ENC_KMS_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Resolve the field-encryption DEK. Async + cached — call ONCE at boot.
 *
 *  - KMS enabled  → require FIELD_ENC_KEY_WRAPPED + AWS_REGION, call KMS
 *                   Decrypt on the wrapped blob, validate 32 bytes, inject the
 *                   DEK into field-crypto. Any failure THROWS (fail loud).
 *  - KMS disabled → no AWS SDK loaded, no KMS call; field-crypto keeps using
 *                   FIELD_ENC_KEY via its own env fallback (inert).
 *
 * @param {object}  [opts]
 * @param {object}  [opts.kmsClient] injected KMS client (tests) — an object
 *                  with `.send(command)` returning `{ Plaintext: Uint8Array }`.
 * @param {object}  [opts.env] env source (defaults to process.env).
 * @returns {Promise<{source:'kms'|'plaintext-env', key:Buffer|null}>}
 */
export async function resolveFieldKey({ kmsClient, env = process.env } = {}) {
  if (cached) return cached;

  if (!isKmsEnabled(env)) {
    // Inert: field-crypto reads FIELD_ENC_KEY from the env itself. We do not
    // inject anything, so behavior is byte-for-byte the pre-KMS path.
    cached = { source: 'plaintext-env', key: null };
    return cached;
  }

  const region = env.AWS_REGION;
  const wrapped = env.FIELD_ENC_KEY_WRAPPED;
  if (!region) {
    throw new Error(
      'FIELD_ENC_KMS_ENABLED is true but AWS_REGION is not set — cannot reach KMS.',
    );
  }
  if (!wrapped || typeof wrapped !== 'string') {
    throw new Error(
      'FIELD_ENC_KMS_ENABLED is true but FIELD_ENC_KEY_WRAPPED is missing — wrap '
      + 'the current FIELD_ENC_KEY with scripts/kms-wrap-key.mjs and set it.',
    );
  }

  let blob;
  try {
    blob = Buffer.from(wrapped.trim(), 'base64');
  } catch (e) {
    throw new Error(`FIELD_ENC_KEY_WRAPPED is not valid base64: ${e.message}`);
  }
  if (blob.length === 0) {
    throw new Error('FIELD_ENC_KEY_WRAPPED decoded to an empty buffer.');
  }

  // Load the SDK lazily + only on the enabled path, so a disabled boot never
  // pulls the (heavy) AWS SDK into the import graph.
  const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms');
  const client = kmsClient || new KMSClient({ region });

  let out;
  try {
    out = await client.send(new DecryptCommand({ CiphertextBlob: blob }));
  } catch (e) {
    // Never swallow + fall back: a wrong/unreachable key must stop the boot.
    throw new Error(`KMS Decrypt of FIELD_ENC_KEY_WRAPPED failed: ${e.message}`);
  }

  const plaintext = out?.Plaintext;
  if (!plaintext || plaintext.length === 0) {
    throw new Error('KMS Decrypt returned no plaintext for FIELD_ENC_KEY_WRAPPED.');
  }
  const dek = Buffer.from(plaintext);
  if (dek.length !== KEY_BYTES) {
    throw new Error(
      `KMS-decrypted DEK must be exactly ${KEY_BYTES} bytes (got ${dek.length}). `
      + 'The wrapped blob does not hold a 32-byte field key.',
    );
  }

  // Hand the SAME key field-crypto used from FIELD_ENC_KEY into memory.
  initFieldKey(dek);
  cached = { source: 'kms', key: dek };
  logger.info('field-crypto: DEK unwrapped from AWS KMS at boot', { region });
  return cached;
}

/** Test seam — drop the cached resolution so env can be re-read. */
export function _resetKmsProviderForTests() {
  cached = null;
}
