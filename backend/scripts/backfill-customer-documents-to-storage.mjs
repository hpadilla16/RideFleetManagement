#!/usr/bin/env node
/**
 * Backfill — migrate inline customer KYC documents (base64 / data: URLs) from
 * Postgres columns to Supabase Storage, then overwrite the column with the
 * Storage path. Mirrors backfill-inspection-photos-to-storage.mjs.
 *
 * Columns migrated:
 *   - Customer.idPhotoUrl
 *   - Customer.licenseBackUrl
 *   - Customer.insuranceDocumentUrl
 *   - RentalAgreement.insuranceDocumentUrl
 *
 * Usage:
 *   # Safety: dry-run by default. Inspect, then re-run with --commit.
 *   node backend/scripts/backfill-customer-documents-to-storage.mjs
 *   node backend/scripts/backfill-customer-documents-to-storage.mjs --commit
 *   node backend/scripts/backfill-customer-documents-to-storage.mjs --commit --limit 100
 *   node backend/scripts/backfill-customer-documents-to-storage.mjs --commit --tenant clx123abc
 *
 * Idempotent: a field already holding a Storage path or http URL is skipped.
 *
 * PRODUCTION-SCALE SAFETY — this script runs against tables holding GIGABYTES
 * of inline base64. Two rules make that safe:
 *   1. DISCOVERY is LIGHTWEIGHT: candidate ids are found via raw SQL that
 *      selects ONLY the id column (never the heavy blob bytes), filtered by a
 *      cheap predicate (inline = NOT NULL, length>0, not http(s), not a
 *      'tenants/' storage path). A naive `findMany` that selected the blob
 *      columns for ALL rows transferred gigabytes and hit Postgres'
 *      statement_timeout (57014) — that was the bug. We never do that.
 *   2. PROCESS ONE ROW AT A TIME: for each candidate id we fetch ONLY that
 *      single row's needed field(s), migrate, and move on. Memory is bounded to
 *      one row's blobs at any moment.
 *
 * Because a migrated field becomes 'tenants/...' it no longer matches the
 * discovery predicate, so the job is fully RESUMABLE/IDEMPOTENT: re-running
 * continues where it left off. Discovery+process loops in batches until no
 * candidates remain (or the --limit total is hit). The discovery predicate also
 * requires a non-null tenantId, so null-tenant rows (which can never be keyed
 * into tenant-scoped Storage) are excluded up front and cannot loop forever.
 *
 * SAFETY — read-back verification: after uploading a doc we download it again
 * and compare byte length to the source buffer. The column is overwritten with
 * the path ONLY when the read-back matches. A field that fails verification is
 * left untouched (still inline base64) and counted in `verifyFailed`. We never
 * lose a KYC doc.
 *
 * This does NOT null/clear anything else and does NOT VACUUM (runbook step).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeDocumentValue,
  uploadCustomerDocument,
  CUSTOMER_DOCS_BUCKET
} from '../src/modules/customers/customer-documents.js';
import {
  downloadObject as realDownloadObject
} from '../src/lib/storage/supabase-storage.js';

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
        'Usage: backfill-customer-documents-to-storage.mjs [--commit] [--limit N] [--tenant ID] [--batch N]'
      );
      process.exit(0);
    }
  }
  if (!out.batch || out.batch <= 0) out.batch = DEFAULT_BATCH;
  return out;
}

/**
 * SQL fragment: is column `col` an inline blob that needs migration?
 *   - NOT NULL, length > 0
 *   - NOT an http(s) URL
 *   - NOT already a 'tenants/' storage path
 * The column name is a trusted literal from this file (never user input).
 */
function inlinePredicate(col) {
  return (
    `("${col}" IS NOT NULL ` +
    `AND length("${col}") > 0 ` +
    `AND left("${col}", 5) <> 'http:' ` +
    `AND left("${col}", 6) <> 'https:' ` +
    `AND left("${col}", 8) <> 'tenants/')`
  );
}

/**
 * JS mirror of the SQL inline predicate, defending the per-row path: only
 * migrate a value that is non-empty, not http(s), not a 'tenants/' storage path.
 */
function isInlineValue(value) {
  if (value == null) return false;
  const s = String(value);
  if (s.length === 0) return false;
  if (/^https?:/i.test(s)) return false;
  if (s.startsWith('tenants/')) return false;
  return true;
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
    scanned: 0,
    fieldsMigrated: 0,
    fieldsSkipped: 0,
    verifyFailed: 0,
    noTenant: 0
  };

  // Cap on TOTAL rows processed across all batches (customers + agreements
  // combined). null = no cap.
  const totalLimit = args.limit && args.limit > 0 ? args.limit : null;
  const batchSize = args.batch;
  const remaining = () =>
    totalLimit == null ? batchSize : Math.min(batchSize, totalLimit - stats.scanned);

  // Upload one field, read it back, verify byte length, return the path or null.
  async function migrateField({ rawValue, tenantId, customerId, kind }) {
    const decoded = decodeDocumentValue(rawValue); // throws on empty/oversize
    if (decoded.passthrough) return { skip: true }; // http URL (predicate filters it)
    const sourceLen = decoded.buffer.byteLength;
    const storedPath = await uploadCustomerDocument({
      raw: rawValue,
      tenantId,
      customerId,
      kind,
      uploader: uploader || undefined,
      // This backfill does its OWN read-back verify below (tracked as
      // verifyFailed); skip the helper's internal verify to avoid a redundant
      // double-download and keep verify-failures counted (not thrown) here.
      downloader: false
    });
    // Read it back and verify byte length BEFORE we trust the path.
    let back;
    try {
      back = await download({ bucket: CUSTOMER_DOCS_BUCKET, path: storedPath });
    } catch (err) {
      return { verifyFailed: true, reason: `read-back failed: ${err?.message || err}` };
    }
    const backLen = back?.body?.byteLength ?? back?.size ?? null;
    if (backLen == null || backLen !== sourceLen) {
      return { verifyFailed: true, reason: `byte mismatch src=${sourceLen} back=${backLen}` };
    }
    return { path: storedPath };
  }

  const logProgress = () => {
    if (stats.scanned > 0 && stats.scanned % 25 === 0) {
      logger.log(
        `[customer-docs-backfill] progress scanned=${stats.scanned} ` +
          `migrated=${stats.fieldsMigrated} skipped=${stats.fieldsSkipped} ` +
          `verifyFailed=${stats.verifyFailed} noTenant=${stats.noTenant}`
      );
    }
  };

  // Forward-progress guard (per-invocation closure, so idempotency across
  // separate runBackfill calls is preserved). A batch "flipped" something if
  // migrated or skipped advanced since the last check — i.e. at least one
  // candidate stopped matching the discovery predicate. A full batch that only
  // verify-failed leaves every row still matching and must stop the loop.
  let _prevMigrated = 0;
  let _prevSkipped = 0;
  const flippedAnything = () => {
    const advanced =
      stats.fieldsMigrated > _prevMigrated || stats.fieldsSkipped > _prevSkipped;
    _prevMigrated = stats.fieldsMigrated;
    _prevSkipped = stats.fieldsSkipped;
    return advanced;
  };

  try {
    const customerCols = ['idPhotoUrl', 'licenseBackUrl', 'insuranceDocumentUrl'];
    // Require a non-null tenantId: null-tenant rows can't be keyed into
    // tenant-scoped Storage AND would otherwise keep matching the predicate
    // forever (infinite discovery loop). Excluding them here is both correct
    // and the forward-progress guarantee.
    const customerWhere =
      `"tenantId" IS NOT NULL AND (${customerCols.map(inlinePredicate).join(' OR ')})`;
    const agreementWhere = `"tenantId" IS NOT NULL AND (${inlinePredicate('insuranceDocumentUrl')})`;

    const tenantClause = args.tenant ? ' AND "tenantId" = $1' : '';

    // ── Lightweight COUNT (drives logging + the dry-run report). Counts the
    //    cheap predicate; NEVER transfers blob bytes. ──────────────────────
    const countSql = (table, where) =>
      `SELECT count(*)::int AS n FROM "${table}" WHERE ${where}${tenantClause}`;
    const runCount = async (table, where) => {
      const sql = countSql(table, where);
      const rows = args.tenant
        ? await prisma.$queryRawUnsafe(sql, args.tenant)
        : await prisma.$queryRawUnsafe(sql);
      return Number(rows?.[0]?.n ?? 0);
    };
    const customerCandidates = await runCount('Customer', customerWhere);
    const agreementCandidates = await runCount('RentalAgreement', agreementWhere);

    logger.log(
      `[customer-docs-backfill] ${args.commit ? 'COMMIT' : 'DRY-RUN'}: ` +
        `${customerCandidates} customer candidate rows + ${agreementCandidates} agreement candidate rows` +
        (args.tenant ? ` (tenant=${args.tenant})` : '') +
        (totalLimit ? ` (limit=${totalLimit})` : '')
    );

    // Discovery: returns ONLY ids (+ tenantId), ordered, limited. The blob
    // columns are NEVER selected here — that is the whole point.
    const discoverIds = async (table, where, limit) => {
      const sql = args.tenant
        ? `SELECT id, "tenantId" FROM "${table}" WHERE ${where} AND "tenantId" = $1 ORDER BY id LIMIT $2`
        : `SELECT id, "tenantId" FROM "${table}" WHERE ${where} ORDER BY id LIMIT $1`;
      return args.tenant
        ? prisma.$queryRawUnsafe(sql, args.tenant, limit)
        : prisma.$queryRawUnsafe(sql, limit);
    };

    // DRY-RUN stops here: the cheap counts are the whole report. No per-row
    // fetch, no blob transfer, no network, no DB writes.
    if (!args.commit) {
      logger.log(
        `[customer-docs-backfill] done (dry-run). ` +
          `customerCandidates=${customerCandidates} agreementCandidates=${agreementCandidates} ` +
          `scanned=0 fieldsMigrated=0`
      );
      return { ...stats, customerCandidates, agreementCandidates };
    }

    // ── Customers: batched discovery + per-row processing ─────────────────
    while (totalLimit == null || stats.scanned < totalLimit) {
      const want = remaining();
      if (want <= 0) break;
      const ids = await discoverIds('Customer', customerWhere, want);
      if (!ids || ids.length === 0) break;

      for (const { id: customerId, tenantId } of ids) {
        if (totalLimit != null && stats.scanned >= totalLimit) break;
        stats.scanned++;
        logProgress();

        // Fetch ONLY this single row's three doc fields (bounded memory).
        const row = await prisma.customer.findUnique({
          where: { id: customerId },
          select: { idPhotoUrl: true, licenseBackUrl: true, insuranceDocumentUrl: true }
        });
        if (!row) continue;

        const fields = [
          { field: 'idPhotoUrl', kind: 'id-photo', value: row.idPhotoUrl },
          { field: 'licenseBackUrl', kind: 'license-back', value: row.licenseBackUrl },
          { field: 'insuranceDocumentUrl', kind: 'insurance', value: row.insuranceDocumentUrl }
        ].filter((f) => isInlineValue(f.value));

        const patch = {};
        for (const f of fields) {
          try {
            const r = await migrateField({ rawValue: f.value, tenantId, customerId, kind: f.kind });
            if (r.skip) { stats.fieldsSkipped++; continue; }
            if (r.verifyFailed) {
              stats.verifyFailed++;
              logger.error(
                `[customer-docs-backfill] VERIFY FAILED Customer=${customerId} field=${f.field}: ${r.reason} (left inline)`
              );
              continue;
            }
            patch[f.field] = r.path;
            stats.fieldsMigrated++;
          } catch (err) {
            stats.verifyFailed++;
            logger.error(
              `[customer-docs-backfill] FAILED Customer=${customerId} field=${f.field}: ${err?.message || err} (left inline)`
            );
          }
        }
        if (Object.keys(patch).length) {
          await prisma.customer.update({ where: { id: customerId }, data: patch });
        }
      }

      // Partial batch ⇒ discovery exhausted. Full batch where NOTHING flipped a
      // column (every field verify-failed and stays inline) would re-match
      // forever — stop to guarantee forward progress.
      if (ids.length < want) break;
      if (!flippedAnything()) break;
    }

    // ── Rental agreements: batched discovery + per-row processing ─────────
    while (totalLimit == null || stats.scanned < totalLimit) {
      const want = remaining();
      if (want <= 0) break;
      const ids = await discoverIds('RentalAgreement', agreementWhere, want);
      if (!ids || ids.length === 0) break;

      for (const { id: agId, tenantId } of ids) {
        if (totalLimit != null && stats.scanned >= totalLimit) break;
        stats.scanned++;
        logProgress();

        const row = await prisma.rentalAgreement.findUnique({
          where: { id: agId },
          select: { insuranceDocumentUrl: true }
        });
        if (!row || !isInlineValue(row.insuranceDocumentUrl)) continue;

        try {
          const r = await migrateField({
            rawValue: row.insuranceDocumentUrl,
            tenantId,
            // No direct customerId here; key under the agreement id so paths
            // stay unique + traceable.
            customerId: agId,
            kind: 'insurance'
          });
          if (r.skip) { stats.fieldsSkipped++; continue; }
          if (r.verifyFailed) {
            stats.verifyFailed++;
            logger.error(
              `[customer-docs-backfill] VERIFY FAILED RentalAgreement=${agId}: ${r.reason} (left inline)`
            );
            continue;
          }
          await prisma.rentalAgreement.update({
            where: { id: agId },
            data: { insuranceDocumentUrl: r.path }
          });
          stats.fieldsMigrated++;
        } catch (err) {
          stats.verifyFailed++;
          logger.error(
            `[customer-docs-backfill] FAILED RentalAgreement=${agId}: ${err?.message || err} (left inline)`
          );
        }
      }
      if (ids.length < want) break;
      if (!flippedAnything()) break;
    }

    logger.log(
      `[customer-docs-backfill] done. scanned=${stats.scanned} ` +
        `customerCandidates=${customerCandidates} agreementCandidates=${agreementCandidates} ` +
        `fieldsMigrated=${stats.fieldsMigrated} fieldsSkipped=${stats.fieldsSkipped} ` +
        `verifyFailed=${stats.verifyFailed} noTenant=${stats.noTenant}`
    );
    return { ...stats, customerCandidates, agreementCandidates };
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
    console.error('[customer-docs-backfill] fatal:', err);
    process.exit(1);
  });
}
