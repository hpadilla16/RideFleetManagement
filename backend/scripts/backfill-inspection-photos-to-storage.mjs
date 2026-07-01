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
 * PRODUCTION-SCALE SAFETY — `photosJson` holds base64 image blobs, so the table
 * carries hundreds of MB. Two rules keep this safe at scale:
 *   1. DISCOVERY is LIGHTWEIGHT: candidate ids are found via raw SQL that
 *      selects ONLY the id column (never `photosJson`), filtered by a cheap
 *      predicate: photosJson is inline (NOT NULL, length>0) AND photoStorageRefs
 *      IS NULL. The old `findMany` pulled `photosJson` for ALL candidate rows in
 *      one shot, transferring the whole table and hitting Postgres'
 *      statement_timeout (57014) — that was the bug. We never do that.
 *      Doing the IS-NULL check in raw SQL also sidesteps the Prisma 6.x Json
 *      null quirk (a bare `null` literal throws); the Prisma.DbNull filter is
 *      kept only as the per-row defensive fallback path.
 *   2. PROCESS ONE ROW AT A TIME: for each candidate id we fetch ONLY that
 *      single row's photosJson, upload, update, and move on. Memory is bounded
 *      to one row's blob at any moment.
 *
 * Because a migrated row gets a non-null photoStorageRefs it no longer matches
 * the discovery predicate, so the job is fully RESUMABLE/IDEMPOTENT: re-running
 * continues where it left off. The predicate also requires a non-null tenantId
 * (via the joined RentalAgreement) so null-tenant rows are excluded up front and
 * cannot loop forever.
 *
 * NOTE: this does NOT delete the legacy photosJson column on success. That's
 * intentional — we leave a one-release safety net. The companion cleanup
 * script `clear-migrated-photos-json.mjs` nulls out photosJson after we've
 * verified the migration is happy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Prisma namespace imported eagerly only for the DbNull sentinel used in the
// per-row fallback Json-null filter (importing the namespace has no DB side
// effects). Primary discovery is raw SQL.
import { Prisma } from '@prisma/client';
import {
  uploadInspectionPhotosDetailed,
  getPhotosBucket
} from '../src/modules/rental-agreements/inspection-photos.js';
import { downloadObject as realDownloadObject } from '../src/lib/storage/supabase-storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rows pulled per discovery batch. Bounded: each batch returns only ids (not
// blobs), and we process one row at a time before fetching the next batch.
const DEFAULT_BATCH = 100;

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
  const out = { commit: false, limit: null, tenant: null, batch: DEFAULT_BATCH };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') out.commit = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--tenant') out.tenant = String(argv[++i] || '').trim() || null;
    else if (a === '--batch') out.batch = Number(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: backfill-inspection-photos-to-storage.mjs [--commit] [--limit N] [--tenant ID] [--batch N]'
      );
      process.exit(0);
    }
  }
  if (!out.batch || out.batch <= 0) out.batch = DEFAULT_BATCH;
  return out;
}

export async function runBackfill({
  args = parseArgs(process.argv),
  prismaClient = null,
  uploader = null,
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
  const stats = {
    total: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    noTenant: 0,
    empty: 0,
    verifyFailed: 0
  };

  const totalLimit = args.limit && args.limit > 0 ? args.limit : null;
  const batchSize = args.batch;
  const remaining = () =>
    totalLimit == null ? batchSize : Math.min(batchSize, totalLimit - stats.total);

  try {
    // Lightweight predicate over RentalAgreementInspection i joined to its
    // RentalAgreement r. Candidate = inline photosJson present, no storage refs
    // yet, non-null tenant. `i.id` only — NEVER select i."photosJson" here.
    const tenantClause = args.tenant ? ' AND r."tenantId" = $1' : '';
    const baseWhere =
      `i."photosJson" IS NOT NULL ` +
      `AND length(i."photosJson") > 0 ` +
      `AND i."photoStorageRefs" IS NULL ` +
      `AND r."tenantId" IS NOT NULL`;

    // ── Lightweight COUNT (drives logging + dry-run report). NEVER transfers
    //    the photosJson bytes. ───────────────────────────────────────────
    const countSql =
      `SELECT count(*)::int AS n ` +
      `FROM "RentalAgreementInspection" i ` +
      `JOIN "RentalAgreement" r ON r.id = i."rentalAgreementId" ` +
      `WHERE ${baseWhere}${tenantClause}`;
    const countRows = args.tenant
      ? await prisma.$queryRawUnsafe(countSql, args.tenant)
      : await prisma.$queryRawUnsafe(countSql);
    const candidates = Number(countRows?.[0]?.n ?? 0);

    logger.log(
      `[16l-backfill] ${args.commit ? 'COMMIT' : 'DRY-RUN'}: ${candidates} candidate inspections` +
        (args.tenant ? ` (tenant=${args.tenant})` : '') +
        (totalLimit ? ` (limit=${totalLimit})` : '')
    );

    // Discovery: ids + tenantId only, ordered, limited. NEVER selects photosJson.
    const discoverIds = async (limit) => {
      const sql =
        `SELECT i.id AS id, r."tenantId" AS "tenantId" ` +
        `FROM "RentalAgreementInspection" i ` +
        `JOIN "RentalAgreement" r ON r.id = i."rentalAgreementId" ` +
        `WHERE ${baseWhere}${tenantClause} ` +
        `ORDER BY i.id LIMIT ${args.tenant ? '$2' : '$1'}`;
      return args.tenant
        ? prisma.$queryRawUnsafe(sql, args.tenant, limit)
        : prisma.$queryRawUnsafe(sql, limit);
    };

    // DRY-RUN stops here: the cheap count is the whole report. No per-row fetch,
    // no blob transfer, no network, no DB writes.
    if (!args.commit) {
      logger.log(
        `[16l-backfill] done (dry-run). candidates=${candidates} total=0 migrated=0`
      );
      return { ...stats, candidates };
    }

    // Forward-progress guard (per-invocation): a batch flipped something if
    // migrated/skipped advanced. A full batch where nothing flipped (all
    // failed → row still matches predicate) must stop the loop.
    let _prevMigrated = 0;
    let _prevSkipped = 0;
    const flippedAnything = () => {
      const advanced = stats.migrated > _prevMigrated || stats.skipped > _prevSkipped;
      _prevMigrated = stats.migrated;
      _prevSkipped = stats.skipped;
      return advanced;
    };

    while (totalLimit == null || stats.total < totalLimit) {
      const want = remaining();
      if (want <= 0) break;
      const ids = await discoverIds(want);
      if (!ids || ids.length === 0) break;

      for (const { id, tenantId } of ids) {
        if (totalLimit != null && stats.total >= totalLimit) break;
        stats.total++;
        if (stats.total > 1 && stats.total % 25 === 0) {
          logger.log(
            `[16l-backfill] progress ${stats.total} migrated=${stats.migrated} skipped=${stats.skipped} failed=${stats.failed}`
          );
        }

        if (!tenantId) {
          // Defensive: predicate already excludes null-tenant rows.
          stats.noTenant++;
          stats.skipped++;
          continue;
        }

        // Fetch ONLY this single row's photosJson (bounded memory). The Prisma
        // findUnique selecting one column is the per-row read; the DbNull
        // sentinel remains available as a fallback discovery path if ever needed.
        const row = await prisma.rentalAgreementInspection.findUnique({
          where: { id },
          select: { photosJson: true, photoStorageRefs: true }
        });
        if (!row) { stats.skipped++; continue; }
        // Defensive idempotency: skip if already migrated (refs present).
        if (row.photoStorageRefs != null && row.photoStorageRefs !== Prisma.DbNull) {
          stats.skipped++;
          continue;
        }

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

        try {
          // HARDENED (prod incident 2026-06): upload AND read-back byte-verify
          // every photo. A row's photoStorageRefs is set ONLY if EVERY input
          // photo uploaded AND verified. If ANY photo fails verify, we do NOT
          // set refs (leave it a candidate, count verifyFailed) so the clear
          // step can NEVER null an unverified row.
          const result = await uploadInspectionPhotosDetailed({
            photos,
            tenantId,
            inspectionId: id,
            uploader: uploader || undefined,
            downloader: download, // <- mandatory read-back verify
            logger
          });
          const { refs, inputCount, uploadedCount, verifyFailed } = result;

          // Empty row (format #2 nulls, or nothing decodable) -> no refs, skip.
          if (inputCount === 0) {
            stats.empty++;
            stats.skipped++;
            continue;
          }

          // ANY shortfall (verify fail, decode/skip, partial upload) means the
          // row is NOT fully migrated. Leave photosJson intact, set no refs.
          if (verifyFailed > 0 || uploadedCount < inputCount || refs.length < inputCount) {
            stats.verifyFailed++;
            logger.error(
              `[16l-backfill] VERIFY-FAILED inspection=${id} tenant=${tenantId}: ` +
                `input=${inputCount} uploaded=${uploadedCount} verified=${refs.length} ` +
                `verifyFailed=${verifyFailed}; leaving photosJson intact (no refs set)`
            );
            continue;
          }

          await prisma.rentalAgreementInspection.update({
            where: { id },
            data: { photoStorageRefs: refs }
          });
          stats.migrated++;
        } catch (err) {
          stats.failed++;
          logger.error(
            `[16l-backfill] FAILED inspection=${id} tenant=${tenantId}: ${err?.message || err}`
          );
        }
      }

      if (ids.length < want) break; // discovery exhausted
      if (!flippedAnything()) break; // forward-progress guarantee
    }

    logger.log(
      `[16l-backfill] done. candidates=${candidates} total=${stats.total} migrated=${stats.migrated} skipped=${stats.skipped} failed=${stats.failed} verifyFailed=${stats.verifyFailed} noTenant=${stats.noTenant} empty=${stats.empty}`
    );
    return { ...stats, candidates };
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
