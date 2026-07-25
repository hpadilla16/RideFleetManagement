/**
 * Payment reference vocabulary — THE single source of truth (B5 Phase 1
 * review M2, 2026-07-24).
 *
 * `ReservationPayment.reference` holds two very different kinds of value:
 *
 *   • MACHINE-generated gateway references — "<PREFIX>:<gatewayRef>", e.g.
 *     "IPOS:K1a2b3c4d5e6". These are globally unique per reservation by
 *     construction and are covered by the PARTIAL unique index created in
 *     prisma/migrations/20260724_kiosk_b5_phase1/migration.sql. That index is
 *     the idempotency floor that stops a webhook+poll race from double-posting
 *     a payment (and, downstream, double-holding a deposit).
 *
 *   • HUMAN-typed references — a card last-4, an auth code, "OTC-<ts>". These
 *     legitimately repeat on one reservation (a guest who pays twice while
 *     staff types the same last-4 both times; prod had 72 such groups when the
 *     floor was designed), so they are DELIBERATELY excluded from the index.
 *
 * ⚠️ THE TRAP THIS MODULE EXISTS TO PREVENT: the index predicate lists the
 * prefixes in SQL. If a future gateway ships with a new prefix and only the
 * app learns about it, that gateway's payments fall silently OUTSIDE the
 * idempotency floor — no error, just a lost guarantee on the money path.
 *
 * So: add a new gateway prefix HERE, and the migration predicate must be
 * extended in the same change. `payment-references.test.mjs` reads the .sql
 * and fails if this constant and the predicate ever drift apart.
 */

/** Every prefix whose references are machine-generated and unique-by-construction. */
export const GATEWAY_REFERENCE_PREFIXES = Object.freeze(['IPOS', 'AUTHNET', 'SPIN']);

/** The partial unique index that enforces the floor (asserted at test time). */
export const GATEWAY_REFERENCE_INDEX_NAME = 'ReservationPayment_reservationId_gatewayRef_key';

/** Build the canonical stored reference for a gateway payment. */
export function buildGatewayReference(prefix, gatewayRef) {
  const p = String(prefix || '').trim().toUpperCase();
  if (!GATEWAY_REFERENCE_PREFIXES.includes(p)) {
    throw new Error(`unknown gateway reference prefix: ${prefix} (add it to GATEWAY_REFERENCE_PREFIXES and the migration predicate)`);
  }
  const ref = String(gatewayRef || '').trim();
  if (!ref) throw new Error('gatewayRef is required');
  return `${p}:${ref}`;
}

/**
 * Is this reference covered by the partial unique index (i.e. does the
 * P2002-collapse safety net apply to it)?
 */
export function isGatewayReference(reference) {
  const raw = String(reference || '').trim();
  return GATEWAY_REFERENCE_PREFIXES.some((p) => raw.startsWith(`${p}:`));
}
