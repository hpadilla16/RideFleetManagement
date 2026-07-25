/**
 * Pure derivation of the Edit-pricing editor state from the live pricing rows
 * (2026-07-25). Extracted from app/reservations/[id]/page.js so the round-trip
 * that money depends on — portal writes charges → editor derives → Save
 * Override rebuilds — is testable without mounting the page.
 *
 * WHY THE DERIVATION RULES MATTER (each was a live money bug):
 *  - `ADDITIONAL_SERVICE_PRECHECKIN` rows are services the CUSTOMER bought at
 *    pre-check-in. They were excluded here, so they never appeared in the
 *    editor — and Save Override replaces every non-extension charge with what
 *    the editor sends, so opening Edit pricing and saving DELETED a purchased
 *    upsell.
 *  - Insurance selection derives from the LIVE INSURANCE charges
 *    (sourceRefId = plan.code, written identically by the booking engine, the
 *    portal and the editor). The old source, snapshot.selectedInsuranceCodes,
 *    is doubly wrong: the portal never updates it (a plan added at pre-check-in
 *    wasn't selected → override dropped it), and the snapshot schema only
 *    persists the SINGULAR selectedInsuranceCode, so the 2nd+ plan silently
 *    vanished on every override. Snapshot remains the fallback for pre-charge
 *    drafts only.
 */

import { stripPrecheckinSuffix } from './precheckin-discount';

export function stripChargePrefix(name = '', prefix) {
  return String(name || '').replace(prefix, '').trim();
}

export function pricingEditorState(pricing, reservation) {
  const snapshot = pricing?.snapshot || null;
  const charges = Array.isArray(pricing?.charges) ? pricing.charges : [];
  if (snapshot || charges.length) {
    const serviceNames = charges
      .filter((c) => ['SERVICE', 'ADDITIONAL_SERVICE', 'ADDITIONAL_SERVICE_PRECHECKIN'].includes(String(c?.source || '').toUpperCase()))
      .map((c) => stripPrecheckinSuffix(stripChargePrefix(c?.name, /^Service:\s*/i)))
      .filter(Boolean)
      .join(', ');
    const feeNames = charges
      .filter((c) => String(c?.source || '').toUpperCase() === 'FEE')
      .map((c) => stripChargePrefix(c?.name, /^Fee:\s*/i))
      .filter(Boolean)
      .join(', ');
    const insuranceCodesFromCharges = charges
      .filter((c) => String(c?.source || '').toUpperCase() === 'INSURANCE')
      .map((c) => String(c?.sourceRefId || '').trim())
      .filter(Boolean)
      .join(', ');
    return {
      dailyRate: String(snapshot?.dailyRate ?? reservation?.dailyRate ?? '0'),
      serviceFee: '0',
      taxRate: String(snapshot?.taxRate ?? '11.5'),
      serviceNames,
      feeNames,
      insuranceCodes: insuranceCodesFromCharges || snapshot?.selectedInsuranceCodes || snapshot?.selectedInsuranceCode || ''
    };
  }
  return {
    dailyRate: String(reservation?.dailyRate ?? '0'),
    serviceFee: '0',
    taxRate: '11.5',
    serviceNames: '',
    feeNames: '',
    insuranceCodes: ''
  };
}
