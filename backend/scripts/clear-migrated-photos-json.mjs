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

export async function runCleanup({
  args = parseArgs(process.argv),
  prismaClient = null,
  logger = console
} = {}) {
  let prisma = prismaClient;
  if (!prisma) {
    const mod = await import('@prisma/client');
    prisma = new mod.PrismaClient();
  }
  const ownsPrisma = !prismaClient;
  const stats = { eligible: 0, cleared: 0, skipped: 0 };
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
      if (!args.commit) {
        stats.skipped++;
        continue;
      }
      await prisma.rentalAgreementInspection.update({
        where: { id: row.id },
        data: { photosJson: null }
      });
      stats.cleared++;
    }
    logger.log(
      `[16l-cleanup] done. eligible=${stats.eligible} cleared=${stats.cleared} skipped=${stats.skipped}`
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
