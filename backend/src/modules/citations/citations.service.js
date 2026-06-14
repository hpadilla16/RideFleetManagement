// Citations module — service layer.
// Plan: doc/citations-tolls-fase-a-spec-2026-06-12.md
// Mirrors the toll module: ingest (idempotent) → match to vehicle+reservation →
// expose for the UI. Billing (posting to RentalAgreement.balance) is Phase E and
// lives OUTSIDE this file (money-gated). This module never moves money.

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

const VALID_SOURCES = new Set([
  'CITATION_PROCESSING_CENTER',
  'T2',
  'OCSO_COMPTROLLER',
  'VIOLATIONINFO',
  'MANUAL',
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
        const issuedAt = toDate(row.issuedAt);
        if (!citationNo || !issuedAt) {
          errors.push({ citationNo: citationNo || null, error: 'citationNo and issuedAt required' });
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
        vehicle: { select: { id: true, plate: true } },
        reservation: { select: { id: true, reservationNumber: true, pickupAt: true, returnAt: true } },
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

  async getVehicleHistory(vehicleId, scope = {}) {
    return prisma.citation.findMany({
      where: { tenantId: scope.tenantId, vehicleId },
      orderBy: { issuedAt: 'desc' },
      include: { reservation: { select: { id: true, reservationNumber: true } } },
    });
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
};

export default citationsService;
