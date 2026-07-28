/**
 * Pre-check-in customer field policy (2026-07-28, LAX #5/#6) — frontend
 * mirror of backend/src/lib/precheckin-fields.js. KEEP BOTH IN LOCKSTEP.
 *
 * Rule (Hector): ALL customer fields mandatory EXCEPT the insurance-related
 * ones; the driver's-license photo is mandatory too. address2 stays optional
 * (structurally optional everywhere).
 *
 * Consumed by: the customer-portal pre-check-in form, the reservation page's
 * staff "Fill In For Customer" panel, and the New Reservation V2 customer step.
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
  'idPhotoUrl',
]);

export const CUSTOMER_FIELD_LABELS = Object.freeze({
  firstName: 'First Name',
  lastName: 'Last Name',
  email: 'Email',
  phone: 'Phone',
  dateOfBirth: 'Date of Birth',
  licenseNumber: 'Driver License Number',
  licenseState: 'Driver License State',
  address1: 'Address Line 1',
  address2: 'Address Line 2',
  city: 'City',
  state: 'State',
  zip: 'ZIP',
  country: 'Country',
  idPhotoUrl: 'ID / License Photo',
  licenseBackUrl: 'License Back Photo',
  insurancePolicyNumber: 'Insurance Policy #',
  insuranceExpiry: 'Insurance Exp Date',
  insuranceDocumentUrl: 'Insurance Document',
});

/** Required fields still missing on a form-shaped object (''/null = missing). */
export function missingRequiredCustomerFields(values = {}) {
  return REQUIRED_CUSTOMER_FIELDS.filter((key) => {
    const v = values?.[key];
    if (v === null || v === undefined) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    return false;
  });
}
