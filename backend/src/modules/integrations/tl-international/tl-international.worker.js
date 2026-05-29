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
  DETAIL_DELAY_MIN_MS,
  DETAIL_DELAY_MAX_MS,
  pickUserAgent,
  randomDelay,
  TLAuthExpiredError,
  SOURCE_SYSTEM,
} from './tl-international.service.js';
import { evaluatePromotion } from './promotion-matcher.service.js';
import { findDuplicateReservation } from './duplicate-detector.service.js';

export const QUEUE_NAME = 'tl-international.sync';

const BOOKING_CHANNEL = 'FRANCHISE_TL';

// ---------------------------------------------------------------------------
// Auto-create customer (2026-05-25)
//
// By default, when promotion-matcher returns CUSTOMER_NOT_FOUND, the row goes
// to MANUAL_REVIEW. With TL_AUTO_CREATE_CUSTOMERS=true the worker will create
// a lightweight Customer from the TL data (firstName + lastName + email/phone)
// and then re-evaluate the promotion — usually flipping it to AUTO so the
// reservation lands in the Reservations module without manual intervention.
//
// Constraints to actually create:
//   - firstName + lastName both non-empty
//   - At least one of email OR phone non-empty
// If both are missing or names are blank → still MANUAL_REVIEW.
//
// Driver's license, DOB, etc. are NOT captured here — they're filled at
// counter check-in. The Customer record stays minimal until then.
// ---------------------------------------------------------------------------
function autoCreateCustomersEnabled() {
  const raw = (process.env.TL_AUTO_CREATE_CUSTOMERS ?? 'false')
    .toString().trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

const CUSTOMER_PHONE_PLACEHOLDER = '0000000000';

export async function maybeCreateCustomerFromTl(prisma, extRes) {
  const firstName = (extRes.customerFirstName || '').trim();
  const lastName  = (extRes.customerLastName  || '').trim();
  const email     = (extRes.customerEmail     || '').trim().toLowerCase();
  const phone     = (extRes.customerPhone     || '').trim();

  if (!firstName || !lastName) return null;
  if (!email && !phone) return null;

  // Defensive double-check inside the create: another concurrent sync (or
  // a manual creation) could have created the customer between
  // evaluatePromotion's matchCustomer and this create.
  if (email) {
    const existing = await prisma.customer.findFirst({
      where: { tenantId: extRes.tenantId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    }).catch(() => null);
    if (existing) return existing;
  }

  const created = await prisma.customer.create({
    data: {
      tenantId: extRes.tenantId,
      firstName,
      lastName,
      email: email || null,
      phone: phone || CUSTOMER_PHONE_PLACEHOLDER,
      country: extRes.customerCountry || null,
    },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  });

  logger.info('[tl-sync] auto-created Customer from TL data', {
    tenantId: extRes.tenantId,
    externalRef: extRes.externalRef,
    customerId: created.id,
    firstName: created.firstName,
    lastName: created.lastName,
    hasEmail: !!created.email,
    phoneWasPlaceholder: created.phone === CUSTOMER_PHONE_PLACEHOLDER,
  });

  return created;
}

// ---------------------------------------------------------------------------
// Stealth helpers
// ---------------------------------------------------------------------------
//
// Three cron-side mitigations live here. The per-detail-fetch randomized
// sleep + UA rotation are pulled from the service module.
//
// 1) JITTER: BullMQ fires us on a fixed schedule (every 15 min by
//    default). To break the obvious periodicity, we sleep 0-180s
//    inside the job handler BEFORE doing any work — so requests fire
//    at :00+0-3min, :15+0-3min, etc.
//
// 2) QUIET HOURS: human dispatchers don't sit at the back-office at
//    3am. We skip cron-triggered jobs between 02:00 and 06:00 AST
//    (Puerto Rico, UTC-4 year-round, no DST). Manual "Run now" from
//    the UI is always allowed (triggeredBy === 'manual').
//
// 3) UA rotation: pickUserAgent() in the service module — called ONCE
//    per run + threaded through every fetch.

export const JITTER_MAX_MS = Number(process.env.TL_INTERNATIONAL_JITTER_MAX_MS ?? 180_000);

/**
 * Returns true if `now` falls inside the 2am-6am AST quiet window.
 * Atlantic Standard Time is UTC-4 year-round (Puerto Rico does NOT
 * observe DST). Exported for tests.
 */
export function isWithinQuietHours(now = new Date()) {
  const prHour = (now.getUTCHours() - 4 + 24) % 24;
  return prHour >= 2 && prHour < 6;
}

/**
 * Whether the quiet-hours check is enabled. Default true; ops can flip
 * to "false" via env if TL ever needs round-the-clock syncing.
 */
function quietHoursEnabled() {
  const raw = (process.env.TL_INTERNATIONAL_QUIET_HOURS_ENABLED ?? 'true')
    .toString()
    .trim()
    .toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/**
 * The job handler. Exported for direct invocation from the bootstrap CLI
 * and integration tests.
 *
 * Stealth behavior:
 *   - Cron-triggered runs (triggeredBy !== 'manual') honor quiet hours
 *     AND get 0-180s jitter prepended.
 *   - Manual runs (triggeredBy === 'manual') run immediately at any hour.
 */
export async function tlSyncHandler(job) {
  const { tenantId, triggeredBy = 'schedule' } = job?.data || {};
  if (!tenantId) {
    throw new Error('tl-international.sync: job.data.tenantId is required');
  }

  const isManual = triggeredBy === 'manual';

  // (a) Quiet hours — only for cron-triggered runs.
  if (!isManual && quietHoursEnabled() && isWithinQuietHours()) {
    logger.info('[tl-sync] within quiet hours (2am-6am AST) — skipping', {
      tenantId, triggeredBy,
    });
    return { skipped: true, reason: 'quiet_hours' };
  }

  // (b) Jitter — only for cron-triggered runs. Manual runs bypass.
  if (!isManual && JITTER_MAX_MS > 0) {
    const delayMs = randomDelay(0, JITTER_MAX_MS);
    logger.info(`[tl-sync] jitter delay applied: ${delayMs}ms`, {
      tenantId, triggeredBy, delayMs,
    });
    await sleep(delayMs);
  }

  // (c) Pick a UA once per run and thread it through every request so
  // the entire run looks like one browser session.
  const userAgent = pickUserAgent();
  logger.info('[tl-sync] starting run', {
    tenantId, triggeredBy, userAgent: userAgent.slice(0, 60),
  });

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
    const pickups = await fetchDashboardPickups(tenantId, { userAgent });
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
        const detail = await fetchReservationDetail(tenantId, pickup.externalRef, { userAgent });
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

        let decision = await evaluatePromotion(upserted, { prisma });

        // (2026-05-25) Auto-create customer path. When the only thing
        // blocking promotion is customer_not_found AND TL_AUTO_CREATE_CUSTOMERS
        // is enabled, create a lightweight Customer from the TL data and
        // re-evaluate. Usually flips the decision to AUTO.
        if (decision.decision === 'MANUAL_REVIEW'
            && decision.reason === 'customer_not_found'
            && autoCreateCustomersEnabled()) {
          try {
            const newCust = await maybeCreateCustomerFromTl(prisma, upserted);
            if (newCust) {
              decision = await evaluatePromotion(upserted, { prisma });
              logger.info('[tl-sync] re-evaluated after auto-create', {
                tenantId, externalRef: pickup.externalRef,
                newDecision: decision.decision, newReason: decision.reason,
              });
            }
          } catch (createErr) {
            // If auto-create fails (unique constraint race, missing data, etc.)
            // just fall through to MANUAL_REVIEW with the original reason.
            logger.warn('[tl-sync] auto-create customer failed; falling back to MANUAL_REVIEW', {
              tenantId, externalRef: pickup.externalRef, message: createErr.message,
            });
          }
        }

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

        await sleep(randomDelay(DETAIL_DELAY_MIN_MS, DETAIL_DELAY_MAX_MS));
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

    // Resolve vehicleTypeId if not passed and we have a category string.
    //
    // 2026-05-29 — fix: the previous query referenced `classCode` and
    // `category` columns which do NOT exist on prod VehicleType (only
    // `code`, `name`, `description`, `imageUrl`). The `.catch(() => null)`
    // swallowed the Prisma validation error so every TL-promoted
    // reservation landed with vehicleTypeId=null.
    //
    // AcrissCategoryMap.vehicleCategory already holds the target
    // VehicleType.code (verified in prod: ICAR→SCAR maps to the
    // "Standard" VehicleType with code="SCAR"; RFAR→FFAR maps to
    // "Full Size SUV" code="FFAR"; CFAR→CFAR; MVAR→MVAR). So we
    // match on `code` directly.
    let resolvedVehicleTypeId = vehicleTypeId;
    if (!resolvedVehicleTypeId && vehicleCategory) {
      const vt = await tx.vehicleType.findFirst({
        where: {
          tenantId: fresh.tenantId,
          code: { equals: vehicleCategory, mode: 'insensitive' },
        },
        select: { id: true },
      }).catch(() => null);
      resolvedVehicleTypeId = vt?.id || null;
    }

    const pickupAt = fresh.pickupAt || new Date();
    const returnAt = fresh.dropoffAt || new Date(pickupAt.getTime() + 3 * 24 * 60 * 60 * 1000);

    // Duplicate-detection short-circuit: counter agent may have created
    // the Reservation manually before this sync hit. If a Reservation in
    // the same tenant has matching customer name + pickup day, LINK to it
    // instead of creating a new one. See duplicate-detector.service.js.
    const duplicateId = await findDuplicateReservation(tx, fresh).catch(() => null);
    if (duplicateId) {
      const linkedReservation = await tx.reservation.findUnique({
        where: { id: duplicateId },
      });
      const linkedUpdate = await tx.externalReservation.update({
        where: { id: fresh.id },
        data: {
          promotionStatus: 'PROMOTED',
          promotedToReservationId: duplicateId,
          promotedAt: new Date(),
          promotedByUserId: promotedByUserId || 'system',
          needsReviewReason: null,
        },
      });
      logger.info(
        `[tl-sync] ${fresh.externalRef}: LINKED to existing Reservation ${duplicateId} (duplicate detected by name+date)`,
        { tenantId: fresh.tenantId, externalRef: fresh.externalRef, reservationId: duplicateId },
      );
      return {
        reservation: linkedReservation,
        externalReservation: linkedUpdate,
        alreadyPromoted: false,
        linked: true,
      };
    }

    const reservation = await tx.reservation.create({
      data: {
        tenantId: fresh.tenantId,
        reservationNumber: `TL-${fresh.externalRef}`,
        sourceRef: fresh.externalRef,
        // 2026-05-25 — promoted TL bookings are CONFIRMED reservations.
        // The 'Franchise import' badge in the UI (driven by bookingChannel)
        // is what distinguishes them visually. PENDING_FRANCHISE_IMPORT was
        // confusing — it implied something was waiting on our end when in
        // fact the franchise booking is fully paid and confirmed at TL.
        status: 'CONFIRMED',
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
