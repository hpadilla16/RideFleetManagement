// Citations module — service layer.
// Plan: doc/citations-tolls-fase-a-spec-2026-06-12.md
// Mirrors the toll module: ingest (idempotent) → match to vehicle+reservation →
// expose for the UI. Billing (posting to RentalAgreement.balance) is Phase E and
// lives OUTSIDE this file (money-gated). This module never moves money.

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { uploadObject, getSignedUrl, safePath } from '../../lib/storage/index.js';
import { isStorageEnabled } from '../rental-agreements/inspection-photos.js';
import { resolveRate } from '../fees/fee-engine.service.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';
import { scopeAllowedLocationIds } from '../../lib/tenant-scope.js';

// ── Fase D (MONEY) — bill a matched citation to the renter's agreement ────────
// Mirrors the issue-center claim-charge path: create reservationCharge rows
// (source CITATION_MODULE = the fine, CITATION_ADMIN = the admin fee) then
// recompute pricing with { allowClosed: true } so the charge mirrors into the
// agreement and updates the unpaid balance even though citations arrive AFTER
// the rental closed. Idempotent (upsert by source+sourceRefId, prune stale).
// Only posts citations MATCHED to a reservation; NEVER charges a card — the
// renter pays via the normal contract/balance flow.
async function syncCitationCharges(reservationId, scope = {}) {
  if (!reservationId) return;
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
    select: { id: true, tenantId: true, pickupLocationId: true },
  });
  if (!reservation) return;
  const tenantId = reservation.tenantId || scope?.tenantId || null;
  if (!tenantId) return;

  const citations = await prisma.citation.findMany({
    where: { reservationId, tenantId, status: { notIn: ['VOID', 'DISPUTED', 'NEEDS_REVIEW'] } },
    select: { id: true, citationNo: true, agency: true, amount: true },
  });

  // null adminRate = the tenant turned the fee OFF → post the fine only.
  let adminAmount = 0;
  try {
    const r = await resolveRate({ tenantId, locationId: reservation.pickupLocationId || null, feeType: 'CITATION_ADMIN' });
    adminAmount = r ? Math.round(Number(r.amount || 0) * 100) / 100 : 0;
  } catch { adminAmount = 0; }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.reservationCharge.findMany({
      where: { reservationId, source: { in: ['CITATION_MODULE', 'CITATION_ADMIN'] } },
    });
    const byKey = new Map(existing.map((r) => [`${r.source}|${r.sourceRefId}`, r]));
    const agg = await tx.reservationCharge.aggregate({ where: { reservationId }, _max: { sortOrder: true } });
    let sort = Number(agg?._max?.sortOrder ?? -1) + 1;
    const keep = new Set();

    for (const c of citations) {
      const fineKey = `CITATION_MODULE|${c.id}`;
      keep.add(fineKey);
      const fineData = {
        code: 'CITATION',
        name: `Citation ${c.citationNo}${c.agency ? ` — ${c.agency}` : ''}`,
        chargeType: 'UNIT', quantity: 1,
        rate: Math.round(Number(c.amount || 0) * 100) / 100,
        total: Math.round(Number(c.amount || 0) * 100) / 100,
        taxable: false, selected: true,
      };
      const exF = byKey.get(fineKey);
      if (exF) await tx.reservationCharge.update({ where: { id: exF.id }, data: fineData });
      else await tx.reservationCharge.create({ data: { reservationId, ...fineData, source: 'CITATION_MODULE', sourceRefId: c.id, sortOrder: sort++ } });

      if (adminAmount > 0) {
        const feeKey = `CITATION_ADMIN|${c.id}`;
        keep.add(feeKey);
        const feeData = {
          code: 'CITATION_ADMIN', name: `Citation admin fee — ${c.citationNo}`,
          chargeType: 'UNIT', quantity: 1, rate: adminAmount, total: adminAmount, taxable: false, selected: true,
        };
        const exA = byKey.get(feeKey);
        if (exA) await tx.reservationCharge.update({ where: { id: exA.id }, data: feeData });
        else await tx.reservationCharge.create({ data: { reservationId, ...feeData, source: 'CITATION_ADMIN', sourceRefId: c.id, sortOrder: sort++ } });
      }
    }

    const staleIds = existing.filter((r) => !keep.has(`${r.source}|${r.sourceRefId}`)).map((r) => r.id);
    if (staleIds.length) await tx.reservationCharge.deleteMany({ where: { id: { in: staleIds } } });

    if (citations.length) {
      await tx.citation.updateMany({ where: { id: { in: citations.map((c) => c.id) } }, data: { billingStatus: 'POSTED_TO_AGREEMENT' } });
    }
  });

  try {
    await reservationPricingService.getPricing(reservationId, { tenantId }, { allowClosed: true });
  } catch (e) {
    logger.warn('[citations] balance recompute failed', { reservationId, message: String(e?.message || e) });
  }
}

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

/**
 * Location scoping for citations (2026-07-23). A Citation has NO Location FK —
 * its `location` column is free text from the issuing agency — so the only
 * reliable link to an RFM location is the vehicle the citation was matched to.
 * We scope through `vehicle.homeLocationId`.
 *
 * Unmatched citations (vehicleId = null) have no resolvable location, so a
 * location-scoped user does NOT see them (fail-closed, consistent with the rest
 * of the scoping layer). They stay visible to tenant-wide admins — who are the
 * ones that triage and match them anyway.
 *
 * Returns {} when the caller is unrestricted, so it composes into any `where`.
 */
export function citationLocationWhere(scope = {}) {
  const ids = scopeAllowedLocationIds(scope);
  if (!ids) return {};
  return { vehicle: { is: { homeLocationId: { in: ids } } } };
}

/**
 * Same scoping, one hop further out, for CitationDocument — the scanned notice
 * itself. This exists because the document routes are a SIDE DOOR into exactly
 * the file `getDocumentUrl` refuses: the OCR scheduler stamps
 * `Citation.documentPath = CitationDocument.bucketPath` (citation-ocr.scheduler
 * .js), so both point at the identical Supabase object, and `listDocuments`
 * hands out the ids to try.
 *
 * `CitationDocument.citationId` is a bare scalar (no Prisma relation), so we
 * can't express this as a relation filter — we resolve the visible ids out of
 * `Citation` first and match on them. Only runs for location-restricted
 * callers. Note the cost sits on `Citation`, which the daily scraper grows
 * monotonically (87 rows at the largest tenant today, so this is fine now):
 * the id list is unbounded, and `CitationDocument.citationId` carries no index
 * — @@index is ([tenantId, status, createdAt]). Revisit both at ~10k citations.
 *
 * Returns null when the caller is unrestricted (= no filter). Otherwise an id
 * list, possibly EMPTY: `{ citationId: { in: [] } }` matches nothing, which is
 * the fail-closed answer, and it also excludes documents not yet matched to a
 * citation (citationId = null) — same rule as unmatched citations, which the
 * tenant-wide admin triages.
 */
async function visibleCitationIds(scope = {}) {
  const locWhere = citationLocationWhere(scope);
  if (!Object.keys(locWhere).length) return null;
  const rows = await prisma.citation.findMany({
    where: { tenantId: scope.tenantId, ...locWhere },
    select: { id: true },
  });
  return rows.map((r) => r.id);
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
    const billReservationIds = new Set(); // Fase D: auto-post charges for newly matched citations

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
          billReservationIds.add(reservation.id);
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

    // Fase D (MONEY): auto-post citation + admin-fee charges for the reservations
    // that got a matched citation in this batch (idempotent; balance-only).
    for (const rid of billReservationIds) {
      try { await syncCitationCharges(rid, { tenantId }); }
      catch (e) { logger.warn('[citations] auto-bill failed', { reservationId: rid, message: String(e?.message || e) }); }
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
    const where = { tenantId: scope.tenantId, ...citationLocationWhere(scope) };
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
      // Location-scoped too: without this a restricted user could open another
      // branch's citation by guessing/holding its id, even though the list hides it.
      where: { id, tenantId: scope.tenantId, ...citationLocationWhere(scope) },
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
    // Surface OCR-extracted "how to pay" info (Notice #, PIN, phone) from the
    // stored payload so the UI can show it without re-opening the document.
    let paymentFields = [];
    let paymentPhone = null;
    if (citation.sourcePayloadJson) {
      try {
        const raw = JSON.parse(citation.sourcePayloadJson);
        if (Array.isArray(raw?.paymentFields)) {
          paymentFields = raw.paymentFields
            .filter((x) => x && x.value)
            .map((x) => ({ label: String(x.label || '').slice(0, 48), value: String(x.value || '').slice(0, 96) }))
            .slice(0, 8);
        }
        if (raw?.paymentPhone) paymentPhone = String(raw.paymentPhone).slice(0, 48);
      } catch { /* ignore malformed payload */ }
    }
    return { ...citation, paymentFields, paymentPhone };
  },

  // Signed (1h) URL for the scanned notice behind a citation (its documentPath).
  async getDocumentUrl(id, scope = {}) {
    const citation = await prisma.citation.findFirst({
      // Scoped like getDetail — the document is the citation's content, so it
      // must not be reachable by id from outside the caller's locations.
      where: { id, tenantId: scope.tenantId, ...citationLocationWhere(scope) },
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

  // Lightweight summary for the dashboard Citations tile.
  async dashboardSummary(scope = {}) {
    const where = { tenantId: scope.tenantId, ...citationLocationWhere(scope) };
    const [needsReview, open] = await Promise.all([
      prisma.citation.count({ where: { ...where, status: 'NEEDS_REVIEW' } }),
      prisma.citation.findMany({
        where: { ...where, status: { notIn: ['VOID', 'DISPUTED'] } },
        select: { amount: true, fee: true },
      }),
    ]);
    const outstanding = open.reduce((s, c) => s + Number(c.amount || 0) + Number(c.fee || 0), 0);
    return { needsReview, openCount: open.length, outstanding: Math.round(outstanding * 100) / 100 };
  },

  async getVehicleHistory(vehicleId, scope = {}) {
    return prisma.citation.findMany({
      where: { tenantId: scope.tenantId, vehicleId, ...citationLocationWhere(scope) },
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
    // Location-scoped: a restricted user must not be able to REVIEW (approve /
    // dispute / void) another branch's citation, not just be unable to see it.
    const citation = await prisma.citation.findFirst({ where: { id, tenantId: scope.tenantId, ...citationLocationWhere(scope) }, select: { id: true, reservationId: true } });
    if (!citation) {
      const err = new Error('Citation not found');
      err.status = 404;
      throw err;
    }
    const map = { CONFIRM: 'MATCHED', REJECT: 'NEEDS_REVIEW', DISPUTE: 'DISPUTED', VOID: 'VOID' };
    const next = map[decision];
    if (!next) throw new Error('invalid decision');
    const updated = await prisma.citation.update({
      where: { id },
      data: {
        status: next,
        needsReview: next === 'NEEDS_REVIEW',
        reviewNotes: note ? String(note).slice(0, 2000) : undefined,
      },
    });
    // Fase D (MONEY): recompute this reservation's citation charges so the balance
    // reflects the decision (CONFIRM posts; VOID/DISPUTE/REJECT prune). Idempotent.
    if (citation.reservationId) {
      try { await syncCitationCharges(citation.reservationId, { tenantId: scope.tenantId }); }
      catch (e) { logger.warn('[citations] review re-bill failed', { reservationId: citation.reservationId, message: String(e?.message || e) }); }
    }
    return updated;
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
    const visibleIds = await visibleCitationIds(scope);
    if (visibleIds) where.citationId = { in: visibleIds };
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
    const visibleIds = await visibleCitationIds(scope);
    const doc = await prisma.citationDocument.findFirst({
      where: { id, tenantId: scope.tenantId, ...(visibleIds ? { citationId: { in: visibleIds } } : {}) },
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
    // The scoped guard that matters most: this returns a signed URL to the very
    // same object `getDocumentUrl` protects. See visibleCitationIds() above.
    const visibleIds = await visibleCitationIds(scope);
    const doc = await prisma.citationDocument.findFirst({
      where: { id, tenantId: scope.tenantId, ...(visibleIds ? { citationId: { in: visibleIds } } : {}) },
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
