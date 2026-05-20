#!/usr/bin/env node
// scripts/tl-rematch-existing.mjs
//
// One-shot rematch script for the TL International integration.
//
// Background
// ----------
// 123 ExternalReservation rows were ingested before the
// AcrissCategoryMap and LocationCodeMap tables were seeded. Every one
// of them ended up in `promotionStatus='MANUAL_REVIEW'` with
// `needsReviewReason='acriss_unmapped'`. Now that the maps are
// populated (12 ACRISS entries, 1 LocationCodeMap: SJUA01 -> SJU), we
// want to re-evaluate every PENDING/MANUAL_REVIEW row, auto-create
// Customer records where appropriate (TL imports come with real
// name/email/phone/country), and promote the survivors to
// Reservation(status=PENDING_FRANCHISE_IMPORT).
//
// Behavior
// --------
//   1. Loads every ExternalReservation where
//      sourceSystem='TL_INTERNATIONAL' AND
//      promotionStatus IN ('PENDING', 'MANUAL_REVIEW').
//   2. For each row, re-runs evaluatePromotion() -- single source of
//      truth, same matcher the worker uses.
//   3. If decision = AUTO -> promote (Reservation + ExternalReservation
//      update) inside a transaction.
//   4. If decision = MANUAL_REVIEW with reason=customer_not_found AND
//      we have enough customer data to create one -> create Customer,
//      then promote.
//   5. Any other MANUAL_REVIEW reason -> update needsReviewReason and
//      leave alone.
//   6. Already-PROMOTED / AUTO_PROMOTED / REJECTED rows are skipped.
//
// Idempotent: subsequent runs find nothing to do because the rows
// have moved out of the PENDING/MANUAL_REVIEW filter.
//
// Usage
// -----
//   # dry run (default -- writes nothing)
//   node scripts/tl-rematch-existing.mjs
//
//   # actually apply changes
//   node scripts/tl-rematch-existing.mjs --commit
//
//   # cap the number of rows processed
//   node scripts/tl-rematch-existing.mjs --commit --limit 5

import {
  evaluatePromotion,
  extractLocationCode,
  REVIEW_REASONS,
} from '../src/modules/integrations/tl-international/promotion-matcher.service.js';
import { findDuplicateReservation } from '../src/modules/integrations/tl-international/duplicate-detector.service.js';

const SOURCE_SYSTEM = 'TL_INTERNATIONAL';
const PROGRESS_EVERY = 25;
const BOOKING_CHANNEL = 'FRANCHISE_TL';

/**
 * Decide whether we have enough info on the ExternalReservation to
 * spin up a brand-new Customer record. Need email OR (firstName +
 * lastName). Phone is required by the schema but we always synthesize
 * a fallback in buildCustomerCreateData so we never fail NOT NULL.
 */
export function canAutoCreateCustomer(extRes) {
  if (!extRes) return false;
  const email = (extRes.customerEmail || '').trim();
  const first = (extRes.customerFirstName || '').trim();
  const last = (extRes.customerLastName || '').trim();
  if (!email && !(first && last)) return false;
  return true;
}

/**
 * Build the Customer.create payload from an ExternalReservation. Empty
 * strings collapse to null where the schema allows; phone has a
 * deterministic fallback because the column is NOT NULL.
 */
export function buildCustomerCreateData(extRes) {
  const email = (extRes.customerEmail || '').trim() || null;
  const phoneRaw = (extRes.customerPhone || '').trim();
  const first = (extRes.customerFirstName || '').trim();
  const last = (extRes.customerLastName || '').trim();
  const country = (extRes.customerCountry || '').trim() || null;

  // Phone is NOT NULL in the schema. Use phone || email || a
  // deterministic externalRef-stamped placeholder so we never crash
  // mid-batch on a phone-less row.
  const phoneFinal = phoneRaw || email || `tl:${extRes.externalRef || extRes.id || 'unknown'}`;

  return {
    tenantId: extRes.tenantId || null,
    firstName: first || '(TL Import)',
    lastName: last || extRes.externalRef || 'Unknown',
    email,
    phone: phoneFinal,
    country,
    notes: `Auto-created from TL International import -- ${extRes.externalRef || extRes.id}`,
  };
}

/**
 * Resolve a VehicleType.id for the given tenant + mapped category
 * string. Matches on VehicleType.code (case-insensitive). Returns
 * null if nothing matches.
 */
export async function resolveVehicleTypeId(prismaLike, tenantId, vehicleCategory) {
  if (!vehicleCategory) return null;
  const vt = await prismaLike.vehicleType.findFirst({
    where: {
      tenantId,
      code: { equals: vehicleCategory, mode: 'insensitive' },
    },
    select: { id: true },
  }).catch(() => null);
  return vt?.id || null;
}

/**
 * Compose the Reservation.create payload. Pure -- no Prisma calls.
 */
export function buildReservationCreateData(extRes, customerId, locationId, vehicleTypeId) {
  const pickupAt = extRes.pickupAt || new Date();
  const returnAt = extRes.dropoffAt || new Date(pickupAt.getTime() + 3 * 24 * 60 * 60 * 1000);

  let estimatedTotal = null;
  if (extRes.totalAmount != null) {
    // totalAmount is a Decimal -- could be a Prisma.Decimal, string or
    // number. Coerce; on NaN, fall back to null.
    const n = Number(extRes.totalAmount);
    estimatedTotal = Number.isFinite(n) ? n : null;
  }

  return {
    tenantId: extRes.tenantId,
    reservationNumber: `TL-${extRes.externalRef}`,
    sourceRef: extRes.externalRef,
    status: 'PENDING_FRANCHISE_IMPORT',
    bookingChannel: BOOKING_CHANNEL,
    customerId,
    vehicleTypeId: vehicleTypeId || null,
    pickupAt,
    returnAt,
    pickupLocationId: locationId,
    returnLocationId: locationId,
    estimatedTotal,
    notes: `Imported from TL International (rematch) -- ${extRes.externalRef}`,
    sendConfirmationEmail: false,
  };
}

function tag(extRes) {
  return extRes?.externalRef || extRes?.id || '(unknown)';
}

/**
 * Re-fetch the AcrissCategoryMap entry (tenant-scoped then global)
 * for the customer_not_found path. Mirrors the matcher's lookup so
 * we can promote without re-running evaluatePromotion.
 */
async function lookupAcrissMap(prismaLike, tenantId, acrissCode) {
  const scoped = await prismaLike.acrissCategoryMap.findUnique({
    where: { tenantId_acrissCode: { tenantId, acrissCode } },
  }).catch(() => null);
  if (scoped) return scoped;
  return await prismaLike.acrissCategoryMap.findFirst({
    where: { tenantId: null, acrissCode },
  }).catch(() => null);
}

/**
 * Per-row driver. Pure-ish: takes a prisma-like and an extRes; mutates
 * only when `commit` is true. Returns an outcome string for the tally.
 */
export async function processOne(prismaLike, extRes, { commit, logger }) {
  const log = (...a) => logger.log('[tl-rematch]', ...a);
  const id = tag(extRes);

  // Idempotency guard
  if (extRes.promotionStatus === 'PROMOTED' || extRes.promotionStatus === 'AUTO_PROMOTED') {
    log(`${id}: already promoted -- skip`);
    return { outcome: 'skipped_promoted' };
  }
  if (extRes.promotionStatus === 'REJECTED') {
    log(`${id}: already rejected -- skip`);
    return { outcome: 'skipped_rejected' };
  }

  // Duplicate-detection short-circuit: agent at counter may have created
  // the Reservation manually before the TL sync hit. If a Reservation in
  // the same tenant has matching customer name + pickup day, LINK to it
  // instead of creating a new one.
  let duplicateId = null;
  try {
    duplicateId = await findDuplicateReservation(prismaLike, extRes);
  } catch (err) {
    log(`${id}: duplicate check error -- ${err.message}`);
    duplicateId = null;
  }
  if (duplicateId) {
    log(`${id}: LINKED to existing Reservation ${duplicateId} (duplicate detected by name+date)`);
    if (commit) {
      try {
        await prismaLike.externalReservation.update({
          where: { id: extRes.id },
          data: {
            promotionStatus: 'PROMOTED',
            promotedToReservationId: duplicateId,
            promotedAt: new Date(),
            promotedByUserId: 'system',
            needsReviewReason: null,
          },
        });
      } catch (err) {
        log(`${id}: link update error -- ${err.message}`);
        return { outcome: 'error', error: err };
      }
    }
    return { outcome: 'linked', reservationId: duplicateId };
  }

  let decision;
  try {
    decision = await evaluatePromotion(extRes, { prisma: prismaLike });
  } catch (err) {
    log(`${id}: evaluatePromotion error -- ${err.message}`);
    return { outcome: 'error', error: err };
  }

  // ── Path 1: AUTO ───────────────────────────────────────────────────
  if (decision.decision === 'AUTO') {
    const vehicleTypeId = await resolveVehicleTypeId(
      prismaLike, extRes.tenantId, decision.mappedVehicleCategory,
    );
    const data = buildReservationCreateData(
      extRes,
      decision.mappedCustomer.id,
      decision.mappedLocation.id,
      vehicleTypeId,
    );
    log(`${id}: matched customer ${decision.mappedCustomer.id} -- would promote -> Reservation ${data.reservationNumber}, status ${data.status}`);
    if (!commit) return { outcome: 'promoted', dryRun: true };

    try {
      const result = await prismaLike.$transaction(async (tx) => {
        const fresh = await tx.externalReservation.findUnique({ where: { id: extRes.id } });
        if (!fresh) throw new Error(`ExternalReservation ${extRes.id} disappeared`);
        if (fresh.promotionStatus === 'PROMOTED' || fresh.promotionStatus === 'AUTO_PROMOTED') {
          return { skipped: true };
        }
        const reservation = await tx.reservation.create({ data });
        await tx.externalReservation.update({
          where: { id: fresh.id },
          data: {
            promotionStatus: 'PROMOTED',
            promotedToReservationId: reservation.id,
            promotedAt: new Date(),
            promotedByUserId: 'system',
            needsReviewReason: null,
          },
        });
        return { reservationId: reservation.id };
      });
      if (result.skipped) return { outcome: 'skipped_promoted' };
      return { outcome: 'promoted', reservationId: result.reservationId };
    } catch (err) {
      log(`${id}: promote error -- ${err.message}`);
      return { outcome: 'error', error: err };
    }
  }

  // ── Path 2: MANUAL_REVIEW (customer_not_found + we can create) ────
  if (
    decision.decision === 'MANUAL_REVIEW' &&
    decision.reason === REVIEW_REASONS.CUSTOMER_NOT_FOUND &&
    canAutoCreateCustomer(extRes)
  ) {
    // Re-fetch the ACRISS + Location gates that evaluatePromotion
    // already verified before it ever returned CUSTOMER_NOT_FOUND.
    const acrissCode = String(extRes.vehicleAcriss || '').trim().toUpperCase();
    const acrissMap = await lookupAcrissMap(prismaLike, extRes.tenantId, acrissCode);
    const extCode = extractLocationCode(extRes.pickupLocation) ||
                    extractLocationCode(extRes.dropoffLocation);
    const locMap = extCode ? await prismaLike.locationCodeMap.findUnique({
      where: { tenantId_externalCode: { tenantId: extRes.tenantId, externalCode: extCode } },
      include: { location: true },
    }).catch(() => null) : null;

    if (!acrissMap || !locMap || !locMap.location) {
      log(`${id}: map disappeared mid-run -- leaving in review`);
      return { outcome: 'left_in_review' };
    }

    const customerData = buildCustomerCreateData(extRes);
    log(
      `${id}: matched 0 customers -> would create new ` +
      `(${customerData.firstName} ${customerData.lastName} / ${customerData.email || '(no email)'})`,
    );
    log(`${id}: would promote -> Reservation TL-${extRes.externalRef}, status PENDING_FRANCHISE_IMPORT`);

    if (!commit) {
      return { outcome: 'promoted', customerCreated: true, dryRun: true };
    }

    try {
      const vehicleTypeId = await resolveVehicleTypeId(
        prismaLike, extRes.tenantId, acrissMap.vehicleCategory,
      );

      const result = await prismaLike.$transaction(async (tx) => {
        const fresh = await tx.externalReservation.findUnique({ where: { id: extRes.id } });
        if (!fresh) throw new Error(`ExternalReservation ${extRes.id} disappeared`);
        if (fresh.promotionStatus === 'PROMOTED' || fresh.promotionStatus === 'AUTO_PROMOTED') {
          return { skipped: true };
        }
        const customer = await tx.customer.create({ data: customerData });
        const rData = buildReservationCreateData(
          fresh, customer.id, locMap.location.id, vehicleTypeId,
        );
        const reservation = await tx.reservation.create({ data: rData });
        await tx.externalReservation.update({
          where: { id: fresh.id },
          data: {
            promotionStatus: 'PROMOTED',
            promotedToReservationId: reservation.id,
            promotedAt: new Date(),
            promotedByUserId: 'system',
            needsReviewReason: null,
          },
        });
        return { customerId: customer.id, reservationId: reservation.id };
      });

      if (result.skipped) return { outcome: 'skipped_promoted' };
      return { outcome: 'promoted', customerCreated: true, ...result };
    } catch (err) {
      log(`${id}: auto-create+promote error -- ${err.message}`);
      return { outcome: 'error', error: err };
    }
  }

  // ── Path 3: MANUAL_REVIEW (anything else) ─────────────────────────
  if (decision.decision === 'MANUAL_REVIEW') {
    log(`${id}: still needs review (reason=${decision.reason})`);
    if (commit) {
      try {
        await prismaLike.externalReservation.update({
          where: { id: extRes.id },
          data: {
            promotionStatus: 'MANUAL_REVIEW',
            needsReviewReason: decision.reason || null,
          },
        });
      } catch (err) {
        log(`${id}: failed to update review reason -- ${err.message}`);
        return { outcome: 'error', error: err };
      }
    }
    return { outcome: 'left_in_review', reason: decision.reason };
  }

  log(`${id}: unexpected decision shape -- ${JSON.stringify(decision)}`);
  return { outcome: 'error', error: new Error('unexpected decision') };
}

/**
 * Main driver. Exported so the test harness can call it with a stub.
 */
export async function runRematch(prismaLike, opts = {}) {
  const commit = !!opts.commit;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : null;
  const logger = opts.logger || console;
  const log = (...a) => logger.log('[tl-rematch]', ...a);

  log(`mode: ${commit ? 'COMMIT' : 'DRY RUN'}`);

  const findArgs = {
    where: {
      sourceSystem: SOURCE_SYSTEM,
      promotionStatus: { in: ['PENDING', 'MANUAL_REVIEW'] },
    },
    orderBy: { createdAt: 'asc' },
  };
  if (limit) findArgs.take = limit;

  const candidates = await prismaLike.externalReservation.findMany(findArgs);
  log(`candidates: ${candidates.length}`);

  const summary = {
    scanned: 0,
    promoted: 0,
    linked: 0,
    customersCreated: 0,
    leftInReview: 0,
    skipped: 0,
    errors: 0,
  };

  for (const ext of candidates) {
    summary.scanned += 1;
    const result = await processOne(prismaLike, ext, { commit, logger });
    switch (result.outcome) {
      case 'promoted':
        summary.promoted += 1;
        if (result.customerCreated) summary.customersCreated += 1;
        break;
      case 'linked':
        summary.linked += 1;
        break;
      case 'left_in_review':
        summary.leftInReview += 1;
        break;
      case 'skipped_promoted':
      case 'skipped_rejected':
        summary.skipped += 1;
        break;
      case 'error':
        summary.errors += 1;
        break;
      default:
        break;
    }
    if (summary.scanned % PROGRESS_EVERY === 0) {
      log(
        `progress: ${summary.scanned}/${candidates.length} ` +
        `(promoted=${summary.promoted}, review=${summary.leftInReview}, ` +
        `errors=${summary.errors})`,
      );
    }
  }

  log('summary:');
  log(`  scanned:           ${summary.scanned}`);
  log(`  promoted:          ${summary.promoted}`);
  log(`  linked:            ${summary.linked}`);
  log(`  customers created: ${summary.customersCreated}`);
  log(`  left in review:    ${summary.leftInReview}`);
  log(`  skipped:           ${summary.skipped}`);
  log(`  errors:            ${summary.errors}`);

  return summary;
}

// ── CLI entrypoint ─────────────────────────────────────────────────
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  const argv = process.argv.slice(2);
  const commit = argv.includes('--commit');
  let limit = null;
  const limitIdx = argv.indexOf('--limit');
  if (limitIdx >= 0 && argv[limitIdx + 1]) {
    const n = parseInt(argv[limitIdx + 1], 10);
    if (Number.isFinite(n) && n > 0) limit = n;
  }

  const { prisma } = await import('../src/lib/prisma.js');
  try {
    await runRematch(prisma, { commit, limit });
  } catch (err) {
    console.error('[tl-rematch] fatal:', err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
  await prisma.$disconnect();
  if (!commit) {
    console.log('');
    console.log('Dry run complete. Re-run with --commit to actually write.');
  }
}
