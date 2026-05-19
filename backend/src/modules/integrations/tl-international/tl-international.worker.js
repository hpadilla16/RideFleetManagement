/**
 * TL International sync worker — single BullMQ job that pulls fresh
 * pickups, stages them, and (when possible) auto-promotes them.
 *
 * Architecture:
 *   - One queue: `tl-international.sync`
 *   - Job payload: { tenantId, triggeredBy }
 *   - Concurrency: 1 (never two TL syncs in flight at once — protects TL's
 *     server and gives us a clean single-writer view of the staging table)
 *   - Priority: SCRAPER_PRIORITY (LOW=10) — bulk + retryable, must not
 *     starve autocharge or transactional emails
 *
 * Per-run lifecycle:
 *   1. Create an ExternalSyncRun row in OK status (will be overwritten at end)
 *   2. fetchDashboardPickups(tenantId)
 *   3. Pre-query externalRef → known set so we can count new vs updated cleanly
 *   4. For each pickup:
 *      a. fetchReservationDetail (sleep DETAIL_DELAY_MS between calls)
 *      b. upsert ExternalReservation
 *      c. evaluatePromotion → if AUTO, create Reservation + link back
 *      d. else mark MANUAL_REVIEW with reason
 *   5. Update the ExternalSyncRun with final status + counts
 *
 * Failure modes:
 *   - TLAuthExpiredError thrown anywhere → abort the run, mark AUTH_EXPIRED,
 *     update IntegrationCredential.lastTestStatus = 'EXPIRED', Sentry warn
 *   - Detail error on one ZE# → increment errorsCount, keep going
 *   - Fatal: any other error → FAILED, full Sentry capture
 *
 * See doc/tl-integration-design-2026-05-19.md.
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { captureBackendException } from '../../../lib/sentry.js';
import { registerWorker, enqueueJob } from '../../../lib/queue/index.js';
import { SCRAPER_PRIORITY } from '../../../lib/queue/priorities.js';
import {
  fetchDashboardPickups,
  fetchReservationDetail,
  mapDetailToRow,
  sleep,
  DETAIL_DELAY_MS,
  TLAuthExpiredError,
  SOURCE_SYSTEM,
} from './tl-international.service.js';
import { evaluatePromotion } from './promotion-matcher.service.js';

export const QUEUE_NAME = 'tl-international.sync';

const BOOKING_CHANNEL = 'FRANCHISE_TL';

/**
 * The job handler. Exported for direct invocation from the bootstrap CLI
 * and integration tests.
 */
export async function tlSyncHandler(job) {
  const { tenantId, triggeredBy = 'schedule' } = job?.data || {};
  if (!tenantId) {
    throw new Error('tl-international.sync: job.data.tenantId is required');
  }

  const startedAt = new Date();
  const runRow = await prisma.externalSyncRun.create({
    data: {
      tenantId,
      sourceSystem: SOURCE_SYSTEM,
      status: 'OK',
      notes: `Triggered by: ${triggeredBy}`,
    },
  });

  let pickupsFound = 0;
  let newlyInserted = 0;
  let updatedExisting = 0;
  let autoPromoted = 0;
  let needsReview = 0;
  let errorsCount = 0;
  let finalStatus = 'OK';
  const errorSamples = [];

  try {
    const pickups = await fetchDashboardPickups(tenantId);
    pickupsFound = pickups.length;
    logger.info('[tl-sync] dashboard fetched', {
      tenantId, runId: runRow.id, pickupsFound,
    });

    // Pre-fetch known external refs so we count new vs updated cleanly.
    const known = await prisma.externalReservation.findMany({
      where: {
        tenantId,
        sourceSystem: SOURCE_SYSTEM,
        externalRef: { in: pickups.map((p) => p.externalRef) },
      },
      select: { externalRef: true },
    });
    const knownSet = new Set(known.map((k) => k.externalRef));

    for (const pickup of pickups) {
      try {
        const wasKnown = knownSet.has(pickup.externalRef);
        const detail = await fetchReservationDetail(tenantId, pickup.externalRef);
        if (!detail) {
          errorsCount++;
          errorSamples.push(`${pickup.externalRef}: detail returned non-success`);
          continue;
        }
        const mapped = mapDetailToRow(detail, pickup.externalRef);

        const upserted = await prisma.externalReservation.upsert({
          where: {
            source_ref_unique: {
              sourceSystem: SOURCE_SYSTEM,
              externalRef: pickup.externalRef,
            },
          },
          create: {
            ...mapped,
            tenantId,
            sourceSystem: SOURCE_SYSTEM,
            subBrand: mapped.subBrand || (detail.subBrand ?? detail.sub_brand ?? null),
          },
          update: {
            ...mapped,
            lastSyncedAt: new Date(),
            syncRunCount: { increment: 1 },
          },
        });

        if (wasKnown) updatedExisting++;
        else newlyInserted++;

        // Skip promotion attempt if we already promoted this row in a
        // prior run (idempotent — protects against duplicate Reservation
        // creation when the same ZE# is upserted twice).
        if (upserted.promotionStatus === 'AUTO_PROMOTED' || upserted.promotionStatus === 'PROMOTED') {
          continue;
        }

        const decision = await evaluatePromotion(upserted, { prisma });
        if (decision.decision === 'AUTO') {
          try {
            await promoteAutomatically(upserted, decision);
            autoPromoted++;
          } catch (promoErr) {
            errorsCount++;
            errorSamples.push(`${pickup.externalRef}: promote failed: ${promoErr.message}`);
            captureBackendException(promoErr, {
              integration: { source: SOURCE_SYSTEM, tenantId, externalRef: pickup.externalRef },
            });
          }
        } else {
          needsReview++;
          await prisma.externalReservation.update({
            where: { id: upserted.id },
            data: {
              promotionStatus: 'MANUAL_REVIEW',
              needsReviewReason: decision.reason || null,
            },
          });
        }

        await sleep(DETAIL_DELAY_MS);
      } catch (err) {
        if (err instanceof TLAuthExpiredError) throw err;
        errorsCount++;
        errorSamples.push(`${pickup.externalRef}: ${err.message}`);
        captureBackendException(err, {
          integration: { source: SOURCE_SYSTEM, tenantId, externalRef: pickup.externalRef },
        });
      }
    }

    if (errorsCount > 0 && (newlyInserted + updatedExisting) > 0) finalStatus = 'PARTIAL';
    if (errorsCount > 0 && (newlyInserted + updatedExisting) === 0) finalStatus = 'FAILED';
  } catch (err) {
    if (err instanceof TLAuthExpiredError) {
      finalStatus = 'AUTH_EXPIRED';
      logger.warn('[tl-sync] cookie expired', {
        tenantId, runId: runRow.id, message: err.message,
      });
      // Mark credential expired so the UI banner can light up.
      await prisma.integrationCredential.updateMany({
        where: { tenantId, sourceSystem: SOURCE_SYSTEM },
        data: { lastTestStatus: 'EXPIRED', lastTestedAt: new Date() },
      }).catch(() => {});
      captureBackendException(err, {
        integration: { source: SOURCE_SYSTEM, tenantId },
        level: 'warning',
      });
    } else {
      finalStatus = 'FAILED';
      logger.error('[tl-sync] fatal error', {
        tenantId, runId: runRow.id, message: err.message, stack: err.stack,
      });
      captureBackendException(err, {
        integration: { source: SOURCE_SYSTEM, tenantId },
      });
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
  };
}

/**
 * Build a fresh Reservation row out of an ExternalReservation + decision.
 * The auto-promote path always:
 *   - status = PENDING_FRANCHISE_IMPORT
 *   - bookingChannel = FRANCHISE_TL
 *   - sourceRef = externalRef  (unique key — protects against double-promote)
 *   - reservationNumber = `TL-<externalRef>`  (also unique — TL ZE#s are globally unique)
 *
 * The agent finalizes (CONFIRMED / vehicle assignment) at checkout.
 *
 * Exported so the routes (manual promote) can call the same code path.
 */
export async function promoteAutomatically(extRes, decision) {
  if (decision?.decision !== 'AUTO') {
    throw new Error('promoteAutomatically requires decision.decision === "AUTO"');
  }
  return promoteWithMappings(extRes, {
    customerId: decision.mappedCustomer.id,
    locationId: decision.mappedLocation.id,
    vehicleCategory: decision.mappedVehicleCategory,
    promotedByUserId: null,
    isAuto: true,
  });
}

/**
 * Lower-level promote path (used by AUTO and by manual promote in routes).
 */
export async function promoteWithMappings(extRes, opts) {
  const {
    customerId,
    locationId,
    vehicleCategory = null,
    vehicleTypeId = null,
    promotedByUserId = null,
    isAuto = false,
  } = opts || {};

  if (!customerId) throw new Error('promote: customerId is required');
  if (!locationId) throw new Error('promote: locationId is required');

  // Re-read latest external row inside the transaction so we don't double-promote.
  return await prisma.$transaction(async (tx) => {
    const fresh = await tx.externalReservation.findUnique({ where: { id: extRes.id } });
    if (!fresh) throw new Error(`ExternalReservation ${extRes.id} not found`);
    if (fresh.promotionStatus === 'AUTO_PROMOTED' || fresh.promotionStatus === 'PROMOTED') {
      // Already promoted — return the existing reservation
      if (fresh.promotedToReservationId) {
        const existing = await tx.reservation.findUnique({ where: { id: fresh.promotedToReservationId } });
        if (existing) return { reservation: existing, alreadyPromoted: true };
      }
    }

    // Resolve vehicleTypeId if not passed and we have a category string
    let resolvedVehicleTypeId = vehicleTypeId;
    if (!resolvedVehicleTypeId && vehicleCategory) {
      const vt = await tx.vehicleType.findFirst({
        where: {
          tenantId: fresh.tenantId,
          OR: [
            { classCode: { equals: vehicleCategory, mode: 'insensitive' } },
            { category: { equals: vehicleCategory, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      }).catch(() => null);
      resolvedVehicleTypeId = vt?.id || null;
    }

    const pickupAt = fresh.pickupAt || new Date();
    const returnAt = fresh.dropoffAt || new Date(pickupAt.getTime() + 3 * 24 * 60 * 60 * 1000);

    const reservation = await tx.reservation.create({
      data: {
        tenantId: fresh.tenantId,
        reservationNumber: `TL-${fresh.externalRef}`,
        sourceRef: fresh.externalRef,
        status: 'PENDING_FRANCHISE_IMPORT',
        bookingChannel: BOOKING_CHANNEL,
        customerId,
        vehicleTypeId: resolvedVehicleTypeId,
        pickupAt,
        returnAt,
        pickupLocationId: locationId,
        returnLocationId: locationId,
        estimatedTotal: fresh.totalAmount ?? null,
        notes: `Imported from TL International — ${fresh.externalRef}`,
        sendConfirmationEmail: false,
      },
    });

    const updated = await tx.externalReservation.update({
      where: { id: fresh.id },
      data: {
        promotionStatus: isAuto ? 'AUTO_PROMOTED' : 'PROMOTED',
        promotedToReservationId: reservation.id,
        promotedAt: new Date(),
        promotedByUserId,
        needsReviewReason: null,
      },
    });

    return { reservation, externalReservation: updated, alreadyPromoted: false };
  });
}

/**
 * Convenience: enqueue a one-off sync job at NORMAL priority so the
 * manual run doesn't sit behind the next 15-min tick.
 */
export async function enqueueOneOffSync(tenantId, triggeredBy = 'manual') {
  return enqueueJob(QUEUE_NAME, { tenantId, triggeredBy }, {
    jobId: `tl-sync:${tenantId}:${Date.now()}`,
    priority: 5,  // NORMAL — bump it above scheduled
  });
}

/**
 * Register the worker with the BullMQ infra. Idempotent — call once at
 * worker process boot.
 */
export function registerTlSyncWorker() {
  registerWorker(QUEUE_NAME, tlSyncHandler, {
    concurrency: 1,
    priority: SCRAPER_PRIORITY,
  });
  logger.info('[tl-sync] worker registered', { queue: QUEUE_NAME });
}
