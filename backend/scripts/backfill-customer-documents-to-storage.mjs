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
  isStoragePath,
  uploadCustomerDocument,
  CUSTOMER_DOCS_BUCKET
} from '../src/modules/customers/customer-documents.js';
import {
  downloadObject as realDownloadObject
} from '../src/lib/storage/supabase-storage.js';

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
        'Usage: backfill-customer-documents-to-storage.mjs [--commit] [--limit N] [--tenant ID]'
      );
      process.exit(0);
    }
  }
  return out;
}

/**
 * Does this column value need migration? It must be a non-empty inline blob
 * (NOT already a Storage path, NOT an http(s) URL).
 */
function needsMigration(value) {
  if (value == null) return false;
  const s = String(value).trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (isStoragePath(s)) return false;
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

  // Upload one field, read it back, verify byte length, return the path or null.
  async function migrateField({ rawValue, tenantId, customerId, kind }) {
    const decoded = decodeDocumentValue(rawValue); // throws on empty/oversize
    if (decoded.passthrough) {
      // http URL — nothing to do (shouldn't reach here; needsMigration filters).
      return { skip: true };
    }
    const sourceLen = decoded.buffer.byteLength;
    const storedPath = await uploadCustomerDocument({
      raw: rawValue,
      tenantId,
      customerId,
      kind,
      uploader: uploader || undefined
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

  try {
    // ── Customers ────────────────────────────────────────────────────
    const customerWhere = {
      OR: [
        { idPhotoUrl: { not: null } },
        { licenseBackUrl: { not: null } },
        { insuranceDocumentUrl: { not: null } }
      ]
    };
    if (args.tenant) customerWhere.tenantId = args.tenant;

    const take = args.limit && args.limit > 0 ? args.limit : undefined;
    const customers = await prisma.customer.findMany({
      where: customerWhere,
      take,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        tenantId: true,
        idPhotoUrl: true,
        licenseBackUrl: true,
        insuranceDocumentUrl: true
      }
    });

    // ── Rental agreements ────────────────────────────────────────────
    const agreementWhere = { insuranceDocumentUrl: { not: null } };
    if (args.tenant) agreementWhere.tenantId = args.tenant;
    const agreements = await prisma.rentalAgreement.findMany({
      where: agreementWhere,
      take,
      orderBy: { createdAt: 'asc' },
      select: { id: true, tenantId: true, insuranceDocumentUrl: true }
    });

    const totalRows = customers.length + agreements.length;
    logger.log(
      `[customer-docs-backfill] ${args.commit ? 'COMMIT' : 'DRY-RUN'}: ` +
        `${customers.length} customers + ${agreements.length} agreements to scan` +
        (args.tenant ? ` (tenant=${args.tenant})` : '') +
        (take ? ` (limit=${take})` : '')
    );

    let processed = 0;
    const logProgress = () => {
      if (processed > 0 && processed % 25 === 0) {
        logger.log(
          `[customer-docs-backfill] progress ${processed}/${totalRows} ` +
            `migrated=${stats.fieldsMigrated} skipped=${stats.fieldsSkipped} ` +
            `verifyFailed=${stats.verifyFailed} noTenant=${stats.noTenant}`
        );
      }
    };

    // Process customers (two fields each).
    for (const cust of customers) {
      stats.scanned++;
      processed++;
      logProgress();

      const fields = [
        { field: 'idPhotoUrl', kind: 'id-photo', value: cust.idPhotoUrl },
        { field: 'licenseBackUrl', kind: 'license-back', value: cust.licenseBackUrl },
        { field: 'insuranceDocumentUrl', kind: 'insurance', value: cust.insuranceDocumentUrl }
      ].filter((f) => needsMigration(f.value));

      if (fields.length === 0) continue;

      const tenantId = cust.tenantId || null;
      if (!tenantId) {
        // Can't build a tenant-scoped Storage key — skip the whole row.
        stats.noTenant++;
        stats.fieldsSkipped += fields.length;
        continue;
      }

      const patch = {};
      for (const f of fields) {
        if (!args.commit) {
          logger.log(
            `[customer-docs-backfill] would migrate Customer=${cust.id} field=${f.field} tenant=${tenantId}`
          );
          stats.fieldsSkipped++;
          continue;
        }
        try {
          const r = await migrateField({
            rawValue: f.value, tenantId, customerId: cust.id, kind: f.kind
          });
          if (r.skip) { stats.fieldsSkipped++; continue; }
          if (r.verifyFailed) {
            stats.verifyFailed++;
            logger.error(
              `[customer-docs-backfill] VERIFY FAILED Customer=${cust.id} field=${f.field}: ${r.reason} (left inline)`
            );
            continue;
          }
          patch[f.field] = r.path;
          stats.fieldsMigrated++;
        } catch (err) {
          stats.verifyFailed++;
          logger.error(
            `[customer-docs-backfill] FAILED Customer=${cust.id} field=${f.field}: ${err?.message || err} (left inline)`
          );
        }
      }
      if (args.commit && Object.keys(patch).length) {
        await prisma.customer.update({ where: { id: cust.id }, data: patch });
      }
    }

    // Process rental agreements (one field each).
    for (const ag of agreements) {
      stats.scanned++;
      processed++;
      logProgress();

      if (!needsMigration(ag.insuranceDocumentUrl)) continue;

      const tenantId = ag.tenantId || null;
      if (!tenantId) {
        stats.noTenant++;
        stats.fieldsSkipped++;
        continue;
      }

      if (!args.commit) {
        logger.log(
          `[customer-docs-backfill] would migrate RentalAgreement=${ag.id} field=insuranceDocumentUrl tenant=${tenantId}`
        );
        stats.fieldsSkipped++;
        continue;
      }

      try {
        const r = await migrateField({
          rawValue: ag.insuranceDocumentUrl,
          tenantId,
          // Storage key namespaces by "customers/<id>"; the agreement has no
          // direct customerId in this slim select, so key the doc under the
          // agreement id to keep paths unique + traceable.
          customerId: ag.id,
          kind: 'insurance'
        });
        if (r.skip) { stats.fieldsSkipped++; continue; }
        if (r.verifyFailed) {
          stats.verifyFailed++;
          logger.error(
            `[customer-docs-backfill] VERIFY FAILED RentalAgreement=${ag.id}: ${r.reason} (left inline)`
          );
          continue;
        }
        await prisma.rentalAgreement.update({
          where: { id: ag.id },
          data: { insuranceDocumentUrl: r.path }
        });
        stats.fieldsMigrated++;
      } catch (err) {
        stats.verifyFailed++;
        logger.error(
          `[customer-docs-backfill] FAILED RentalAgreement=${ag.id}: ${err?.message || err} (left inline)`
        );
      }
    }

    logger.log(
      `[customer-docs-backfill] done. scanned=${stats.scanned} ` +
        `fieldsMigrated=${stats.fieldsMigrated} fieldsSkipped=${stats.fieldsSkipped} ` +
        `verifyFailed=${stats.verifyFailed} noTenant=${stats.noTenant}`
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
    console.error('[customer-docs-backfill] fatal:', err);
    process.exit(1);
  });
}
