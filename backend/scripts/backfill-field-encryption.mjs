#!/usr/bin/env node
/**
 * backfill-field-encryption.mjs — encrypt EXISTING plaintext PII rows for the
 * field map in src/lib/field-crypto.js (Phase 1: licence number, customer
 * address, DOB, signature data URLs).
 *
 * MANUAL run only — never wired into boot. New/updated rows are encrypted by
 * the prisma extension the moment FIELD_ENCRYPTION_ENABLED + FIELD_ENC_KEY are
 * set; this script walks the backlog. Reads are dual-read, so it is safe to
 * run this gradually (or not at all yet) against live traffic, and to stop and
 * re-run it at any time.
 *
 * USAGE
 *   cd backend
 *   FIELD_ENCRYPTION_ENABLED=true FIELD_ENC_KEY=<base64 32B> DATABASE_URL=... \
 *     node scripts/backfill-field-encryption.mjs [options]
 *
 * OPTIONS
 *   --dry-run             count what WOULD be encrypted; write nothing
 *   --batch-size <n>      rows fetched per page (default 200)
 *   --model <name>        only this model (prisma delegate name, e.g. customer,
 *                         rentalAgreement); default: every mapped model in order
 *   --start-after-id <id> resume: skip rows with id <= this (id-ascending walk;
 *                         combine with --model — progress lines print the
 *                         last id of every batch so a killed run can resume)
 *
 * IDEMPOTENT: values already carrying the `encf:` prefix are skipped, as are
 * null/empty values and the '[erased]' GDPR redaction sentinel. A row where
 * nothing needs encrypting is not written at all. Re-running is a no-op.
 *
 * SAFETY: uses a RAW PrismaClient (no field-crypto extension), so it sees
 * stored bytes exactly as they are and its updates cannot be double-encrypted
 * by the write hook. Each row update is guarded so a crash mid-batch loses at
 * most the in-flight row. Rehearse on a copy of prod before the real run.
 */

import { PrismaClient } from '@prisma/client';
import {
  FIELD_ENC_MAP,
  isFieldEncrypted,
  isFieldEncryptionEnabled,
  encryptField,
} from '../src/lib/field-crypto.js';

const REDACTION_SENTINEL = '[erased]';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const DRY_RUN = flag('--dry-run');
const BATCH_SIZE = Math.max(1, parseInt(opt('--batch-size', '200'), 10) || 200);
const ONLY_MODEL = opt('--model', null);
const START_AFTER_ID = opt('--start-after-id', null);

if (!isFieldEncryptionEnabled()) {
  console.error('FIELD_ENCRYPTION_ENABLED is not true — refusing to backfill. '
    + 'Set the flag (and FIELD_ENC_KEY) first so new writes are encrypted too, '
    + 'or the backlog would immediately regrow.');
  process.exit(1);
}
try {
  encryptField('key-probe'); // throws loudly when FIELD_ENC_KEY is missing/malformed
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const models = ONLY_MODEL ? [ONLY_MODEL] : Object.keys(FIELD_ENC_MAP);
for (const m of models) {
  if (!FIELD_ENC_MAP[m]) {
    console.error(`Unknown model "${m}" — mapped models: ${Object.keys(FIELD_ENC_MAP).join(', ')}`);
    process.exit(1);
  }
}

const prisma = new PrismaClient(); // RAW client on purpose — see header

function needsEncryption(value) {
  return typeof value === 'string' && value !== ''
    && !isFieldEncrypted(value) && value !== REDACTION_SENTINEL;
}

async function backfillModel(model) {
  const spec = FIELD_ENC_MAP[model];
  const select = { id: true };
  for (const f of spec.strings || []) select[f] = true;
  if (spec.dob) { select.dateOfBirth = true; select.dateOfBirthEnc = true; }

  // --start-after-id only makes sense for the first model of the run.
  let cursorId = model === models[0] ? START_AFTER_ID : null;
  let scanned = 0;
  let updated = 0;

  for (;;) {
    // keyset pagination on id — survives rows deleted mid-run (a `cursor`
    // would error if its anchor row disappeared).
    const rows = await prisma[model].findMany({
      select,
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursorId ? { where: { id: { gt: cursorId } } } : {}),
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const data = {};
      for (const f of spec.strings || []) {
        if (needsEncryption(row[f])) data[f] = encryptField(row[f]);
      }
      if (spec.dob && row.dateOfBirth instanceof Date) {
        // Prefer an existing ciphertext (never re-encrypt); either way the
        // plaintext DateTime is cleared.
        if (!isFieldEncrypted(row.dateOfBirthEnc)) {
          data.dateOfBirthEnc = encryptField(row.dateOfBirth.toISOString());
        }
        data.dateOfBirth = null;
      }
      if (Object.keys(data).length === 0) continue;
      updated += 1;
      if (!DRY_RUN) {
        await prisma[model].update({ where: { id: row.id }, data });
      }
    }

    cursorId = rows[rows.length - 1].id;
    console.log(`[${model}] scanned=${scanned} ${DRY_RUN ? 'would-update' : 'updated'}=${updated} lastId=${cursorId}`);
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`[${model}] DONE — scanned=${scanned} ${DRY_RUN ? 'would-update' : 'updated'}=${updated}`);
  return { scanned, updated };
}

const totals = { scanned: 0, updated: 0 };
try {
  for (const model of models) {
    const r = await backfillModel(model);
    totals.scanned += r.scanned;
    totals.updated += r.updated;
  }
  console.log(`ALL DONE${DRY_RUN ? ' (dry run — nothing written)' : ''} — scanned=${totals.scanned} updated=${totals.updated}`);
} finally {
  await prisma.$disconnect();
}
