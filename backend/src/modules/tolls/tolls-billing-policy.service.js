/**
 * Toll billing decision — pure. Three modes (2026-07-28, LAX #10 added the third):
 *
 *  USAGE_ONLY          — a `coversTolls` package is on the reservation: the
 *                        customer PREPAID, so usage is recorded but nothing is
 *                        billed (no toll charges, no policy fee).
 *  PASSTHROUGH_NO_FEE  — a `tollPassthrough` service ("Toll Activation") is on
 *                        the reservation: the ACTUAL tolls used are billed at
 *                        cost, but the location's toll policy/admin fee is NOT
 *                        applied.
 *  CHARGEABLE          — neither service: tolls billed + policy fee per the
 *                        location's toll policy (the historical default).
 *
 * Precedence: prepaid coverage WINS over pass-through — if the customer bought
 * a package that covers tolls, billing them at cost anyway would double-dip.
 */
export function evaluateTollBillingPolicy({
  prepaidTollServiceCount = 0,
  tollPassthroughServiceCount = 0,
  transactions = []
} = {}) {
  const usageCount = Array.isArray(transactions) ? transactions.length : 0;
  const coveredByTollPackage = Number(prepaidTollServiceCount || 0) > 0;
  const tollPassthrough = !coveredByTollPackage && Number(tollPassthroughServiceCount || 0) > 0;

  return {
    coveredByTollPackage,
    tollPassthrough,
    billingMode: coveredByTollPackage ? 'USAGE_ONLY' : (tollPassthrough ? 'PASSTHROUGH_NO_FEE' : 'CHARGEABLE'),
    usageOnlyCount: coveredByTollPackage ? usageCount : 0,
    chargeableCount: coveredByTollPackage ? 0 : usageCount,
    shouldCreateChargeRows: !coveredByTollPackage,
    shouldApplyPolicyFee: !coveredByTollPackage && !tollPassthrough && usageCount > 0
  };
}
