// Citations module — service layer.
// Plan: doc/citations-tolls-fase-a-spec-2026-06-12.md
// Mirrors the toll module: ingest (idempotent) → match to vehicle+reservation →
// expose for the UI. Billing (posting to RentalAgreement.balance) is Phase E and
// lives OUTSIDE this file (money-gated). This module never moves money.

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { uploadObject, getSignedUrl, safePath } from '../../lib/storage/index.js';
import { isStorageEnabled } from '../rental-agreements/inspection-photos.js';

// OCR mail intake (Fase A): notice documents reuse the existing Supabase bucket
// (same pattern as vehicle registration docs) — no new bucket/env needed. The
// shared INSPECTION_PHOTOS_STORAGE_ENABLED flag gates it via isStorageEnabled().
const CITATION_DOC_BUCKET = process.env.SUPABASE_STORAGE_INVENTORY_BUCKET || 'inventory-photos';
const CITATION_DOC_MAX_BYTES = 15 * 1024 * 1024;

const VALID_SOURCES = new Set([
  'CITATION_PROCESSING_CENTER',
  'T2',
  'OCSO_COMPTROLLER',
  'VIOLATIONINFO',
  'MANUAL',
  'MAIL_OCR',
]);

// Same normalization the toll matcher uses (tolls.service.js).
function normalizePlate(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// Build a normalized-plate → vehicleId map for the tenant once per batch.
async function buildVehiclePlateMap(tenantId) {
  const vehicles = await prisma.vehicle.findMany({
    where: { tenantId, plate: { not: null } },
    select: { id: true, plate: true },
  });
  const map = new Map();
  for (const v of vehicles) {
    const norm = normalizePlate(v.plate);
    if (!norm) continue;
    // First write wins; ambiguous plates are rare and caught in review.
    if (!map.has(norm)) map.set(norm, v.id);
  }
  return map;
}

// Find the rental whose window contains the citation timestamp for this vehicle.
async function findMatchingReservation(tenantId, vehicleId, issuedAt) {
  if (!vehicleId || !issuedAt) return null;
  return prisma.reservation.findFirst({
    where: {
      tenantId,
      vehicleId,
      pickupAt: { lte: issuedAt },
      returnAt: { gte: issuedAt },
    },
    orderBy: { pickupAt: 'desc' },
    select: { id: true, reservationNumber: true },
  });
}

// Statuses we will NOT overwrite on re-ingest (human/billing decisions are sticky).
const STICKY = new Set(['BILLED', 'DISPUTED', 'VOID']);

export const citationsService = {
  normalizePlate,

  /**
   * Idempotent batch ingest. Called by the internal ingest endpoint (droplet)
   * and by the manual-import route. Upserts by (tenantId, source, citationNo),
   * then matches each to a vehicle + active reservation (two-level amarre).
   */
  async ingestBatch({ tenantId, source, sourceAccountId = null, sourceType = 'DROPLET_SCRAPE', rows }) {
    if (!tenantId) throw new Error('tenantId required');
    if (!VALID_SOURCES.has(source)) throw new Error(`invalid source: ${source}`);
    if (!Array.isArray(rows)) throw new Error('rows must be an array');

    const run = await prisma.citationImportRun.create({
      data: { tenantId, sourceAccountId, source, sourceType, status: 'IN_PROGRESS' },
    });

    const vehicleMap = await buildVehiclePlateMap(tenantId);
    let imported = 0;
    let matched = 0;
    let review = 0;
    const errors = [];

    for (const row of rows) {
      try {
        const citationNo = String(row.citationNo || '').trim();
        // issuedAt is OPTIONAL (2026-06-14): list-only sources have no date yet.
        // Null → the citation binds to the vehicle (by plate) and stays
        // NEEDS_REVIEW since reservation matching needs the timestamp.
        const issuedAt = toDate(row.issuedAt);
        if (!citationNo) {
          errors.push({ citationNo: citationNo || null, error: 'citationNo required' });
          continue;
        }
        const plateNormalized = normalizePlate(row.plateNormalized || row.plate);
        const vehicleId = plateNormalized ? vehicleMap.get(plateNormalized) || null : null;

        const base = {
          tenantId,
          source,
          sourceAccountId,
          importRunId: run.id,
          citationNo,
          agency: String(row.agency || 'Unknown agency'),
          violationType: row.violationType || null,
          plateRaw: row.plate || row.plateRaw || null,
          plateNormalized: plateNormalized || null,
          plateState: row.plateState ? String(row.plateState).toUpperCase().slice(0, 4) : null,
          issuedAt,
          amount: toMoney(row.amount),
          fee: toMoney(row.fee),
          dueAt: toDate(row.dueAt),
          location: row.location || null,
          externalUrl: row.externalUrl || null,
          documentPath: row.documentPath || row.documentUrl || null,
          vehicleId,
          sourcePayloadJson: row.raw ? JSON.stringify(row.raw).slice(0, 20000) : null,
        };

        // Upsert without clobbering sticky human/billing state.
        const existing = await prisma.citation.findUnique({
          where: { tenantId_source_citationNo: { tenantId, source, citationNo } },
          select: { id: true, status: true },
        });

        let citation;
        if (!existing) {
          citation = await prisma.citation.create({ data: base });
        } else if (STICKY.has(existing.status)) {
          // Keep sticky state; only refresh non-decision fields.
          citation = await prisma.citation.update({
            where: { id: existing.id },
            data: { amount: base.amount, fee: base.fee, dueAt: base.dueAt, externalUrl: base.externalUrl, documentPath: base.documentPath },
          });
          imported += 1;
          continue;
        } else {
          citation = await prisma.citation.update({ where: { id: existing.id }, data: base });
        }

        // Two-level amarre: vehicleId already set above (level 1). Now reservation.
        const reservation = await findMatchingReservation(tenantId, vehicleId, issuedAt);
        if (reservation) {
          await prisma.citation.update({
            where: { id: citation.id },
            data: { reservationId: reservation.id, status: 'MATCHED', needsReview: false, matchConfidence: 90 },
          });
          const hasAssignment = await prisma.citationAssignment.findFirst({
            where: { citationId: citation.id, reservationId: reservation.id },
            select: { id: true },
          });
          if (!hasAssignment) {
            await prisma.citationAssignment.create({
              data: {
                tenantId,
                citationId: citation.id,
                reservationId: reservation.id,
                vehicleId,
                status: 'AUTO_CONFIRMED',
                confidence: 90,
                matchReason: 'plate + timestamp within rental window',
              },
            });
          }
          matched += 1;
        } else {
          await prisma.citation.update({
            where: { id: citation.id },
            data: { status: 'NEEDS_REVIEW', needsReview: true },
          });
          review += 1;
        }
        imported += 1;
      } catch (err) {
        errors.push({ citationNo: row?.citationNo || null, error: String(err?.message || err) });
        logger.warn('[citations] ingest row failed', { error: String(err?.message || err) });
      }
    }

    await prisma.citationImportRun.update({
      where: { id: run.id },
      data: {
        status: errors.length && imported === 0 ? 'FAILED' : 'SUCCESS',
        completedAt: new Date(),
        importedCount: imported,
        matchedCount: matched,
        reviewCount: review,
        errorMessage: errors.length ? `${errors.length} row error(s)` : null,
        metadataJson: errors.length ? JSON.stringify(errors).slice(0, 10000) : null,
      },
    });

    return { runId: run.id, imported, matched, review, errors };
  },

  async list(filters = {}, scope = {}) {
    const where = { tenantId: scope.tenantId };
    if (filters.plate) where.plateNormalized = normalizePlate(filters.plate);
    if (filters.plateState) where.plateState = String(filters.plateState).toUpperCase();
    if (filters.source && VALID_SOURCES.has(filters.source)) where.source = filters.source;
    if (filters.status) where.status = filters.status;
    if (filters.citationNo) where.citationNo = { contains: String(filters.citationNo), mode: 'insensitive' };
    if (filters.agency) where.agency = { contains: String(filters.agency), mode: 'insensitive' };
    if (filters.from || filters.to) {
      where.issuedAt = {};
      if (filters.from) where.issuedAt.gte = toDate(filters.from);
      if (filters.to) where.issuedAt.lte = toDate(filters.to);
    }
    const take = Math.min(Number(filters.pageSize) || 50, 200);
    const skip = ((Math.max(Number(filters.page) || 1, 1)) - 1) * take;

    const [rows, total] = await Promise.all([
      prisma.citation.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        take,
        skip,
        include: { vehicle: { select: { id: true, plate: true } }, reservation: { select: { id: true, reservationNumber: true } } },
      }),
      prisma.citation.count({ where }),
    ]);
    return { rows, total, page: Math.max(Number(filters.page) || 1, 1), pageSize: take };
  },

  async getDetail(id, scope = {}) {
    const citation = await prisma.citation.findFirst({
      where: { id, tenantId: scope.tenantId },
      include: {
        vehicle: { select: { id: true, plate: true, year: true, make: true, model: true } },
        reservation: {
          select: {
            id: true, reservationNumber: true, pickupAt: true, returnAt: true,
            customer: { select: { id: true, firstName: true, lastName: true } },
          },
        },
        assignments: true,
      },
    });
    if (!citation) {
      const err = new Error('Citation not found');
      err.status = 404;
      throw err;
    }
    return citation;
  },

  // Signed (1h) URL for the scanned notice behind a citation (its documentPath).
  async getDocumentUrl(id, scope = {}) {
    const citation = await prisma.citation.findFirst({
      where: { id, tenantId: scope.tenantId },
      select: { documentPath: true },
    });
    if (!citation) {
      const err = new Error('Citation not found');
      err.status = 404;
      throw err;
    }
    const ref = String(citation.documentPath || '');
    if (!ref) return { url: null };
    if (ref.startsWith('http')) return { url: ref };
    const idx = ref.indexOf(':');
    if (idx <= 0) return { url: null };
    const url = await getSignedUrl({ bucket: ref.slice(0, idx), path: ref.slice(idx + 1), expiresIn: 3600 });
    return { url };
  },

  async getVehicleHistory(vehicleId, scope = {}) {
    return prisma.citation.findMany({
      where: { tenantId: scope.tenantId, vehicleId },
      orderBy: { issuedAt: 'desc' },
      include: { reservation: { select: { id: true, reservationNumber: true } } },
    });
  },

  /**
   * Active plates for a tenant — the search list the droplet CPC/T2 adapters
   * poll. Returned to the internal /plates endpoint so the scraper never holds
   * a stale hand-seeded file: new vehicles are picked up automatically, SOLD
   * units drop out. Sitting / Hold-for-Sale (OUT_OF_SERVICE) units stay IN —
   * a parked car can still draw a citation we're liable for.
   *
   * State is NOT hardcoded: it comes from each vehicle's HOME LOCATION
   * (`Location.state`), so an Orlando/Ft-Lauderdale/Miami vehicle reports FL and
   * a future CA market reports CA with zero code changes. `defaultState` is only
   * the fallback for vehicles whose home location has no state set (or none).
   */
  async listActivePlates(tenantId, { defaultState = 'FL', requireEnabled = false } = {}) {
    if (!tenantId) throw new Error('tenantId required');
    // Settings gate: when asked directly (single-tenant endpoint), only return
    // plates if the tenant has Citations turned ON in settings. The source-based
    // discovery already filters by citationsEnabled at the account query, so it
    // skips this per-tenant recheck.
    if (requireEnabled) {
      const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { citationsEnabled: true } });
      if (!t?.citationsEnabled) return [];
    }
    const vehicles = await prisma.vehicle.findMany({
      where: { tenantId, plate: { not: null }, status: { not: 'SOLD' } },
      select: { plate: true, homeLocation: { select: { state: true } } },
      orderBy: { plate: 'asc' },
    });
    const seen = new Set();
    const plates = [];
    for (const v of vehicles) {
      const plate = String(v.plate || '').trim();
      if (!plate) continue;
      const key = plate.toUpperCase();
      if (seen.has(key)) continue; // de-dupe; ambiguous plates rare
      seen.add(key);
      const state = String(v.homeLocation?.state || defaultState || 'FL').toUpperCase();
      plates.push({ plate, state });
    }
    return plates;
  },

  /**
   * Plug-and-play discovery for the droplet adapters. Given a citation SOURCE
   * (e.g. CITATION_PROCESSING_CENTER, T2), return the active plates for EVERY
   * tenant that has an active CitationSourceAccount for that source — i.e. every
   * tenant we actually have that service for. Grouped by tenant because ingest
   * is per-tenant. Onboard a new tenant/location + give it a source account and
   * it joins the nightly run automatically — no per-tenant config in the scraper.
   */
  async listPlatesForSource(source) {
    if (!VALID_SOURCES.has(source)) throw new Error(`invalid source: ${source}`);
    // Two gates, both required: the tenant has Citations ON in settings
    // (citationsEnabled) AND an active source account for this source (= we have
    // the service for that jurisdiction). Either off → tenant is skipped.
    const accounts = await prisma.citationSourceAccount.findMany({
      where: { source, isActive: true, tenant: { citationsEnabled: true } },
      select: { tenantId: true },
    });
    const tenantIds = [...new Set(accounts.map((a) => a.tenantId))];
    const tenants = [];
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      const plates = await this.listActivePlates(tenantId);
      tenants.push({ tenantId, count: plates.length, plates });
    }
    return { source, tenantCount: tenants.length, tenants };
  },

  /**
   * Lightweight review action. decision: CONFIRM | REJECT | DISPUTE | VOID.
   * Does NOT post charges (that is Phase E, money-gated).
   */
  async review(id, { decision, note, userId } = {}, scope = {}) {
    const citation = await prisma.citation.findFirst({ where: { id, tenantId: scope.tenantId }, select: { id: true } });
    if (!citation) {
      const err = new Error('Citation not found');
      err.status = 404;
      throw err;
    }
    const map = { CONFIRM: 'MATCHED', REJECT: 'NEEDS_REVIEW', DISPUTE: 'DISPUTED', VOID: 'VOID' };
    const next = map[decision];
    if (!next) throw new Error('invalid decision');
    return prisma.citation.update({
      where: { id },
      data: {
        status: next,
        needsReview: next === 'NEEDS_REVIEW',
        reviewNotes: note ? String(note).slice(0, 2000) : undefined,
      },
    });
  },

  // ── OCR mail intake — Fase A (document plumbing) ──────────────────────────
  // A scanned/emailed citation notice lands here as a CitationDocument (PENDING)
  // with the file in Supabase Storage. The Fase B worker extracts fields and
  // calls ingestBatch. No money, no matching here — just intake + storage.

  /** Upload a notice (base64 data URL) → Supabase + CitationDocument(PENDING). */
  async saveDocument({ tenantId, dataUrl, sourceChannel = 'UPLOAD', uploadedByUserId = null }) {
    if (!tenantId) throw new Error('tenantId required');
    if (!isStorageEnabled()) throw new Error('Document storage is not enabled');
    const match = /^data:([\w/.+-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!match) throw new Error('document must be a base64 data URL');
    const contentType = match[1];
    const body = Buffer.from(match[2], 'base64');
    if (!body.length) throw new Error('document is empty');
    if (body.length > CITATION_DOC_MAX_BYTES) throw new Error('document exceeds 15MB');
    const ext = contentType.includes('pdf') ? 'pdf' : contentType.includes('png') ? 'png' : 'jpg';
    const channel = ['UPLOAD', 'EMAIL', 'MAILBOX'].includes(String(sourceChannel).toUpperCase())
      ? String(sourceChannel).toUpperCase() : 'UPLOAD';
    const path = safePath('citation-docs', tenantId, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    await uploadObject({ bucket: CITATION_DOC_BUCKET, path, body, contentType, upsert: false });
    const doc = await prisma.citationDocument.create({
      data: {
        tenantId,
        bucketPath: `${CITATION_DOC_BUCKET}:${path}`,
        contentType,
        sourceChannel: channel,
        status: 'PENDING',
        uploadedByUserId: uploadedByUserId || null,
      },
      select: { id: true, status: true, sourceChannel: true, createdAt: true },
    });
    return doc;
  },

  /** List notice documents for the tenant (newest first). */
  async listDocuments(scope = {}, filters = {}) {
    const where = { tenantId: scope.tenantId };
    if (filters.status) where.status = String(filters.status).toUpperCase();
    const take = Math.min(Number(filters.pageSize) || 50, 200);
    const skip = ((Math.max(Number(filters.page) || 1, 1)) - 1) * take;
    const [rows, total] = await Promise.all([
      prisma.citationDocument.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true, sourceChannel: true, status: true, confidence: true,
          citationId: true, error: true, createdAt: true, contentType: true,
        },
      }),
      prisma.citationDocument.count({ where }),
    ]);
    return { rows, total, page: Math.max(Number(filters.page) || 1, 1), pageSize: take };
  },

  /** Reset a FAILED/REVIEW notice document back to PENDING so the OCR worker retries it. */
  async retryDocument(id, scope = {}) {
    const doc = await prisma.citationDocument.findFirst({
      where: { id, tenantId: scope.tenantId },
      select: { id: true, status: true },
    });
    if (!doc) {
      const err = new Error('Document not found');
      err.status = 404;
      throw err;
    }
    if (!['FAILED', 'REVIEW'].includes(String(doc.status).toUpperCase())) {
      throw new Error('Only FAILED or REVIEW documents can be retried');
    }
    await prisma.citationDocument.update({
      where: { id: doc.id },
      data: { status: 'PENDING', error: null },
    });
    return { id: doc.id, status: 'PENDING' };
  },

  /** Signed (1h) URL for a stored notice document. */
  async getDocumentSignedUrl(id, scope = {}) {
    const doc = await prisma.citationDocument.findFirst({
      where: { id, tenantId: scope.tenantId },
      select: { bucketPath: true },
    });
    if (!doc) {
      const err = new Error('Document not found');
      err.status = 404;
      throw err;
    }
    const ref = String(doc.bucketPath || '');
    const idx = ref.indexOf(':');
    if (ref.startsWith('http')) return { url: ref };
    if (idx <= 0) return { url: null };
    const url = await getSignedUrl({ bucket: ref.slice(0, idx), path: ref.slice(idx + 1), expiresIn: 3600 });
    return { url };
  },
};

export default citationsService;
