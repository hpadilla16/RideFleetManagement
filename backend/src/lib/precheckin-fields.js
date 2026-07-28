/**
 * Pre-check-in customer field policy (2026-07-28, LAX #5/#6).
 *
 * Hector's rule: ALL customer fields are mandatory EXCEPT the
 * insurance-related ones, and the driver's-license photo upload is mandatory
 * too. This module is the backend's single source of truth — consumed by the
 * customer-portal pre-check-in POST and the staff "fill in for customer"
 * route, which previously each hardcoded their own (drifting) lists.
 *
 * The frontend keeps a mirrored copy in frontend/src/lib/precheckin-fields.js
 * (Next.js can't import backend modules) — keep BOTH in lockstep.
 *
 * address2 (line 2) is intentionally optional — it's structurally optional
 * everywhere. Insurance fields (policy #, expiry, document) are optional by
 * business rule.
 */

export const REQUIRED_CUSTOMER_FIELDS = Object.freeze([
  'firstName',
  'lastName',
  'email',
  'phone',
  'dateOfBirth',
  'licenseNumber',
  'licenseState',
  'address1',
  'city',
  'state',
  'zip',
  'country',
  'idPhotoUrl', // the DL photo — mandatory per Hector
]);

export const OPTIONAL_CUSTOMER_FIELDS = Object.freeze([
  'address2',
  'insurancePolicyNumber',
  'insuranceExpiry',
  'insuranceDocumentUrl',
  'licenseBackUrl',
]);

/**
 * Which required fields are still missing for a customer-shaped object
 * (merged existing customer + incoming patch). Empty/whitespace strings and
 * null/undefined count as missing.
 */
export function missingRequiredCustomerFields(merged = {}) {
  return REQUIRED_CUSTOMER_FIELDS.filter((key) => {
    const v = merged?.[key];
    if (v === null || v === undefined) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    return false;
  });
}
