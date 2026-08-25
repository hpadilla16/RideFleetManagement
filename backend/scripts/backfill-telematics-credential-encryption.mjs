#!/usr/bin/env node
/**
 * backfill-telematics-credential-encryption.mjs — encrypt EXISTING plaintext
 * VoltSwitch GPS credentials inside telematicsConfig AppSetting blobs
 * (voltswitchApiEmail / voltswitchApiPassword → `enci:v1:` ciphertext via
 * src/lib/setting-secret-crypto.js under INTEGRATION_ENC_KEY).
 *
 * MANUAL run only — never wired into boot. New saves from the Settings page
 * encrypt (and lazily re-encrypt legacy plaintext) on their own; this script
 * walks the backlog for tenants whose telematics settings are never re-saved.
 * Reads are dual-read forever, so running it late — or not at all — only
 * means those rows stay plaintext at rest.
 *
 * USAGE
 *   cd backend
 *   INTEGRATION_ENC_KEY=<base64 32B> DATABASE_URL=... \
 *     node scripts/backfill-telematics-credential-encryption.mjs [--dry-run]
 *
 * IDEMPOTENT: values already carrying the `enci:` prefix are skipped, as are
 * blank values and rows with nothing to change. Re-running is a no-op.
 *
 * SAFETY: uses a RAW PrismaClient (no extensions), touches ONLY the two
 * credential fields, and rewrites the row's other fields byte-for-byte from
 * the parsed blob. Unparseable blobs are reported and left untouched.
 */

import { PrismaClient } from '@prisma/client';
import { isEncryptionConfigured } from '../src/lib/integration-crypto.js';
import { encryptSettingSecret, isSettingSecretEncrypted } from '../src/lib/setting-secret-crypto.js';

const DRY_RUN = process.argv.includes('--dry-run');
const CRED_FIELDS = ['voltswitchApiEmail', 'voltswitchApiPassword'];

if (!isEncryptionConfigured()) {
  console.error('INTEGRATION_ENC_KEY is missing or malformed (base64 32 bytes; '
    + 'generate with: openssl rand -base64 32) — refusing to backfill.');
  process.exit(1);
}

const prisma = new PrismaClient(); // RAW client on purpose — see header

try {
  // Both the tenant-scoped (tenant:<id>:telematicsConfig) and the legacy
  // global (telematicsConfig) key shapes. This is a per-tenant settings blob:
  // dozens of rows at most, no pagination needed.
  const rows = await prisma.appSetting.findMany({
    where: { OR: [{ key: { endsWith: ':telematicsConfig' } }, { key: 'telematicsConfig' }] },
    select: { key: true, value: true },
  });

  let scanned = 0;
  let updated = 0;
  let skippedUnparseable = 0;

  for (const row of rows) {
    scanned += 1;
    let blob;
    try {
      blob = row.value ? JSON.parse(row.value) : null;
    } catch {
      blob = null;
    }
    if (!blob || typeof blob !== 'object') {
      if (row.value) {
        skippedUnparseable += 1;
        console.warn(`[skip] ${row.key} — value is not parseable JSON, left untouched`);
      }
      continue;
    }

    let changed = false;
    for (const field of CRED_FIELDS) {
      const value = blob[field];
      if (typeof value !== 'string' || value.trim() === '') continue;
      if (isSettingSecretEncrypted(value)) continue;
      blob[field] = encryptSettingSecret(value.trim());
      changed = true;
    }
    if (!changed) continue;

    updated += 1;
    console.log(`[${DRY_RUN ? 'would-update' : 'update'}] ${row.key}`);
    if (!DRY_RUN) {
      await prisma.appSetting.update({
        where: { key: row.key },
        data: { value: JSON.stringify(blob) },
      });
    }
  }

  console.log(`DONE${DRY_RUN ? ' (dry run — nothing written)' : ''} — scanned=${scanned} `
    + `${DRY_RUN ? 'would-update' : 'updated'}=${updated} unparseable=${skippedUnparseable}`);
} finally {
  await prisma.$disconnect();
}
