/**
 * WHICH SALES TAX RATE APPLIES: the rate the customer was QUOTED (the
 * reservation's pricing snapshot), else the pickup location's.
 *
 * A STORED ZERO IS A RATE, NOT A MISSING VALUE. ReservationPricingSnapshot
 * .taxRate is nullable (schema.prisma:2823), so "unset" already has its own
 * representation, and car-sharing.service.js:253 stores a literal 0 for a trip
 * it does not tax — on a reservation whose pickup location DOES have a rate.
 * Coalescing on FALSY would quietly start taxing those trips, and would let the
 * location beat the snapshot on the paths where the snapshot is meant to win.
 * `??`-semantics here match buildReservationBreakdown (customer-portal.routes.js)
 * and rental-agreements.service.js:2844/3241, which is the majority convention.
 *
 * WHO ACTUALLY WRITES THE COLUMN (inventory taken 2026-08-18). Every entry was
 * checked; the rule above is only as good as this list being complete.
 *
 *   reservation-pricing.service.js:116  toNullableNumber() -> NULL for unset.
 *   reservations.service.js:2351        omits taxRate entirely -> NULL.
 *   car-sharing.service.js:253          literal 0, and MEANS it (untaxed trip).
 *     The premise rests on the QUOTE the guest agreed to —
 *     computeMarketplaceTripPricing({ taxes: 0 }) at car-sharing.service.js:184
 *     and :195 — not on the charge row's flags: the TRIP_DAILY row it writes is
 *     `taxable: true` (car-sharing.service.js:269). Harmless, since 0% of
 *     anything is 0, but it is the quote that makes the zero deliberate.
 *   booking-engine.service.js:1769 (create) and :1783 (update)
 *     `Number(search.location?.taxRate || 0)`. Reads as a falsy-coalesce but
 *     cannot fire: searchRental() SELECTs taxRate and throws when no location
 *     matches, and Location.taxRate is non-null with default 0
 *     (schema.prisma:660), so the operand is always a Decimal — truthy even at
 *     zero. It stores the location's real rate; it never guesses.
 *   reservations.routes.js:1275-1315    `pickupLoc?.taxRate ?? null`.
 *     The staff create/update route, and the highest-volume writer of the
 *     column. It was `?? 0` until 2026-08-18, which was a "I could not find the
 *     location" zero rather than a rate — pickupLoc is null when the id does not
 *     resolve inside the caller's tenant scope, and validateLocationWindow()
 *     returns silently in that case (reservations.service.js:873) instead of
 *     refusing the create. Under the rule above that invented 0 would suppress
 *     sales tax on the reservation forever, so it now writes NULL and lets the
 *     fallback do its job. Changed together with the extension-path fix,
 *     because honouring stored zeros is only safe once no writer invents one.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE LINES INLINE. The zero case is very hard
 * to test through a database: Prisma hands a `Decimal?` column back as a Decimal
 * OBJECT, and `new Decimal(0)` is TRUTHY, so a DB-backed case can pass
 * identically whether the rule reads `||` or `!= null`. That is measured, not
 * assumed — it is what let the pre-check-in bug ship green. Only a PRIMITIVE 0
 * tells the two apart, and feeding one by hand needs a seam like this.
 *
 * PROVENANCE, and the one thing to do at merge time. This rule was first lifted
 * out on 2026-08-18 for the pre-check-in charge sheet, as
 * `resolveTaxRate` inside `modules/customer-portal/precheckin-charges.js` (branch
 * `fix/precheckin-charges-merged`). The extension path is its second caller and
 * `modules/reservations` must not import out of `modules/customer-portal`, so the
 * rule lives HERE, in lib, where both sides can reach it. Behaviour is identical
 * to that original by construction.
 *   -> WHEN `fix/precheckin-charges-merged` LANDS: delete the copy in
 *      precheckin-charges.js and re-export this one. Two implementations of a
 *      money rule is the failure this extraction exists to prevent.
 *
 * @param {object} [args]
 * @param {number|string|object|null} [args.snapshotRate] pricingSnapshot.taxRate, verbatim
 *   (a Prisma Decimal, a primitive, or null/undefined when there is no snapshot).
 * @param {number|string|object|null} [args.locationRate] pickup Location.taxRate, or null
 *   when the location was not read — which callers should skip whenever the
 *   snapshot already has a rate.
 * @returns {number} a percentage. 0 means "write no tax row".
 */
export function resolveTaxRate({ snapshotRate = null, locationRate = null } = {}) {
  const raw = hasSnapshotRate(snapshotRate) ? snapshotRate : locationRate;
  const rate = Number(raw ?? 0);
  return Number.isFinite(rate) ? rate : 0;
}

/**
 * Does the snapshot answer the question by itself? Exported so a caller that
 * wants to SKIP reading the location can ask the rule instead of re-deriving
 * the same predicate — reservation-extend.service.js fetches the location
 * lazily and would otherwise carry its own copy of the precedence decision,
 * which is the exact duplication this module exists to prevent.
 *
 * `!= null` on purpose: it accepts null AND undefined (a reservation with no
 * snapshot row hands us undefined), and rejects nothing else — 0 included.
 *
 * The empty string is the one addition to that. Prisma cannot produce it
 * (`Decimal|null`), but this signature accepts strings, and a caller handing
 * over a CLEARED form field would otherwise get `Number('')` — a silent 0, i.e.
 * tax suppressed, which is the undercharge direction. `''` means "unset" here,
 * exactly as toNullableNumber() already decides it does at
 * reservation-pricing.service.js:24.
 *
 * @param {number|string|object|null} [snapshotRate] pricingSnapshot.taxRate, verbatim.
 * @returns {boolean} true when the snapshot carries a rate, a deliberate 0 included.
 */
export function hasSnapshotRate(snapshotRate) {
  if (snapshotRate == null) return false;
  return !(typeof snapshotRate === 'string' && snapshotRate.trim() === '');
}
