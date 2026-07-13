/**
 * Flexways (MobilityPS) sync worker — one BullMQ job per tenant that pulls the
 * near-term reservation grid for EACH enabled sede, stages the rows into
 * ExternalReservation, and (when possible) auto-promotes them.
 *
 * Thin over the shared booking-source pieces:
 *   - createPromoter(flexwaysSourceSpec)       → promote / link (MONEY: estimatedTotal only)
 *   - maybeCreateCustomerFromSource            → opt-in auto-create (flag-gated)
 *   - evaluatePromotion + findDuplicateReservation (booking-source services)
 *
 * MULTI-SEDE (unlike NU's 1:1): a tenant maps N portal sedes → N Ride locations
 * via FlexwaysLocationConfig(idSede → locationId). Each enabled sede is fetched
 * on its own date window and its rows are pinned to that sede's locationId via
 * overrideLocationId (the matcher's LocationCodeMap gate is skipped for Flexways,
 * exactly like NU/Economy).
 *
 * MONEY: writes ONLY estimatedTotal on the Reservation. No charge, no card, no
 * autocharge — same posture as TL/Economy/NU.
 *
 * NOTE (recon gap): the grid carries no ACRISS/class, total, or customer
 * email/phone — those live in the per-reservation DETAIL page, which the recon did
 * NOT capture. Until the detail fetch lands, mapped rows have vehicleAcriss/total/
 * email = null, so promotion typically routes to MANUAL_REVIEW (acriss_unmapped).
 * That is the SAFE default for a dark ship — nothing is money-charged and the tray
 * lets staff finish the import by hand.
 *
 * See doc/flexways-integration-plan-2026-07-13.md
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { captureBackendException } from '../../../lib/sentry.js';
import { registerWorker, enqueueJob } from '../../../lib/queue/index.js';
import { SCRAPER_PRIORITY } from '../../../lib/queue/priorities.js';
import {
  fetchReservationList,
  pickUserAgent,
  FlexwaysAuthExpiredError,
} from './flexways.service.js';
import {
  SOURCE_SYSTEM,
  BOOKING_CHANNEL,
  QUEUE_NAME,
  RESERVATION_PREFIX,
  TIME_ZONE,
  windowBoundsForConfig,
} from './flexways.constants.js';
import { createPromoter } from '../booking-source/promote.js';
import {
  maybeCreateCustomerFromSource,
  autoCreateEnabledFromEnv,
} from '../booking-source/customer-autocreate.js';
import { evaluatePromotion, REVIEW_REASONS } from '../booking-source/promotion-matcher.service.js';

export { QUEUE_NAME };

// ---------------------------------------------------------------------------
// The sourceSpec for the shared promoter. Flexways carries no structured prepaid
// flag today (that would come from the detail page) → the default notes-only
// extras are correct.
// ---------------------------------------------------------------------------
const flexwaysSourceSpec = Object.freeze({
  reservationPrefix: RESERVATION_PREFIX,
  bookingChannel: BOOKING_CHANNEL,
  sourceLabel: 'Flexways',
  logPrefix: '[flexways-sync]',
  defaultTimeZone: TIME_ZONE,
});

const { promoteAutomatically, promoteWithMappings } = createPromoter(flexwaysSourceSpec);
export { promoteAutomatically, promoteWithMappings };

function autoCreateCustomersEnabled() {
  return autoCreateEnabledFromEnv('FLEXWAYS_AUTO_CREATE_CUSTOMERS');
}

// ---------------------------------------------------------------------------
// Field mapper — normalized grid row → ExternalReservation shape. Pure. Exported.
// The row is already normalized by parseReservationGrid (dates are UTC Dates).
// vehicleAcriss / totalAmount / customerEmail stay null until the detail fetch
// lands (recon gap — see file header).
// ---------------------------------------------------------------------------
export function mapRowToExternalReservation(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    externalRef: String(r.externalRef || '').trim(),
    channel: r.channel || null,
    supplierRef: r.bookingCode || null,
    status: 'CONFIRMED',                  // grid rows are confirmed reservations
    customerFirstName: r.customerFirstName || null,
    customerLastName: r.customerLastName || null,
    customerEmail: null,                  // grid carries no email (detail page)
    customerPhone: null,                  // grid carries no phone (detail page)
    customerCountry: null,
    flightNumber: null,
    vehicleAcriss: null,                  // grid carries no class (detail page)
    vehicleDescription: null,
    pickupAt: r.pickupAt instanceof Date ? r.pickupAt : null,
    pickupLocation: r.pickupLocation || null,
    dropoffAt: null,                      // grid has no dropoff datetime (only location)
    dropoffLocation: r.dropoffLocation || null,
    totalAmount: null,                    // grid carries no total (detail page)
    currency: 'USD',
    rawJson: { list: r },
  };
}

/**
 * The job handler. Exported for direct invocation from tests + a bootstrap CLI.
 * Job payload: { tenantId, triggeredBy }.
 */
export async function flexwaysSyncHandler(job) {
  const { tenantId, triggeredBy = 'schedule' } = job?.data || {};
  if (!tenantId) throw new Error('flexways.sync: job.data.tenantId is required');

  const userAgent = pickUserAgent();
  logger.info('[flexways-sync] starting run', { tenantId, triggeredBy });

  // Enabled sedes for this tenant. MULTI-SEDE: iterate each row and fetch its own
  // grid + window. orderBy createdAt asc keeps the sweep deterministic.
  const configs = await prisma.flexwaysLocationConfig.findMany({
    where: { tenantId, enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { idSede: true, locationId: true, lookbackDays: true, lookaheadDays: true },
  });

  const startedAt = new Date();
  const runRow = await prisma.externalSyncRun.create({
    data: { tenantId, sourceSystem: SOURCE_SYSTEM, status: 'OK', notes: `Triggered by: ${triggeredBy}` },
  });

  let pickupsFound = 0;
  let newlyInserted = 0;
  let updatedExisting = 0;
  let autoPromoted = 0;
  let needsReview = 0;
  let errorsCount = 0;
  let skippedCrossTenant = 0;
  let finalStatus = 'OK';
  const errorSamples = [];

  try {
    if (configs.length === 0) {
      logger.info('[flexways-sync] no enabled FlexwaysLocationConfig for tenant — nothing to sync', { tenantId });
    }

    const now = Date.now();

    for (const config of configs) {
      const targetLocationId = config.locationId;
      if (!targetLocationId) continue;
      const { dateFrom, dateTo } = windowBoundsForConfig(config, now);

      let rows = [];
      try {
        rows = await fetchReservationList(tenantId, {
          idSede: config.idSede, from: dateFrom, to: dateTo, userAgent,
        });
      } catch (err) {
        if (err instanceof FlexwaysAuthExpiredError) throw err; // fail the whole run
        errorsCount++;
        errorSamples.push(`sede ${config.idSede}: list fetch failed: ${err.message}`);
        captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId, idSede: config.idSede } });
        continue;
      }

      pickupsFound += rows.length;
      logger.info('[flexways-sync] sede list fetched', {
        tenantId, runId: runRow.id, idSede: config.idSede, fetched: rows.length, targetLocationId,
      });

      // Pre-fetch existing rows for these refs to count new vs updated AND detect
      // cross-tenant collisions (unique is (sourceSystem, externalRef), no tenantId).
      const refs = rows.map((r) => String(r?.externalRef || '').trim()).filter(Boolean);
      const existingRows = refs.length
        ? await prisma.externalReservation.findMany({
          where: { sourceSystem: SOURCE_SYSTEM, externalRef: { in: refs } },
          select: { externalRef: true, tenantId: true },
        })
        : [];
      const existingByRef = new Map(existingRows.map((r) => [r.externalRef, r.tenantId]));
      const knownSet = new Set(
        existingRows.filter((r) => r.tenantId === tenantId).map((r) => r.externalRef)
      );

      for (const row of rows) {
        const externalRef = String(row?.externalRef || '').trim();
        if (!externalRef) { errorsCount++; errorSamples.push('row missing ref'); continue; }
        try {
          const ownerTenantId = existingByRef.get(externalRef);
          if (ownerTenantId && ownerTenantId !== tenantId) {
            skippedCrossTenant++;
            logger.warn('[flexways-sync] cross-tenant ExternalReservation collision — row skipped', {
              tenantId, externalRef, ownerTenantId, runId: runRow.id,
            });
            continue;
          }

          const wasKnown = knownSet.has(externalRef);
          const mapped = mapRowToExternalReservation(row);

          const upserted = await prisma.externalReservation.upsert({
            where: { source_ref_unique: { sourceSystem: SOURCE_SYSTEM, externalRef } },
            create: { ...mapped, tenantId, sourceSystem: SOURCE_SYSTEM },
            update: { ...mapped, lastSyncedAt: new Date(), syncRunCount: { increment: 1 } },
          });

          if (wasKnown) updatedExisting++; else newlyInserted++;

          if (upserted.promotionStatus === 'AUTO_PROMOTED' || upserted.promotionStatus === 'PROMOTED') {
            continue; // idempotent — already promoted
          }

          // The sede's mapped locationId is authoritative → overrideLocationId
          // skips the LocationCodeMap gate (location_unmapped can never block);
          // any OTHER gate still routes to MANUAL_REVIEW.
          const promoOpts = { prisma, overrideLocationId: targetLocationId };
          let decision = await evaluatePromotion(upserted, promoOpts);

          if (decision.decision === 'MANUAL_REVIEW'
            && decision.reason === REVIEW_REASONS.CUSTOMER_NOT_FOUND
            && autoCreateCustomersEnabled()) {
            try {
              const newCust = await maybeCreateCustomerFromSource(prisma, upserted, {
                logPrefix: '[flexways-sync]', sourceName: 'Flexways',
              });
              if (newCust) decision = await evaluatePromotion(upserted, promoOpts);
            } catch (createErr) {
              logger.warn('[flexways-sync] auto-create customer failed; MANUAL_REVIEW', {
                tenantId, externalRef, message: createErr.message,
              });
            }
          }

          if (decision.decision === 'AUTO') {
            try {
              await promoteAutomatically(upserted, decision, {
                locationId: targetLocationId, timeZone: TIME_ZONE,
              });
              autoPromoted++;
            } catch (promoErr) {
              errorsCount++;
              errorSamples.push(`${externalRef}: promote failed: ${promoErr.message}`);
              captureBackendException(promoErr, { integration: { source: SOURCE_SYSTEM, tenantId, externalRef } });
            }
          } else {
            needsReview++;
            await prisma.externalReservation.update({
              where: { id: upserted.id },
              data: { promotionStatus: 'MANUAL_REVIEW', needsReviewReason: decision.reason || null },
            });
          }
        } catch (err) {
          if (err instanceof FlexwaysAuthExpiredError) throw err;
          errorsCount++;
          errorSamples.push(`${externalRef}: ${err.message}`);
          captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId, externalRef } });
        }
      }
    }

    if (errorsCount > 0 && (newlyInserted + updatedExisting) > 0) finalStatus = 'PARTIAL';
    if (errorsCount > 0 && (newlyInserted + updatedExisting) === 0) finalStatus = 'FAILED';
  } catch (err) {
    if (err instanceof FlexwaysAuthExpiredError) {
      finalStatus = 'AUTH_EXPIRED';
      logger.warn('[flexways-sync] session expired', { tenantId, runId: runRow.id, message: err.message });
      await prisma.integrationCredential.updateMany({
        where: { tenantId, sourceSystem: SOURCE_SYSTEM },
        data: { lastTestStatus: 'EXPIRED', lastTestedAt: new Date() },
      }).catch(() => {});
      captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId }, level: 'warning' });
    } else {
      finalStatus = 'FAILED';
      logger.error('[flexways-sync] fatal error', { tenantId, runId: runRow.id, message: err.message, stack: err.stack });
      captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId } });
    }
  }

  const finishedAt = new Date();
  await prisma.externalSyncRun.update({
    where: { id: runRow.id },
    data: {
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status: finalStatus,
      pickupsFound,
      newlyInserted,
      updatedExisting,
      autoPromoted,
      needsReview,
      errorsCount,
      notes: errorSamples.length ? errorSamples.slice(0, 5).join(' | ') : null,
    },
  });

  return {
    runId: runRow.id,
    status: finalStatus,
    pickupsFound,
    newlyInserted,
    updatedExisting,
    autoPromoted,
    needsReview,
    errorsCount,
    skippedCrossTenant,
  };
}

/** Convenience: enqueue a one-off sync (manual "Run now"). */
export async function enqueueOneOffSync(tenantId, triggeredBy = 'manual') {
  return enqueueJob(QUEUE_NAME, { tenantId, triggeredBy }, {
    jobId: `flexways-sync:${tenantId}:${Date.now()}`,
    priority: 5,
  });
}

/** Register the worker with BullMQ. Idempotent — call once at worker boot. */
export function registerFlexwaysSyncWorker() {
  registerWorker(QUEUE_NAME, flexwaysSyncHandler, {
    concurrency: 1,
    priority: SCRAPER_PRIORITY,
  });
  logger.info('[flexways-sync] worker registered', { queue: QUEUE_NAME });
}
