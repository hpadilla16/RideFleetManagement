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
