/**
 * SOLD-ITEM charge taxonomy (2026-07-25, LAX #4). MONEY.
 *
 * "Everything a virtual agent sells" = additional services + insurance,
 * excluding taxes, fees and deposits (Hector, 2026-07-25). The catch:
 * RentalAgreementCharge.source is a free-form string and "a sold service"
 * is spelled at least four ways across the codebase (booking engine, staff
 * UI, pre-check-in portal, kiosk) with NO shared constant — every module
 * re-lists its own subset (see tolls.service.js TOLL_PACKAGE_CHARGE_SOURCES
 * for the precedent this replaces going forward). This module is the one
 * authoritative list; add new sale paths HERE, not inline.
 */

export const SERVICE_CHARGE_SOURCES = [
  'ADDITIONAL_SERVICE',            // staff UI / additional-services module
  'SERVICE',                       // booking engine (website)
  'ADDITIONAL_SERVICE_PRECHECKIN', // customer portal self-serve upsell
  'KIOSK_UPSELL'                   // kiosk flow
];

export const INSURANCE_CHARGE_SOURCES = ['INSURANCE'];

export const SOLD_ITEM_SOURCES = [...SERVICE_CHARGE_SOURCES, ...INSURANCE_CHARGE_SOURCES];

/**
 * Is this charge a SOLD item for commission purposes? Deliberately an
 * INCLUSION list (a new fee source added tomorrow can never leak into a
 * commission base), plus the same eligibility floor the standard commission
 * path uses: selected, positive total, not a tax, not a deposit.
 */
export function isSoldItemCharge(charge = {}) {
  if (charge?.selected === false) return false;
  if (!(Number(charge?.total || 0) > 0)) return false;
  const chargeType = String(charge?.chargeType || '').toUpperCase();
  if (chargeType === 'TAX' || chargeType === 'DEPOSIT') return false;
  return SOLD_ITEM_SOURCES.includes(String(charge?.source || '').toUpperCase());
}
