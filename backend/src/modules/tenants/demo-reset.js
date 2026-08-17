/**
 * Demo tenant reset — the DECISIONS (pure, no IO).
 *
 * WHY THIS EXISTS (Hector, 2026-08-17): Ride University's practice mode lets
 * any employee of any tenant rehearse on the demo tenant. That is the point —
 * and it means the tenant used for sales demos accumulates trainee bookings,
 * half-finished check-outs and vehicles left ON RENT. Without a way back to a
 * clean stage, the choice becomes "let trainees practice" OR "keep the demo
 * presentable". This gives both.
 *
 * WHAT RESET MEANS: every TRANSACTIONAL record goes — reservations and
 * everything hanging off them, agreements, shuttle requests — and every
 * vehicle returns to AVAILABLE. The stage itself stays: users, customers,
 * locations, vehicles, types, rates, settings, training progress. A demo then
 * starts from an empty book, which is where you want it: you create the
 * reservation live, in front of the client.
 *
 * WHAT IT NEVER TOUCHES: any tenant whose isDemo is not exactly true. That is
 * checked against the loaded row, not against an id passed in by a caller.
 */

/**
 * Children of Reservation whose foreign key is RESTRICT / NO ACTION — these
 * BLOCK the delete and must be cleared first. Read out of information_schema
 * on 2026-08-17 rather than guessed; the sibling test re-reads it so a new
 * blocking table cannot appear without failing CI.
 *
 * Not listed, deliberately:
 *   - CASCADE children (charges, payments, pricing snapshots, additional
 *     drivers, handoff tokens, toll/citation assignments, long-term plans,
 *     trip incidents) — Postgres removes them with the reservation.
 *   - SET NULL children (citations, toll transactions, Dejavoo transactions,
 *     kiosk sessions, trips, host reviews) — they survive and simply detach,
 *     which is right: a toll is a real-world fact that outlives the booking.
 */
export const BLOCKING_CHILDREN = Object.freeze([
  'auditLog',
  'checkoutSession',
  'invoice',
  'loanerAgreement',
  'rentalAgreement',
  'reservationIncident',
  'reservationSigning',
  'shuttleRequest',
]);

/** Records keyed to the tenant (not to a reservation) that a reset clears. */
export const TENANT_SCOPED_CLEARS = Object.freeze([
  // Tokenized links point at reservations that are about to stop existing.
  // Leaving them would serve a public page for a deleted booking.
  'shuttleTrackerLink',
]);

export const RESET_CONFIRMATION = 'RESET DEMO';

/**
 * The one gate that matters. Takes the LOADED tenant row, never an id: the
 * caller cannot talk this into running by naming a tenant, only by the
 * database itself saying that tenant is the demo.
 */
export function assertResettable(tenant) {
  if (!tenant) {
    const e = new Error('Tenant not found');
    e.status = 404;
    throw e;
  }
  if (tenant.isDemo !== true) {
    const e = new Error(`Refusing to reset "${tenant.name}" — it is not the demo tenant. Only a tenant explicitly flagged as demo can be reset.`);
    e.status = 403;
    throw e;
  }
  return tenant;
}

/** A typo-proof confirmation, so a stray click cannot wipe the stage. */
export function assertConfirmed(phrase) {
  if (String(phrase || '').trim().toUpperCase() !== RESET_CONFIRMATION) {
    const e = new Error(`Type "${RESET_CONFIRMATION}" to confirm.`);
    e.status = 400;
    throw e;
  }
}

/** Human summary of what a reset did, for the response and the log line. */
export function summarize(counts = {}) {
  const removed = Object.entries(counts)
    .filter(([, n]) => Number(n) > 0)
    .map(([table, n]) => `${n} ${table}`);
  return removed.length ? removed.join(', ') : 'nothing to clear — the demo was already clean';
}
