/**
 * The rental quote money composition — ONE implementation, two callers.
 *
 * WHY THIS FILE EXISTS (2026-08-24, quote rate override): the booking engine's
 * searchRental() is the only place that turns a base total into the
 * subtotal/fees/taxes/total a customer is quoted. A staff rate override has to
 * produce numbers that line up with that engine exactly — swapping dailyRate
 * and leaving the other columns is how a quote starts lying about its own math.
 * Rather than restate the formula in the quotes module, the expression was
 * lifted verbatim out of searchRental into this dependency-free helper and
 * BOTH paths now call it (searchRental directly, the override through
 * bookingEngineService.recomputeRentalQuoteMoney).
 *
 * The arithmetic below is a BYTE-FOR-BYTE lift of what searchRental used to
 * inline — same operand order, same money() placement, same use of the RAW
 * base total (not the rounded subtotal) inside the tax and total expressions.
 * Do not "tidy" it: rounding order is the difference between a cent matching
 * and a cent not matching. src/lib/rental-money.test.mjs pins that parity.
 */
import { money } from './money.js';

/**
 * @param {object} input
 * @param {number} input.baseTotal   sum of the per-day rates (engine's quote.baseTotal)
 * @param {number} input.taxRate     location.taxRate, as a PERCENT (7.5 = 7.5%)
 * @param {Array<{total:number}>} input.mandatoryFees  already-priced fee lines
 * @returns {{subtotal:number, fees:number, taxes:number, total:number}}
 */
export function composeRentalMoney({ baseTotal, taxRate, mandatoryFees } = {}) {
  const base = Number(baseTotal || 0);
  const taxes = money(base * (Number(taxRate || 0) / 100));
  const fees = money((mandatoryFees || []).reduce((sum, fee) => sum + Number(fee?.total || 0), 0));
  const total = money(base + taxes + fees);
  return { subtotal: money(base), fees, taxes, total };
}
