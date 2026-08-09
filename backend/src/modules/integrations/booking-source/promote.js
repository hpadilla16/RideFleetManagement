/**
 * Shared promotion path for booking-source integrations (R0 extraction,
 * 2026-07-13).
 *
 * nu.worker.js and economy.worker.js carry ~95%-identical copies of
 * promoteWithMappings / promoteAutomatically. The differences are all
 * source-identity, absorbed here by a `sourceSpec`:
 *   - reservationPrefix  ('NU-' / 'ECON-') → reservationNumber
 *   - bookingChannel     ('FRANCHISE_NU' / 'FRANCHISE_ECONOMY')
 *   - sourceLabel        ('NU Car Rentals' / 'Economy (RezLight)') → default notes
 *   - logPrefix          ('[nu-sync]' / '[economy-sync]')
 *   - defaultTimeZone    (both Eastern today; parametrized for the next source)
 *   - buildReservationExtras(freshExtRes) → per-source Reservation fields; the
 *     default emits only the notes line, NU's spec adds its structured
 *     isPrepaid boolean + the '(pay-at-destination)' notes suffix.
 *
 * MONEY: writes ONLY estimatedTotal on the Reservation. No charge, no card, no
 * autocharge — the shared code preserves that posture for every source.
 *
 * NOT wired into economy/nu yet — R0 ships the shared code + tests only; the
 * parity suite (booking-source.test.mjs) proves both sourceSpecs reproduce the
 * original workers' writes exactly.
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { findDuplicateReservation } from './duplicate-detector.service.js';

/**
 * The VehicleType the reservation should carry.
 *
 * BUG (Hector, 2026-08-05): MEX imports arrived with no vehicle type at all —
 * no CFAR, no FVAR — even though the ACRISS was present and correctly mapped at
 * every layer. The category was being lost in the REVIEW path: evaluatePromotion
 * resolves the ACRISS map at gate 2, but a row that fails a LATER gate (customer
 * not found, which is exactly why those six were in review) returns
 * MANUAL_REVIEW and drops the mapping it already had. The routes then only read
 * `mappedVehicleCategory` when the decision was AUTO, so a hand-approved row
 * promoted with vehicleCategory=null. Nothing was wrong with the ACRISS — the
 * customer gate was throwing away the answer to an unrelated question.
 *
 * So the resolution lives here instead, where every caller passes through, and
 * falls back to the ExternalReservation's OWN ACRISS when no caller supplied a
 * category. The order matters:
 *   1. explicit vehicleTypeId  — the operator picked it by hand; never override
 *   2. explicit vehicleCategory — the AUTO decision, or a panel override
 *   3. the row's ACRISS via AcrissCategoryMap — the map may REDIRECT (this
 *      tenant maps ECAR→CCAR and ICAR→SCAR because it stocks neither), so the
 *      map has to be consulted before trying the code directly
 *   4. the ACRISS as a VehicleType code — no map row, but the tenant happens to
 *      stock exactly that class (SPAR, FJAR, …)
 *
 * Never throws: a reservation with no type is worse than it was, but a
 * promotion that fails outright is worse still.
 */
export async function resolveVehicleTypeId(tx, fresh, opts = {}) {
  const { vehicleTypeId = null, vehicleCategory = null, logPrefix = '[promote]' } = opts;
  if (vehicleTypeId) return vehicleTypeId;

  const byCode = async (code) => {
    if (!code) return null;
    const vt = await tx.vehicleType?.findFirst?.({
        where: { tenantId: fresh.tenantId, code: { equals: String(code).trim(), mode: 'insensitive' } },
      select: { id: true },
    })?.catch?.(() => null);
    return vt?.id || null;
  };

  if (vehicleCategory) {
    const hit = await byCode(vehicleCategory);
    if (hit) return hit;
  }

  const acriss = String(fresh?.vehicleAcriss || '').trim().toUpperCase();
  if (!acriss) return null;

  // Optional-chained throughout: a caller's tx may predate this model (rolling
  // deploy) or be a test double, and a missing map must degrade to "no type",
  // never to a thrown promotion.
  const mapped = await tx.acrissCategoryMap?.findFirst?.({
    where: { acrissCode: acriss, OR: [{ tenantId: fresh.tenantId }, { tenantId: null }] },
    // Tenant row wins over the global fallback.
    orderBy: { tenantId: 'desc' },
    select: { vehicleCategory: true },
  })?.catch?.(() => null);

  const resolved = (await byCode(mapped?.vehicleCategory)) || (await byCode(acriss));
  if (!resolved) {
    logger.warn(`${logPrefix} ${fresh?.externalRef}: ACRISS ${acriss} resolved to no VehicleType`, {
      tenantId: fresh?.tenantId, externalRef: fresh?.externalRef, acriss,
      mappedCategory: mapped?.vehicleCategory || null,
    });
  }
  return resolved;
}

/**
 * Build the promote pair for one source.
 *
 * @param {{
 *   reservationPrefix: string,
 *   bookingChannel: string,
 *   sourceLabel: string,
 *   logPrefix: string,
 *   defaultTimeZone?: string,
 *   buildReservationExtras?: (freshExtRes: object) => object,
 *   prismaClient?: object,
 * }} sourceSpec
 * @returns {{ promoteAutomatically: Function, promoteWithMappings: Function }}
 */
export function createPromoter(sourceSpec) {
  const {
    reservationPrefix,
    bookingChannel,
    sourceLabel,
    logPrefix,
    defaultTimeZone = 'America/New_York',
    buildReservationExtras = (fresh) => ({
      notes: `Imported from ${sourceLabel} — ${fresh.externalRef}`,
      // Propagate the prepaid signal by DEFAULT rather than making each source
      // remember to copy it — a source that declares its commercial model (TL
      // is 100% aggregator-prepaid, Advantage 100% pay-on-arrival) gets it onto
      // the Reservation, which is where anything deciding whether to COLLECT
      // money can actually see it.
      //
      // SPREAD, not a plain `isPrepaid: null`: the R0 refactor's parity tests
      // assert that a source which never sets the flag produces a create with
      // NO isPrepaid key at all ("NU-only field stays NU-only"). Writing an
      // explicit null is the same value in Postgres but breaks that contract,
      // and the contract is what proves this shared promoter still reproduces
      // each source's original writes.
      ...(typeof fresh.isPrepaid === 'boolean' ? { isPrepaid: fresh.isPrepaid } : {}),
    }),
    prismaClient = prisma,
  } = sourceSpec || {};

  if (!reservationPrefix) throw new Error('createPromoter: reservationPrefix required');
  if (!bookingChannel) throw new Error('createPromoter: bookingChannel required');

  /**
   * Build a fresh Reservation from an ExternalReservation + AUTO decision.
   * The caller may pass an authoritative config-mapped locationId (Economy/NU
   * path) which wins over the promotion matcher's LocationCodeMap resolution.
   */
  async function promoteAutomatically(extRes, decision, opts = {}) {
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
   * MONEY: writes ONLY estimatedTotal — no charge, no card, no autocharge,
   * even for prepaid / pay-at-destination rows.
   */
  async function promoteWithMappings(extRes, opts) {
    const {
      customerId,
      locationId,
      vehicleCategory = null,
      vehicleTypeId = null,
      timeZone = defaultTimeZone,
      promotedByUserId = null,
      isAuto = false,
    } = opts || {};

    if (!customerId) throw new Error('promote: customerId is required');
    if (!locationId) throw new Error('promote: locationId is required');

    return await prismaClient.$transaction(async (tx) => {
      const fresh = await tx.externalReservation.findUnique({ where: { id: extRes.id } });
      if (!fresh) throw new Error(`ExternalReservation ${extRes.id} not found`);
      if (fresh.promotionStatus === 'AUTO_PROMOTED' || fresh.promotionStatus === 'PROMOTED') {
        if (fresh.promotedToReservationId) {
          const existing = await tx.reservation.findUnique({ where: { id: fresh.promotedToReservationId } });
          if (existing) return { reservation: existing, alreadyPromoted: true };
        }
      }

      const resolvedVehicleTypeId = await resolveVehicleTypeId(tx, fresh, {
        vehicleTypeId,
        vehicleCategory,
        logPrefix,
      });

      const pickupAt = fresh.pickupAt || new Date();
      const returnAt = fresh.dropoffAt || new Date(pickupAt.getTime() + 3 * 24 * 60 * 60 * 1000);

      // Duplicate short-circuit — the source timezone keeps pickup-day
      // truncation on the operator's wall clock, not server UTC.
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
        logger.info(`${logPrefix} ${fresh.externalRef}: LINKED to existing Reservation ${duplicateId}`, {
          tenantId: fresh.tenantId, externalRef: fresh.externalRef, reservationId: duplicateId,
        });
        return { reservation: linkedReservation, externalReservation: linkedUpdate, alreadyPromoted: false, linked: true };
      }

      const reservation = await tx.reservation.create({
        data: {
          tenantId: fresh.tenantId,
          reservationNumber: `${reservationPrefix}${fresh.externalRef}`,
          sourceRef: fresh.externalRef,
          status: 'CONFIRMED',
          bookingChannel,
          customerId,
          vehicleTypeId: resolvedVehicleTypeId,
          pickupAt,
          returnAt,
          pickupLocationId: locationId,
          returnLocationId: locationId,
          estimatedTotal: fresh.totalAmount ?? null,
          // Per-source fields (notes text, NU's structured isPrepaid, ...).
          ...buildReservationExtras(fresh),
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

  return { promoteAutomatically, promoteWithMappings };
}
