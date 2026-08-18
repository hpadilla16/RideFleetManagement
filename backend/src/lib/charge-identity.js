/**
 * WHICH ReservationCharge ROWS ARE ACTUALLY A TAX ROW.
 *
 * `chargeType: 'TAX'` is not sufficient, and code that assumed it was has now
 * been wrong twice — once in mex.worker.js and once in long-term.service.js,
 * both on 2026-08-18, both in the undercharge direction. Hence one shared
 * predicate rather than a copy per caller.
 *
 * THE ROW THAT LIES. reservation-pricing.service.js:1085 materializes
 *
 *   { source: 'QUOTE_TAXES_FEES', name: 'Taxes & fees (booked price)',
 *     chargeType: 'TAX', total: <remainder> }
 *
 * for a reservation that has an estimatedTotal but NO priced charge rows — a
 * converted quote, or an externally promoted booking. It is `chargeType: 'TAX'`
 * and it is NOT a tax row: it carries the REMAINDER of the booked price after
 * the daily base, taxes AND fees fused into a single line, and it exists to
 * hold the invariant `sum(seeded) + feeRowsTotal === est`
 * (reservation-pricing.service.js:1068). Mandatory fees are already subtracted
 * before it is written (:1069-1073), so the money in it is not recoverable from
 * anywhere else.
 *
 * WHAT GOES WRONG WHEN A TAX RECOMPUTE CLAIMS IT. Both failure modes are real
 * and both were measured against the live functions:
 *   - resolved rate 0  -> the row is DELETED as a stale tax row. Straight loss
 *     of the fee component. Location.taxRate is non-null @default(0)
 *     (schema.prisma:660), so any tenant that never configured a rate lands
 *     here on the very next reprice — no car-sharing and no snapshot needed.
 *   - resolved rate > 0 -> the row is UPDATED IN PLACE into the recomputed tax.
 *     The fee component is dropped and the result is a row whose `source` still
 *     says QUOTE_TAXES_FEES while its `name` says "Sales Tax".
 *
 * @param {{source?: string|null}} [row] a ReservationCharge row.
 * @returns {boolean} true when the row is the booked-price remainder, which a
 *   tax recompute must neither overwrite nor delete.
 */
export function isBookedPriceRemainder(row) {
  return String(row?.source || '').toUpperCase() === 'QUOTE_TAXES_FEES';
}

/**
 * A row a tax recompute owns: it may be updated in place, or removed when the
 * resolved rate says no tax is owed.
 *
 * The identities in play, all legitimate targets, and all of them carry
 * `chargeType: 'TAX'`:
 *   source/chargeType TAX — booking-engine.service.js:1900,
 *                           mex-reservation-detail.js:396, long-term.service.js
 *                           :147, and the staff pricing editor's own save.
 *   source TAX_RECALC     — reservation-extend.service.js:326 and the portal
 *                           voucher path, which write no `code`.
 *   chargeType TAX alone  — legacy/backfilled rows.
 *
 * `code` IS DELIBERATELY NOT CONSULTED, and putting it back is a money bug.
 * ReservationCharge.code is copied verbatim from Fee.code / AdditionalService
 * .code (reservation-pricing.service.js:658), which are admin FREE TEXT
 * (schema.prisma:3055, `String?` with no enum) typed in Settings. A company
 * billing a municipal or tourism tax as a mandatory fee and coding it "TAX" is
 * an ordinary configuration — and the comparison would be case-insensitive, so
 * "tax" and "Tax" match too. Claiming that row means a recompute either
 * overwrites a `chargeType: UNIT` fee with the computed tax (keeping its
 * `source: MANDATORY_FEE` and `sourceRefId`, so the next pricing read flips it
 * straight back and the reservation's total oscillates) or deletes it outright.
 * Every genuine producer above sets `chargeType`, so the clause bought nothing.
 *
 * The remainder exclusion MUST stay first: `chargeType === 'TAX'` below would
 * otherwise match it and the exclusion would be dead code.
 *
 * @param {{source?: string|null, chargeType?: string|null}} [row]
 * @returns {boolean}
 */
export function isTaxRow(row) {
  if (isBookedPriceRemainder(row)) return false;
  return String(row?.source || '').toUpperCase() === 'TAX'
    || String(row?.chargeType || '').toUpperCase() === 'TAX';
}
