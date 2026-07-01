#!/usr/bin/env node
/**
 * 16l cleanup — null out legacy RentalAgreementInspection.photosJson for
 * rows that have already been migrated (photoStorageRefs IS NOT NULL and
 * has at least one entry).
 *
 * Run this AFTER backfill-inspection-photos-to-storage.mjs has been verified
 * in production for at least one release. The legacy column is preserved
 * during the safety window so we can re-render old photos if Storage hiccups.
 *
 * Usage:
 *   node backend/scripts/clear-migrated-photos-json.mjs              # dry-run
 *   node backend/scripts/clear-migrated-photos-json.mjs --commit
 *   node backend/scripts/clear-migrated-photos-json.mjs --commit --limit 500
 *   node backend/scripts/clear-migrated-photos-json.mjs --commit --tenant clx123
 *
 * Idempotent: rows already cleared (photosJson IS NULL) are filtered out.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadObject as realDownloadObject } from '../src/lib/storage/supabase-storage.js';
import { getPhotosBucket } from '../src/modules/rental-agreements/inspection-photos.js';
// Prisma is loaded lazily via dynamic import so tests can inject a stub
// without pulling in @prisma/client at module-eval time.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1);
    if (!key || process.env[key] != null) continue;
    process.env[key] = raw;
  }
}

function parseArgs(argv) {
  const out = { commit: false, limit: null, tenant: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') out.commit = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--tenant') out.tenant = String(argv[++i] || '').trim() || null;
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: clear-migrated-photos-json.mjs [--commit] [--limit N] [--tenant ID]'
      );
      process.exit(0);
    }
  }
  return out;
}

// HARDENED (prod incident 2026-06): a ref whose stored object is smaller than
// this is almost certainly NOT a real photo (the incident produced ~9-byte
// "[object Object]" objects). If a row carries such a ref we must NEVER null its
// photosJson — that would destroy the only surviving copy of the real photo.
const MIN_REF_BYTES = 100;

function hasSuspiciousRef(refs) {
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') return true; // malformed ref
    if (ref.external && ref.url) continue; // external URL ref — size N/A, OK
    const size = Number(ref.size);
    if (!Number.isFinite(size) || size < MIN_REF_BYTES) return true;
  }
  return false;
}

/**
 * HARDENED (Innovation review 2026-06): the recorded `ref.size` is only as
 * trustworthy as whatever wrote it. Before we DESTROY the last surviving copy of
 * a photo (photosJson), do a LIVE read-back of at least one referenced object
 * and confirm it truly exists and is a plausible size. We download the FIRST
 * non-external ref (external refs live elsewhere — size N/A) and require:
 *   - the download succeeds, and
 *   - its byte length is >= MIN_REF_BYTES, and
 *   - if the ref carries a `size`, the live length matches it.
 * On any failure (missing / tiny / empty / mismatch) we return false so the
 * caller LEAVES the row intact. A row with only external refs has nothing to
 * read back and passes (its bytes are not ours to lose).
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function liveReadBackOk({ refs, download, bucket }) {
  const target = refs.find((r) => r && typeof r === 'object' && !r.external && r.path);
  if (!target) return { ok: true }; // nothing local to verify (external-only)
  let back;
  try {
    back = await download({ bucket, path: target.path });
  } catch (err) {
    return { ok: false, reason: `read-back failed: ${err?.message || err}` };
  }
  const backLen = back?.body?.byteLength ?? back?.size ?? null;
  if (backLen == null || backLen < MIN_REF_BYTES) {
    return { ok: false, reason: `live object missing/tiny (len=${backLen})` };
  }
  const recorded = Number(target.size);
  if (Number.isFinite(recorded) && recorded > 0 && backLen !== recorded) {
    return { ok: false, reason: `live len ${backLen} != recorded size ${recorded}` };
  }
  return { ok: true };
}

export async function runCleanup({
  args = parseArgs(process.argv),
  prismaClient = null,
  downloader = null,
  logger = console
} = {}) {
  let prisma = prismaClient;
  if (!prisma) {
    const mod = await import('@prisma/client');
    prisma = new mod.PrismaClient();
  }
  const ownsPrisma = !prismaClient;
  const download = typeof downloader === 'function' ? downloader : realDownloadObject;
  const bucket = getPhotosBucket();
  const stats = { eligible: 0, cleared: 0, skipped: 0, skippedSuspicious: 0 };
  try {
    const where = {
      photosJson: { not: null },
      photoStorageRefs: { not: null }
    };
    if (args.tenant) {
      where.rentalAgreement = { tenantId: args.tenant };
    }
    const take = args.limit && args.limit > 0 ? args.limit : undefined;
    const rows = await prisma.rentalAgreementInspection.findMany({
      where,
      take,
      select: { id: true, photoStorageRefs: true }
    });
    stats.eligible = rows.length;
    logger.log(
      `[16l-cleanup] ${args.commit ? 'COMMIT' : 'DRY-RUN'}: ${rows.length} candidate rows` +
        (args.tenant ? ` (tenant=${args.tenant})` : '') +
        (take ? ` (limit=${take})` : '')
    );

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i > 0 && i % 25 === 0) {
        logger.log(`[16l-cleanup] progress ${i}/${rows.length} cleared=${stats.cleared}`);
      }
      // Defensive: only clear when refs array is non-empty.
      const refs = Array.isArray(row.photoStorageRefs) ? row.photoStorageRefs : [];
      if (refs.length === 0) {
        stats.skipped++;
        continue;
      }
      // HARDENED: never clear a row whose refs contain a suspiciously small
      // object — a bad ref must never let us destroy the original photosJson.
      if (hasSuspiciousRef(refs)) {
        stats.skipped++;
        stats.skippedSuspicious++;
        logger.log(
          `[16l-cleanup] SKIP suspicious refs on inspection=${row.id} ` +
            `(a ref < ${MIN_REF_BYTES} bytes or malformed); photosJson left intact`
        );
        continue;
      }
      if (!args.commit) {
        // Dry-run: never read Storage, never write. (Count-safe + idempotent.)
        stats.skipped++;
        continue;
      }
      // HARDENED: live read-back BEFORE we destroy the original. Trust the bytes
      // in Storage, not the recorded ref.size. If the live object is missing or
      // suspiciously tiny, LEAVE photosJson intact.
      const live = await liveReadBackOk({ refs, download, bucket });
      if (!live.ok) {
        stats.skipped++;
        stats.skippedSuspicious++;
        logger.log(
          `[16l-cleanup] SKIP live read-back on inspection=${row.id} ` +
            `(${live.reason}); photosJson left intact`
        );
        continue;
      }
      await prisma.rentalAgreementInspection.update({
        where: { id: row.id },
        data: { photosJson: null }
      });
      stats.cleared++;
    }
    logger.log(
      `[16l-cleanup] done. eligible=${stats.eligible} cleared=${stats.cleared} skipped=${stats.skipped} skippedSuspicious=${stats.skippedSuspicious}`
    );
    return stats;
  } finally {
    if (ownsPrisma) {
      try { await prisma.$disconnect(); } catch { /* ignore */ }
    }
  }
}

const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');
  } catch {
    return false;
  }
})();
if (isMain) {
  loadDotEnv();
  runCleanup().catch((err) => {
    console.error('[16l-cleanup] fatal:', err);
    process.exit(1);
  });
}
