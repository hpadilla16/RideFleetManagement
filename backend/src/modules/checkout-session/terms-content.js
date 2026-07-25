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

import logger from '../../lib/logger.js';

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

// 2026-07-25 — damage acknowledgement (LAX meeting item #3). Signed IN
// PERSON in the Report Damage wizard when the customer is present and
// accepts responsibility; optional — the wizard works unchanged without it.
// NOT part of sectionsForAgreement (it is not an agreement-signing section;
// it never lands in AgreementSectionInitial). Overrideable per location via
// the same termsSectionsJson mechanism — see damageAcknowledgementSection().
export const DAMAGE_ACKNOWLEDGEMENT_SECTION = {
  key: 'damage_acknowledgement',
  label: 'Damage acknowledgement',
  body: 'I acknowledge that I caused the damage described in this report ' +
        'during my rental, and I accept responsibility for it under the terms ' +
        'of my rental agreement, up to the amounts and deductibles that apply ' +
        'to the coverage I selected. I have reviewed the description and the ' +
        'photographs included in this report and confirm they reflect the ' +
        'damage accurately.',
};

/**
 * Resolve the damage-acknowledgement statement for a branch. The TEXT the
 * customer signs is snapshotted onto the damage report at signing time, so a
 * later wording change never rewrites what someone already signed.
 */
export function damageAcknowledgementSection({ sectionOverrides } = {}) {
  const overrides = parseSectionOverrides(sectionOverrides);
  const o = overrides[DAMAGE_ACKNOWLEDGEMENT_SECTION.key];
  return o ? { ...DAMAGE_ACKNOWLEDGEMENT_SECTION, ...o } : DAMAGE_ACKNOWLEDGEMENT_SECTION;
}

/**
 * Parse a Location.termsSectionsJson blob into a key → {label?, body?} map.
 *
 * Tolerant by design: a malformed blob yields {} and the canonical text renders.
 * Failing the signing flow over bad config would strand a customer at the
 * counter. Accepts an already-parsed object so callers can pass either form, and
 * a bare string as shorthand for { body }.
 */
export function parseSectionOverrides(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // MUST be logged. There is no admin UI for this column and
      // PATCH /api/locations/:id validates nothing, so a truncated or mistyped
      // blob would otherwise leave every renter at that branch signing the
      // CANONICAL text while ops believes the branch wording is live — a wrong
      // legal document with no signal anywhere. Same reason the resolver in
      // lib/terms/index.js refuses to swallow its lookup failure.
      logger.error('[terms] Location.termsSectionsJson is not valid JSON — falling back to canonical acknowledgement text', {
        message: String(err?.message || err),
        length: raw.length,
      });
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (parsed !== undefined && parsed !== null) {
      logger.error('[terms] Location.termsSectionsJson must be a JSON object keyed by sectionKey — falling back to canonical text', {
        got: Array.isArray(parsed) ? 'array' : typeof parsed,
      });
    }
    return {};
  }
  const known = new Set([...TC_SECTIONS, DECLINED_INSURANCE_SECTION, DAMAGE_ACKNOWLEDGEMENT_SECTION].map((s) => s.key));
  const out = {};
  const unknown = [];
  for (const [key, val] of Object.entries(parsed)) {
    // A key outside the canonical set can never take effect (see
    // sectionsForAgreement), so silence here would hide a typo that quietly
    // leaves an acknowledgement on the canonical wording.
    if (!known.has(key)) { unknown.push(key); continue; }
    if (!val) continue;
    const body = typeof val === 'string' ? val : val.body;
    const label = typeof val === 'string' ? undefined : val.label;
    const entry = {};
    if (typeof body === 'string' && body.trim()) entry.body = body.trim();
    if (typeof label === 'string' && label.trim()) entry.label = label.trim();
    if (Object.keys(entry).length) out[key] = entry;
  }
  if (unknown.length) {
    logger.error('[terms] Location.termsSectionsJson has keys that match no acknowledgement section — those sections keep the canonical text', {
      unknownKeys: unknown,
      validKeys: [...known],
    });
  }
  return out;
}

/**
 * Build the actual section list for a given agreement, with the
 * declined-insurance addendum injected in the right spot when needed.
 *
 * `sectionOverrides` (from Location.termsSectionsJson) replaces the TEXT of
 * sections by key. It can NOT add, remove or reorder them: `key` is persisted to
 * AgreementSectionInitial and re-matched when the agreement PDF re-prints the
 * initialled pages, so a branch-specific key would orphan initials a customer
 * already signed. An unknown key is ignored on purpose — a typo must not
 * silently drop an acknowledgement from the flow.
 *
 * This exists because these sections were hardcoded. LAX runs on Rightcars'
 * California policies (a $2,000 deposit for California licences, 150 mi/day)
 * while `deposit_post_charges` said "$500" — and that text is re-printed inside
 * the same PDF, right beside the renter's own initials.
 */
export function sectionsForAgreement({ declinedInsurance, sectionOverrides } = {}) {
  const overrides = parseSectionOverrides(sectionOverrides);
  const apply = (s) => {
    const o = overrides[s.key];
    return o ? { ...s, ...o } : s;
  };
  if (!declinedInsurance) return TC_SECTIONS.map(apply);
  // Inject after insurance_coverage so the chain of insurance topics
  // stays contiguous.
  const out = [];
  for (const s of TC_SECTIONS) {
    out.push(apply(s));
    if (s.key === 'insurance_coverage') out.push(apply(DECLINED_INSURANCE_SECTION));
  }
  return out;
}
