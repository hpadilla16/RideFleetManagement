/**
 * Pure helper module: decide which mandatory location fees get auto-applied
 * to a reservation, given the reservation's booking channel.
 *
 * This file intentionally has no imports (no prisma, no logger, etc.) so it
 * can be unit-tested in isolation and reused from any module without pulling
 * in the booking-engine's DB dependencies.
 *
 * Rules:
 *   - Fee must be active AND flagged mandatory.
 *   - Fees with displayOnline=true are website-only. They must NOT be auto-
 *     applied to STAFF or CAR_SHARING reservations - only to reservations
 *     created through the public booking website (bookingChannel=WEBSITE).
 *   - When bookingChannel is missing/unknown, default to WEBSITE so public-
 *     quote paths (which never set bookingChannel) keep their current behavior.
 */
export function filterMandatoryFeesForChannel(fees, bookingChannel) {
  const isWebsite = String(bookingChannel || 'WEBSITE').toUpperCase() === 'WEBSITE';
  return (fees || []).filter((fee) => {
    if (!fee?.isActive || !fee?.mandatory) return false;
    if (fee.displayOnline && !isWebsite) return false;
    return true;
  });
}
