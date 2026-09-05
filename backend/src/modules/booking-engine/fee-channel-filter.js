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
// Online channels: the public website and partner-program bookings made through it
// (Partnerships F2, 2026-09-05). A PARTNER reservation is quoted with the website's
// mandatory fees at checkout; treating it like STAFF here made the first pricing
// re-sync delete those rows (quoted ≠ synced — QA M1).
const ONLINE_CHANNELS = new Set(['WEBSITE', 'PARTNER']);

export function filterMandatoryFeesForChannel(fees, bookingChannel) {
  const isWebsite = ONLINE_CHANNELS.has(String(bookingChannel || 'WEBSITE').toUpperCase());
  return (fees || []).filter((fee) => {
    if (!fee?.isActive || !fee?.mandatory) return false;
    if (fee.displayOnline && !isWebsite) return false;
    return true;
  });
}
