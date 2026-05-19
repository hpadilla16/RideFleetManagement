#!/usr/bin/env node
/**
 * 16l backfill — migrate RentalAgreementInspection.photosJson (base64 blobs)
 * to Supabase Storage and populate photoStorageRefs.
 *
 * Usage:
 *   # Safety: dry-run by default. Inspect what would happen, then re-run
 *   # with --commit to actually upload + update rows.
 *   node backend/scripts/backfill-inspection-photos-to-storage.mjs
 *   node backend/scripts/backfill-inspection-photos-to-storage.mjs --commit
 *   node backend/scripts/backfill-inspection-photos-to-storage.mjs --commit --limit 100
 *   node backend/scripts/backfill-inspection-photos-to-storage.mjs --commit --tenant clx123abc
 *
 * Idempotent: rows that already have non-empty photoStorageRefs are skipped.
 *
 * NOTE: this does NOT delete the legacy photosJson column on success. That's
 * intentional — we leave a one-release safety net. The companion cleanup
 * script `clear-migrated-photos-json.mjs` nulls out photosJson after we've
 * verified the migration is happy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Prisma is loaded lazily via dynamic import so tests can inject a stub
// without pulling in @prisma/client at module-eval time.
import { uploadInspectionPhotos } from '../src/modules/rental-agreements/inspection-photos.js';

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
        'Usage: backfill-inspection-photos-to-storage.mjs [--commit] [--limit N] [--tenant ID]'
      );
      process.exit(0);
    }
  }
  return out;
}

export async function runBackfill({
  args = parseArgs(process.argv),
  prismaClient = null,
  uploader = null,
  logger = console
} = {}) {
  let prisma = prismaClient;
  if (!prisma) {
    const mod = await import('@prisma/client');
    prisma = new mod.PrismaClient();
  }
  const ownsPrisma = !prismaClient;
  const stats = { total: 0, migrated: 0, skipped: 0, failed: 0, noTenant: 0, empty: 0 };
  try {
    // Fetch candidate inspections: photosJson present, no storage refs yet,
    // and optionally scoped to a single tenant.
    const where = {
      photosJson: { not: null },
      photoStorageRefs: null
    };
    if (args.tenant) {
      where.rentalAgreement = { tenantId: args.tenant };
    }

    const take = args.limit && args.limit > 0 ? args.limit : undefined;
    const rows = await prisma.rentalAgreementInspection.findMany({
      where,
      take,
      orderBy: { createdAt: 'asc' },
      include: {
        rentalAgreement: { select: { tenantId: true } }
      }
    });

    stats.total = rows.length;
    logger.log(
      `[16l-backfill] ${args.commit ? 'COMMIT' : 'DRY-RUN'}: ${rows.length} inspections to process` +
        (args.tenant ? ` (tenant=${args.tenant})` : '') +
        (take ? ` (limit=${take})` : '')
    );

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i > 0 && i % 25 === 0) {
        logger.log(
          `[16l-backfill] progress ${i}/${rows.length} migrated=${stats.migrated} skipped=${stats.skipped} failed=${stats.failed}`
        );
      }
      const tenantId = row.rentalAgreement?.tenantId || null;
      if (!tenantId) {
        stats.noTenant++;
        stats.skipped++;
        continue;
      }
      // Parse the legacy blob.
      let photos = null;
      try {
        photos = row.photosJson ? JSON.parse(row.photosJson) : null;
      } catch {
        photos = null;
      }
      if (!photos || typeof photos !== 'object' || Object.keys(photos).length === 0) {
        stats.empty++;
        stats.skipped++;
        continue;
      }

      if (!args.commit) {
        // Dry-run: count what we would upload but don't touch network or DB.
        const slotCount = Object.keys(photos).length;
        logger.log(
          `[16l-backfill] would migrate inspection=${row.id} tenant=${tenantId} slots=${slotCount}`
        );
        stats.skipped++;
        continue;
      }

      try {
        const refs = await uploadInspectionPhotos({
          photos,
          tenantId,
          inspectionId: row.id,
          uploader: uploader || undefined
        });
        if (!refs || refs.length === 0) {
          stats.empty++;
          stats.skipped++;
          continue;
        }
        await prisma.rentalAgreementInspection.update({
          where: { id: row.id },
          data: { photoStorageRefs: refs }
        });
        stats.migrated++;
      } catch (err) {
        stats.failed++;
        logger.error(
          `[16l-backfill] FAILED inspection=${row.id} tenant=${tenantId}: ${err?.message || err}`
        );
      }
    }

    logger.log(
      `[16l-backfill] done. total=${stats.total} migrated=${stats.migrated} skipped=${stats.skipped} failed=${stats.failed} noTenant=${stats.noTenant} empty=${stats.empty}`
    );
    return stats;
  } finally {
    if (ownsPrisma) {
      try { await prisma.$disconnect(); } catch { /* ignore */ }
    }
  }
}

// Only run when invoked directly, not when imported by tests.
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');
  } catch {
    return false;
  }
})();
if (isMain) {
  loadDotEnv();
  runBackfill().catch((err) => {
    console.error('[16l-backfill] fatal:', err);
    process.exit(1);
  });
}
