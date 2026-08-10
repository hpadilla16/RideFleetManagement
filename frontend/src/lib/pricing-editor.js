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
    const serviceCharges = charges
      .filter((c) => ['SERVICE', 'ADDITIONAL_SERVICE', 'ADDITIONAL_SERVICE_PRECHECKIN'].includes(String(c?.source || '').toUpperCase()));
    const serviceNames = serviceCharges
      .map((c) => stripPrecheckinSuffix(stripChargePrefix(c?.name, /^Service:\s*/i)))
      .filter(Boolean)
      .join(', ');
    // What the reservation ACTUALLY charges for each service, carried beside
    // the names (Hector, 2026-08-10).
    //
    // The editor used to keep names alone, so every rebuild re-derived rate
    // and quantity from the AdditionalService catalog — and a price the agent
    // had typed on THIS reservation was replaced by the configured one and
    // written back on the next Save Override. The name is not enough to
    // describe a price.
    //
    // priceOverridden is the whole point: it separates "a human set this" from
    // "this came from settings". Only the former is frozen, so changing a
    // service's price in settings still reaches reservations nobody edited.
    const servicePricing = serviceCharges
      .map((c) => ({
        sourceRefId: c?.sourceRefId ? String(c.sourceRefId) : null,
        name: stripPrecheckinSuffix(stripChargePrefix(c?.name, /^Service:\s*/i)),
        rate: Number(c?.rate ?? 0),
        quantity: Number(c?.quantity ?? 1),
        priceOverridden: !!c?.priceOverridden,
      }))
      .filter((r) => r.name);
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
      servicePricing,
      feeNames,
      insuranceCodes: insuranceCodesFromCharges || snapshot?.selectedInsuranceCodes || snapshot?.selectedInsuranceCode || ''
    };
  }
  return {
    dailyRate: String(reservation?.dailyRate ?? '0'),
    serviceFee: '0',
    taxRate: '11.5',
    serviceNames: '',
    servicePricing: [],
    feeNames: '',
    insuranceCodes: ''
  };
}
