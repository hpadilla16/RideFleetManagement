/**
 * Canonical T&C sections for the checkout-wizard-v2 signing flow.
 *
 * Customer signs initials per section on their phone (via /sign/:token).
 * The full T&C document (lib/terms/tc-<VERSION>.html) is still rendered
 * verbatim in the final agreement PDF — these sections are the
 * boiled-down acknowledgements they actively read and initial.
 *
 * sectionKey is the stable identifier we persist to
 * AgreementSectionInitial. Changing a key requires a migration; the
 * text/label can change freely.
 *
 * declined_insurance is conditional — only injected when the
 * RentalAgreement.declinedInsurance flag is true. The wizard's step-1
 * toggle controls this.
 */

export const TC_SECTIONS = [
  {
    key: 'rental_period',
    label: 'Rental period',
    body: 'I agree to return the vehicle by the scheduled return date and time. ' +
          'Late returns are billed in hourly increments after a 30-minute grace ' +
          'period. Extensions must be authorized in advance through the rental ' +
          'agent or the customer portal.',
  },
  {
    key: 'mileage_fuel',
    label: 'Mileage and fuel',
    body: 'I will return the vehicle at the fuel level shown at pickup. Refueling ' +
          'at the counter is billed at the prevailing market rate plus a service ' +
          'fee. Mileage in excess of the daily allowance is billed per mile at ' +
          'the rate disclosed at checkout.',
  },
  {
    key: 'insurance_coverage',
    label: 'Insurance and coverage',
    body: 'I understand the coverage option I selected at checkout. Coverage ' +
          'does not extend to off-road use, prohibited uses described below, or ' +
          'damage caused by negligence. Personal auto policies may provide ' +
          'additional coverage; verify with your carrier.',
  },
  {
    key: 'liability_damages',
    label: 'Liability and damages',
    body: 'I am responsible for any damage to the vehicle not covered by the ' +
          'coverage option I selected, including but not limited to interior ' +
          'stains, exterior body damage, and lost keys. Repair and replacement ' +
          'costs may be billed to the card on file.',
  },
  {
    key: 'deposit_post_charges',
    label: 'Deposit and post-rental charges',
    body: 'I authorize a security deposit hold of $500 against my card on file. ' +
          'I further authorize the merchant to charge the same card for ' +
          'unpaid tolls, traffic fines, parking citations, fuel, cleaning, ' +
          'and damage assessed after the rental ends.',
  },
  {
    key: 'prohibited_use',
    label: 'Prohibited use and authorized drivers',
    body: 'I will not drive the vehicle off paved roads, race or test it, use ' +
          'it to tow, smoke or allow smoking in it, or permit anyone other ' +
          'than authorized drivers listed on the agreement to operate it. ' +
          'Violations void coverage and may incur penalties.',
  },
];

// Optional addendum — only signed when the agreement has
// declinedInsurance = true. Inserted between insurance_coverage and
// liability_damages on the signing flow.
export const DECLINED_INSURANCE_SECTION = {
  key: 'declined_insurance',
  label: 'Declined insurance acknowledgement',
  body: 'I acknowledge that I was offered counter insurance and declined it. ' +
        'I understand that all damage, theft, third-party claims, and related ' +
        'costs are my sole responsibility under the rental agreement. I have ' +
        'confirmed coverage through my personal auto policy or another source.',
};

/**
 * Build the actual section list for a given agreement, with the
 * declined-insurance addendum injected in the right spot when needed.
 */
export function sectionsForAgreement({ declinedInsurance } = {}) {
  if (!declinedInsurance) return TC_SECTIONS;
  // Inject after insurance_coverage so the chain of insurance topics
  // stays contiguous.
  const out = [];
  for (const s of TC_SECTIONS) {
    out.push(s);
    if (s.key === 'insurance_coverage') out.push(DECLINED_INSURANCE_SECTION);
  }
  return out;
}
