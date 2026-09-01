/**
 * NU Car Rentals (affiliates portal) sync worker — one BullMQ job that pulls the
 * near-term reservation list, stages the rows into ExternalReservation, and
 * (when possible) auto-promotes them.
 *
 * Clones the Economy worker's run lifecycle, but NU is 1:1 FLL:
 *   - NO area filter. The target Ride locationId is resolved from the tenant's
 *     single enabled NuLocationConfig row (multi-center is future work — if more
 *     than one enabled config exists we map by externalCenter, else take the
 *     single row).
 *   - PREPAID flag. Each row carries isPrepaid (PP/OP Code → true, blank →
 *     false), stored on ExternalReservation. It NEVER changes the money posture.
 *   - Single date window (1:1) rather than Economy's per-area union.
 *
 * Reuses promotion-matcher (evaluatePromotion + overrideLocationId) +
 * duplicate-detector (findDuplicateReservation), unchanged.
 *
 * MONEY: writes ONLY estimatedTotal on the Reservation. No charge, no card, no
 * autocharge — same posture as Economy/TL, even for pay-at-destination rows
 * (the counter collects those manually at handoff).
 *
 * See doc/nu-integration-plan-2026-07-09.md
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { importCustomerEmailOrNull } from '../../../lib/customer-email.js';
import { captureBackendException } from '../../../lib/sentry.js';
import { registerWorker, enqueueJob } from '../../../lib/queue/index.js';
import { SCRAPER_PRIORITY } from '../../../lib/queue/priorities.js';
import { NU_TRANSPORT } from './nu.constants.js';
import { fetchReservationListViaSftp } from './nu-ftp-transport.js';
import { getCredentials } from './nu.service.js';
import {
  fetchReservationList,
  pickUserAgent,
  NuAuthExpiredError,
  NuLayoutError,
} from './nu.service.js';
import {
  SOURCE_SYSTEM,
  BOOKING_CHANNEL,
  QUEUE_NAME,
  RESERVATION_PREFIX,
  TIME_ZONE,
  windowBoundsForConfig,
} from './nu.constants.js';
import { evaluatePromotion, REVIEW_REASONS } from '../tl-international/promotion-matcher.service.js';
import { findDuplicateReservation } from '../tl-international/duplicate-detector.service.js';

export { QUEUE_NAME };

// ---------------------------------------------------------------------------
// Auto-create customer (mirrors Economy). When promotion is blocked ONLY by
// customer_not_found and NU_AUTO_CREATE_CUSTOMERS is enabled, create a
// lightweight Customer from the row and re-evaluate.
// ---------------------------------------------------------------------------
function autoCreateCustomersEnabled() {
  const raw = (process.env.NU_AUTO_CREATE_CUSTOMERS ?? 'false').toString().trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

const CUSTOMER_PHONE_PLACEHOLDER = '0000000000';

export async function maybeCreateCustomerFromNu(prismaClient, extRes) {
  const firstName = (extRes.customerFirstName || '').trim();
  const lastName = (extRes.customerLastName || '').trim();
  // Writer #13 of the customer-email inventory (lib/customer-email.js). IMPORT
  // policy — drop to null and warn; a bad cell never costs us the reservation.
  const email = importCustomerEmailOrNull(extRes.customerEmail, {
    log: logger,
    source: 'nu',
    tenantId: extRes.tenantId,
    externalRef: extRes.externalRef,
  }) || '';
  const phone = (extRes.customerPhone || '').trim();

  if (!firstName || !lastName) return null;
  if (!email && !phone) return null;

  if (email) {
    const existing = await prismaClient.customer.findFirst({
      where: { tenantId: extRes.tenantId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    }).catch(() => null);
    if (existing) return existing;
  }

  const created = await prismaClient.customer.create({
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
  logger.info('[nu-sync] auto-created Customer from NU data', {
    tenantId: extRes.tenantId,
    externalRef: extRes.externalRef,
    customerId: created.id,
  });
  return created;
}

// ---------------------------------------------------------------------------
// Field mapper — normalized RadGrid row → ExternalReservation shape. Pure.
// Exported. The row is already normalized by parseRadGrid (dates are UTC Dates,
// total is a decimal string, isPrepaid is derived from the Code cell).
// ---------------------------------------------------------------------------
export function mapRowToExternalReservation(row, opts = {}) {
  const r = row && typeof row === 'object' ? row : {};
  const externalRef = String(r.confirmation || '').trim();

  return {
    externalRef,
    channel: r.pu || null,                // PU desk/loc code (informational)
    supplierRef: r.altConfirmation || null,
    status: 'CONFIRMED',                  // NU grid rows are confirmed reservations
    customerFirstName: r.firstName ? String(r.firstName).trim() : null,
    customerLastName: r.lastName ? String(r.lastName).trim() : null,
    customerEmail: null,                  // NU grid carries no email
    customerPhone: r.phone ? String(r.phone).trim() : null,
    customerCountry: null,
    flightNumber: r.flight ? String(r.flight).trim() : null,
    vehicleAcriss: r.acriss ? String(r.acriss).trim().toUpperCase() : null,
    vehicleDescription: null,
    pickupAt: r.pickupAt instanceof Date ? r.pickupAt : null,
    pickupLocation: r.pu ? String(r.pu).trim() : null,
    dropoffAt: r.dropoffAt instanceof Date ? r.dropoffAt : null,
    dropoffLocation: null,
    totalAmount: r.total ?? null,
    currency: 'USD',
    isPrepaid: typeof r.isPrepaid === 'boolean' ? r.isPrepaid : null,
    rawJson: { list: r },
  };
}

/**
 * The job handler. Exported for direct invocation from tests + a bootstrap CLI.
 * Job payload: { tenantId, triggeredBy }.
 */
export async function nuSyncHandler(job) {
  const { tenantId, triggeredBy = 'schedule' } = job?.data || {};
  if (!tenantId) throw new Error('nu.sync: job.data.tenantId is required');

  const userAgent = pickUserAgent();
  logger.info('[nu-sync] starting run', { tenantId, triggeredBy });

  // Resolve the tenant's enabled NuLocationConfig. 1:1 FLL → a single enabled
  // row is expected. If multiple exist (future multi-center), we key by
  // externalCenter later; for now the single-row path is the norm.
  //
  // orderBy createdAt asc makes the single-config pick DETERMINISTIC and keeps it
  // BYTE-IDENTICAL to the manual-promote path in nu.routes.js (which orders the
  // same way). Without it, configs[0] would be nondeterministic if >1 enabled row
  // ever slipped past the 1:1 write-time guard, and the two paths could disagree
  // on the target location.
  const configs = await prisma.nuLocationConfig.findMany({
    where: { tenantId, enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { locationId: true, externalCenter: true, lookbackDays: true, lookaheadDays: true },
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
  let skippedCrossTenant = 0;
  let finalStatus = 'OK';
  let parseDiagnostics = null; // FIX B — parser-health signal from parseRadGrid
  let layoutError = null;      // FIX A — NuLayoutError message when the grid drifted
  let multiConfigNote = null;  // 1:1 invariant breached — >1 enabled config row
  const errorSamples = [];

  try {
    if (configs.length === 0) {
      logger.info('[nu-sync] no enabled NuLocationConfig for tenant — nothing to sync', { tenantId });
    }

    // 1:1 invariant defence. The write path (nu.routes.js) rejects a second
    // enabled config with a 409, so this should never fire — but if a row ever
    // slips through (manual DB edit, race), do NOT silently pick a random one:
    // mark the run ATTENTION + WARN so it is surfaced, and still resolve the
    // DETERMINISTIC earliest-createdAt config (configs[0], ordered above).
    if (configs.length > 1) {
      multiConfigNote = `1:1 invariant breached: ${configs.length} enabled NuLocationConfig rows for tenant — using earliest (createdAt asc); disable the extras`;
      if (finalStatus === 'OK') finalStatus = 'ATTENTION';
      logger.warn('[nu-sync] multiple enabled NuLocationConfig rows — expected exactly one', {
        tenantId, runId: runRow.id, enabledCount: configs.length,
      });
    }

    // 1:1 FLL: the target location is the single enabled config. (Multi-center:
    // resolve per-row by externalCenter — the grid has no per-row center for the
    // 1:1 account, so we take the single row; documented seam for later.)
    const primaryConfig = configs[0] || null;
    const targetLocationId = primaryConfig?.locationId || null;

    // Single date window (1:1). Fall back to env defaults per null override.
    const now = Date.now();
    const { dateFrom, dateTo } = windowBoundsForConfig(primaryConfig || {}, now);

    // Transport seam (2026-07-27): NU_TRANSPORT=sftp pulls the .REZ drop files
    // over SFTP (delete-after-download); default 'http' keeps the RadGrid
    // scraper. Both return the SAME normalized row shape, so everything below
    // is unchanged. The SFTP path ignores the date window (NU decides which
    // files to drop); the scraper still windows.
    let rows;
    if (configs.length === 0 || !targetLocationId) {
      rows = [];
    } else if (NU_TRANSPORT === 'sftp') {
      const creds = await getCredentials(tenantId);
      rows = await fetchReservationListViaSftp(tenantId, { creds });
    } else {
      rows = await fetchReservationList(tenantId, { dateFrom, dateTo, userAgent });
    }
    parseDiagnostics = rows?.diagnostics || null;

    pickupsFound = rows.length;
    logger.info('[nu-sync] list fetched', {
      tenantId, runId: runRow.id, fetched: rows.length, targetLocationId,
    });

    // Pre-fetch existing rows for these refs. The ExternalReservation unique is
    // (sourceSystem, externalRef) WITHOUT tenantId, so query by
    // sourceSystem+externalRef only — this both counts new vs updated AND
    // detects a cross-tenant collision (a row owned by a DIFFERENT tenant must
    // NOT be flipped by this tenant's sync).
    const refs = rows.map((r) => String(r?.confirmation || '').trim()).filter(Boolean);
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
      const externalRef = String(row?.confirmation || '').trim();
      if (!externalRef) { errorsCount++; errorSamples.push('row missing confirmation'); continue; }
      try {
        // Cross-tenant guard.
        const ownerTenantId = existingByRef.get(externalRef);
        if (ownerTenantId && ownerTenantId !== tenantId) {
          skippedCrossTenant++;
          logger.warn('[nu-sync] cross-tenant ExternalReservation collision — row skipped', {
            tenantId, externalRef, ownerTenantId, runId: runRow.id,
          });
          continue;
        }

        const wasKnown = knownSet.has(externalRef);
        const mapped = mapRowToExternalReservation(row, { timeZone: TIME_ZONE });

        const upserted = await prisma.externalReservation.upsert({
          where: { source_ref_unique: { sourceSystem: SOURCE_SYSTEM, externalRef } },
          create: { ...mapped, tenantId, sourceSystem: SOURCE_SYSTEM },
          update: { ...mapped, lastSyncedAt: new Date(), syncRunCount: { increment: 1 } },
        });

        if (wasKnown) updatedExisting++; else newlyInserted++;

        // Idempotent: skip if already promoted in a prior run.
        if (upserted.promotionStatus === 'AUTO_PROMOTED' || upserted.promotionStatus === 'PROMOTED') {
          continue;
        }

        // NuLocationConfig is authoritative for location → overrideLocationId
        // skips the promotion matcher's LocationCodeMap gate (location_unmapped
        // can never be the blocker for NU); any OTHER gate still routes to
        // MANUAL_REVIEW.
        const promoOpts = { prisma, overrideLocationId: targetLocationId };
        let decision = await evaluatePromotion(upserted, promoOpts);

        if (decision.decision === 'MANUAL_REVIEW'
          && decision.reason === REVIEW_REASONS.CUSTOMER_NOT_FOUND
          && autoCreateCustomersEnabled()) {
          try {
            const newCust = await maybeCreateCustomerFromNu(prisma, upserted);
            if (newCust) decision = await evaluatePromotion(upserted, promoOpts);
          } catch (createErr) {
            logger.warn('[nu-sync] auto-create customer failed; MANUAL_REVIEW', {
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
            captureBackendException(promoErr, {
              integration: { source: SOURCE_SYSTEM, tenantId, externalRef },
            });
          }
        } else {
          needsReview++;
          await prisma.externalReservation.update({
            where: { id: upserted.id },
            data: { promotionStatus: 'MANUAL_REVIEW', needsReviewReason: decision.reason || null },
          });
        }
      } catch (err) {
        if (err instanceof NuAuthExpiredError) throw err;
        errorsCount++;
        errorSamples.push(`${externalRef}: ${err.message}`);
        captureBackendException(err, {
          integration: { source: SOURCE_SYSTEM, tenantId, externalRef },
        });
      }
    }

    if (errorsCount > 0 && (newlyInserted + updatedExisting) > 0) finalStatus = 'PARTIAL';
    if (errorsCount > 0 && (newlyInserted + updatedExisting) === 0) finalStatus = 'FAILED';
  } catch (err) {
    if (err instanceof NuAuthExpiredError) {
      finalStatus = 'AUTH_EXPIRED';
      logger.warn('[nu-sync] session expired', { tenantId, runId: runRow.id, message: err.message });
      await prisma.integrationCredential.updateMany({
        where: { tenantId, sourceSystem: SOURCE_SYSTEM },
        data: { lastTestStatus: 'EXPIRED', lastTestedAt: new Date() },
      }).catch(() => {});
      captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId }, level: 'warning' });
    } else if (err instanceof NuLayoutError) {
      // FIX A — the grid header drifted; parseRadGrid refused to import a shifted
      // mapping. Record ATTENTION (NOT a silent OK 0) so the layout change is
      // surfaced and fixed before any corrupt estimatedTotal / isPrepaid lands.
      finalStatus = 'ATTENTION';
      layoutError = err.message;
      logger.error('[nu-sync] RadGrid layout drift — refusing to import a shifted mapping', {
        tenantId, runId: runRow.id, message: err.message,
      });
      captureBackendException(err, {
        integration: { source: SOURCE_SYSTEM, tenantId, runId: runRow.id }, level: 'warning',
      });
    } else {
      finalStatus = 'FAILED';
      logger.error('[nu-sync] fatal error', {
        tenantId, runId: runRow.id, message: err.message, stack: err.stack,
      });
      captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId } });
    }
  }

  // FIX B — fold the parser-health signal into the run record. A present-but-
  // empty grid or a truncated page is NOT a clean OK: mark ATTENTION (unless a
  // worse status already stands) and emit a Sentry breadcrumb so a silent parser
  // break / paging loss is caught. A genuinely-empty window (grid present, 0 rows,
  // pager total 0) leaves diagnostics quiet → stays OK.
  let attentionNote = null;
  if (parseDiagnostics) {
    const d = parseDiagnostics;
    const flags = [];
    if (d.emptyGridAnomaly) flags.push(`grid present but 0 rows parsed (total=${d.totalCount ?? 'unknown'})`);
    if (d.truncated) flags.push(`page truncation: parsed ${d.parsedRows} of ${d.totalCount ?? '?'} (pages=${d.pageCount ?? '?'})`);
    if (d.unexpectedCodeTokens > 0) flags.push(`${d.unexpectedCodeTokens} unexpected Code token(s)`);
    if (!d.headerFound && d.gridPresent) flags.push('grid header not found (column-drift guard skipped)');

    if ((d.emptyGridAnomaly || d.truncated) && finalStatus === 'OK') finalStatus = 'ATTENTION';
    if (flags.length) {
      attentionNote = flags.join('; ');
      captureBackendException(new Error(`[nu-sync] parser attention: ${attentionNote}`), {
        integration: { source: SOURCE_SYSTEM, tenantId, runId: runRow.id }, level: 'warning',
      });
    }
  }

  const noteParts = [];
  if (layoutError) noteParts.push(`LAYOUT DRIFT: ${layoutError}`);
  if (multiConfigNote) noteParts.push(multiConfigNote);
  if (attentionNote) noteParts.push(attentionNote);
  if (errorSamples.length) noteParts.push(errorSamples.slice(0, 5).join(' | '));

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
      notes: noteParts.length ? noteParts.join(' | ') : null,
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

/**
 * Build a fresh Reservation from an ExternalReservation + decision, using the
 * config-mapped locationId + FLL timezone. Exported so routes (Fase 5, manual
 * promote) can call the same code path.
 */
export async function promoteAutomatically(extRes, decision, opts = {}) {
  if (decision?.decision !== 'AUTO') {
    throw new Error('promoteAutomatically requires decision.decision === "AUTO"');
  }
  return promoteWithMappings(extRes, {
    customerId: decision.mappedCustomer.id,
    locationId: opts.locationId || decision.mappedLocation?.id,
    vehicleCategory: decision.mappedVehicleCategory,
    timeZone: opts.timeZone,
    promotedByUserId: null,
    isAuto: true,
  });
}

/**
 * Lower-level promote path (used by AUTO and by manual promote in routes).
 * MONEY: writes ONLY estimatedTotal — no charge, no card, no autocharge, even
 * for pay-at-destination rows (the counter collects those manually).
 */
export async function promoteWithMappings(extRes, opts) {
  const {
    customerId,
    locationId,
    vehicleCategory = null,
    vehicleTypeId = null,
    timeZone = TIME_ZONE,
    promotedByUserId = null,
    isAuto = false,
  } = opts || {};

  if (!customerId) throw new Error('promote: customerId is required');
  if (!locationId) throw new Error('promote: locationId is required');

  return await prisma.$transaction(async (tx) => {
    const fresh = await tx.externalReservation.findUnique({ where: { id: extRes.id } });
    if (!fresh) throw new Error(`ExternalReservation ${extRes.id} not found`);
    if (fresh.promotionStatus === 'AUTO_PROMOTED' || fresh.promotionStatus === 'PROMOTED') {
      if (fresh.promotedToReservationId) {
        const existing = await tx.reservation.findUnique({ where: { id: fresh.promotedToReservationId } });
        if (existing) return { reservation: existing, alreadyPromoted: true };
      }
    }

    let resolvedVehicleTypeId = vehicleTypeId;
    if (!resolvedVehicleTypeId && vehicleCategory) {
      const vt = await tx.vehicleType.findFirst({
        where: { tenantId: fresh.tenantId, code: { equals: vehicleCategory, mode: 'insensitive' } },
        select: { id: true },
      }).catch(() => null);
      resolvedVehicleTypeId = vt?.id || null;
    }

    const pickupAt = fresh.pickupAt || new Date();
    const returnAt = fresh.dropoffAt || new Date(pickupAt.getTime() + 3 * 24 * 60 * 60 * 1000);

    const duplicateId = await findDuplicateReservation(tx, fresh, { timeZone }).catch(() => null);
    if (duplicateId) {
      const linkedReservation = await tx.reservation.findUnique({ where: { id: duplicateId } });
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
      logger.info(`[nu-sync] ${fresh.externalRef}: LINKED to existing Reservation ${duplicateId}`, {
        tenantId: fresh.tenantId, externalRef: fresh.externalRef, reservationId: duplicateId,
      });
      return { reservation: linkedReservation, externalReservation: linkedUpdate, alreadyPromoted: false, linked: true };
    }

    const reservation = await tx.reservation.create({
      data: {
        tenantId: fresh.tenantId,
        reservationNumber: `${RESERVATION_PREFIX}${fresh.externalRef}`,
        sourceRef: fresh.externalRef,
        status: 'CONFIRMED',
        bookingChannel: BOOKING_CHANNEL,
        customerId,
        vehicleTypeId: resolvedVehicleTypeId,
        pickupAt,
        returnAt,
        pickupLocationId: locationId,
        returnLocationId: locationId,
        estimatedTotal: fresh.totalAmount ?? null,
        // Structured prepaid signal (money-adjacent). Copied verbatim from the
        // ExternalReservation so the counter's badge reads a boolean, not a notes
        // string. null when the source carries no signal → no behavior change.
        // MONEY: informational only — no charge, no card, even for prepaid rows.
        isPrepaid: typeof fresh.isPrepaid === 'boolean' ? fresh.isPrepaid : null,
        notes: `Imported from NU Car Rentals — ${fresh.externalRef}`
          + (fresh.isPrepaid === false ? ' (pay-at-destination)' : ''),
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
 * Convenience: enqueue a one-off sync (manual "Run now").
 */
export async function enqueueOneOffSync(tenantId, triggeredBy = 'manual') {
  return enqueueJob(QUEUE_NAME, { tenantId, triggeredBy }, {
    jobId: `nu-sync:${tenantId}:${Date.now()}`,
    priority: 5,
  });
}

/**
 * Register the worker with BullMQ. Idempotent — call once at worker boot.
 */
export function registerNuSyncWorker() {
  registerWorker(QUEUE_NAME, nuSyncHandler, {
    concurrency: 1,
    priority: SCRAPER_PRIORITY,
  });
  logger.info('[nu-sync] worker registered', { queue: QUEUE_NAME });
}
