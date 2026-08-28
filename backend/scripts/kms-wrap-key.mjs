#!/usr/bin/env node
/**
 * kms-wrap-key.mjs — one-time migration helper: wrap the EXISTING plaintext
 * field-encryption DEK (`FIELD_ENC_KEY`) with AWS KMS and print the base64
 * `FIELD_ENC_KEY_WRAPPED` to paste into the environment.
 *
 * This is how the operator moves the CURRENT key into KMS envelope management
 * WITHOUT changing it — the wrapped blob decrypts back to the same 32 bytes,
 * so every existing `encf:v1:` ciphertext keeps decrypting. It does NOT create
 * a new key.
 *
 * REQUIRED ENV:
 *   FIELD_ENC_KEY   — the current plaintext DEK (base64, 32 bytes) — the exact
 *                     value production runs today.
 *   KMS_KEY_ID      — the KMS CMK to wrap with: a key id, ARN, or alias
 *                     (e.g. `alias/rfm-field-enc`).
 *   AWS_REGION      — the CMK's region.
 *   AWS creds       — standard AWS SDK chain (AWS_ACCESS_KEY_ID /
 *                     AWS_SECRET_ACCESS_KEY [+ AWS_SESSION_TOKEN], or a role).
 *
 * USAGE:
 *   FIELD_ENC_KEY='<current base64 key>' \
 *   KMS_KEY_ID='alias/rfm-field-enc' \
 *   AWS_REGION='us-east-1' \
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *   node scripts/kms-wrap-key.mjs
 *
 * Then in the app environment set:
 *   FIELD_ENC_KMS_ENABLED=true
 *   FIELD_ENC_KEY_WRAPPED=<the base64 this script prints>
 *   AWS_REGION=us-east-1
 * and (once verified) remove the plaintext FIELD_ENC_KEY from the app host.
 *
 * Prints ONLY the base64 blob to stdout (all logs go to stderr) so it is safe
 * to capture with `FIELD_ENC_KEY_WRAPPED=$(node scripts/kms-wrap-key.mjs)`.
 */

import { KMSClient, EncryptCommand } from '@aws-sdk/client-kms';

const KEY_BYTES = 32;

function fail(msg) {
  console.error(`kms-wrap-key: ${msg}`);
  process.exit(1);
}

const rawKey = process.env.FIELD_ENC_KEY;
const keyId = process.env.KMS_KEY_ID;
const region = process.env.AWS_REGION;

if (!rawKey) fail('FIELD_ENC_KEY (the current plaintext base64 DEK) is required.');
if (!keyId) fail('KMS_KEY_ID (CMK id / ARN / alias) is required.');
if (!region) fail('AWS_REGION is required.');

let dek;
try {
  dek = Buffer.from(rawKey.trim(), 'base64');
} catch (e) {
  fail(`FIELD_ENC_KEY is not valid base64: ${e.message}`);
}
if (dek.length !== KEY_BYTES) {
  fail(`FIELD_ENC_KEY must decode to exactly ${KEY_BYTES} bytes (got ${dek.length}). `
    + 'Generate a fresh one with: openssl rand -base64 32');
}

const client = new KMSClient({ region });

try {
  const out = await client.send(new EncryptCommand({ KeyId: keyId, Plaintext: dek }));
  if (!out?.CiphertextBlob) fail('KMS Encrypt returned no CiphertextBlob.');
  const wrapped = Buffer.from(out.CiphertextBlob).toString('base64');
  console.error(`kms-wrap-key: wrapped DEK with ${out.KeyId || keyId} in ${region}.`);
  console.error('kms-wrap-key: set FIELD_ENC_KEY_WRAPPED to the value below, '
    + 'FIELD_ENC_KMS_ENABLED=true, and AWS_REGION.');
  // The ONLY thing on stdout — safe to capture into an env var.
  process.stdout.write(wrapped + '\n');
} catch (e) {
  fail(`KMS Encrypt failed: ${e.message}`);
}
