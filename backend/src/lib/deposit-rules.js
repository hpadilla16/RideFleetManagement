/**
 * Local vs non-local renter deposit rules (2026-07-25). MONEY.
 *
 * Locations can set different security deposits and mileage allowances by
 * whether the renter is LOCAL to the branch. The motivating case is LAX
 * (Rightcars' California policy, already in the location's T&C): a renter
 * holding a California licence OR residing in California must leave a
 * deposit of up to $2,000 and is limited to 150 miles/day; everyone else
 * pre-authorizes up to $1,000 and gets unlimited mileage.
 *
 * Config lives in Location.locationConfig JSON (the established per-location
 * mechanism — same blob that already holds securityDepositAmount and
 * securityDepositAmountDebit):
 *
 *   "depositRules": {
 *     "localStates": ["CA"],
 *     "local":    { "securityDeposit": 2000, "milesPerDay": 150 },
 *     "nonLocal": { "securityDeposit": 1000, "unlimitedMileage": true }
 *   }
 *
 * Design rules (each is a deliberate decision, do not relax casually):
 *  - A malformed blob makes the WHOLE rule inert and logs at ERROR — the
 *    location falls back to its standard securityDepositAmount. Money must
 *    never be decided by a half-parsed config, and silence would mean real
 *    money is wrong (same convention as terms-content's parseSectionOverrides).
 *  - A renter whose locality cannot be determined (no licence state, no
 *    address state) classifies as LOCAL — the HIGHER deposit and the capped
 *    mileage. Conservative for the company, and it matches the contract's own
 *    treatment of renters who can't show a return flight.
 *  - The rule writes exact amounts ($2,000 / $1,000); the contract's "up to"
 *    is the counter agent's call via the manual pricing override, which
 *    always wins over the rule.
 *  - The decision is FROZEN on ReservationPricingSnapshot.securityDepositRuleJson
 *    at reservation time, so editing the customer's licence later never
 *    re-prices a decided reservation, and check-in mileage billing reads the
 *    same decision the deposit was based on.
 */

import logger from './logger.js';

/** Sentinel for "no mileage cap". Chosen because it flows through the fee
 * engine's arithmetic safely: driven − Infinity < 0 → excess 0 → no fee. */
export const UNLIMITED_MILES = Infinity;

// Full-name → USPS code map. licenseState is free text in the customer
// portal ("California" is as likely as "CA"), and misreading a local renter
// as non-local would hand out the LOWER deposit — so we normalize names,
// not just codes. Kiosk OCR and the AAMVA barcode scanner already emit
// 2-letter codes, which pass through untouched.
const US_STATE_NAMES = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS',
  MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK',
  OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
  WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC', 'PUERTO RICO': 'PR', GUAM: 'GU',
  'U.S. VIRGIN ISLANDS': 'VI', 'VIRGIN ISLANDS': 'VI', 'AMERICAN SAMOA': 'AS',
  'NORTHERN MARIANA ISLANDS': 'MP'
};

// Placeholder tokens agents/customers type when the field is EMPTY in
// spirit ("N/A", "-", "unknown"). They must classify as UNKNOWN → LOCAL
// (the conservative tier), not as "some non-local state" — otherwise junk
// input hands out the LOWER deposit, the opposite of the design. Genuine
// foreign-licence text ("Ontario", "International") stays NON_LOCAL: that
// IS data, and the contract gives foreign licences the non-local tier.
// NOTE 'ND' is deliberately absent — it is North Dakota.
const PLACEHOLDER_TOKENS = new Set([
  'N/A', 'NA', 'N.A', 'N/D', 'NONE', 'NULL', 'UNKNOWN', 'PENDING', 'TBD',
  '-', '--', '.', '?', 'X', 'XX'
]);

// Common abbreviations seen in free-text licence fields that must not
// misclassify a REAL local renter as non-local (QA 2026-07-25, m3).
const STATE_ALIASES = { CALIF: 'CA', CALI: 'CA' };

export function normalizeStateCode(value) {
  let raw = String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  raw = raw.replace(/\.$/, ''); // "CALIF." → "CALIF", "N.A." → "N.A"
  if (!raw || PLACEHOLDER_TOKENS.has(raw)) return '';
  if (US_STATE_NAMES[raw]) return US_STATE_NAMES[raw];
  if (STATE_ALIASES[raw]) return STATE_ALIASES[raw];
  return raw;
}

function money2(n) {
  return Number(Number(n).toFixed(2));
}

// Per-process dedupe of malformed-config error logs (see parseDepositRules).
const loggedMalformed = new Set();

function normalizeTier(tier, label, problems) {
  if (!tier || typeof tier !== 'object' || Array.isArray(tier)) {
    problems.push(`${label} must be an object`);
    return null;
  }
  const out = {};
  const knownKeys = ['securityDeposit', 'milesPerDay', 'unlimitedMileage'];
  const unknown = Object.keys(tier).filter((k) => !knownKeys.includes(k));
  if (unknown.length) problems.push(`${label} has unknown keys: ${unknown.join(', ')}`);

  const deposit = Number(tier.securityDeposit);
  if (!Number.isFinite(deposit) || deposit < 0) {
    problems.push(`${label}.securityDeposit must be a finite number >= 0`);
  } else {
    out.securityDeposit = money2(deposit);
  }

  out.unlimitedMileage = tier.unlimitedMileage === true;
  if (tier.milesPerDay !== undefined && tier.milesPerDay !== null) {
    const miles = Number(tier.milesPerDay);
    if (!Number.isFinite(miles) || miles <= 0) {
      problems.push(`${label}.milesPerDay must be a finite number > 0`);
    } else if (out.unlimitedMileage) {
      problems.push(`${label} sets both milesPerDay and unlimitedMileage`);
    } else {
      out.milesPerDay = Math.round(miles);
    }
  }
  return out;
}

/**
 * Validate + normalize locationConfig.depositRules. Returns the normalized
 * rules or null (absent OR malformed — malformed is loud, absent is not).
 */
export function parseDepositRules(cfg, ctx = {}) {
  const raw = cfg?.depositRules;
  if (raw === undefined || raw === null) return null;

  const problems = [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('depositRules must be an object');
  }

  let localStates = [];
  if (!problems.length) {
    const knownKeys = ['localStates', 'local', 'nonLocal'];
    const unknown = Object.keys(raw).filter((k) => !knownKeys.includes(k));
    if (unknown.length) problems.push(`depositRules has unknown keys: ${unknown.join(', ')}`);

    if (!Array.isArray(raw.localStates) || !raw.localStates.length) {
      problems.push('localStates must be a non-empty array');
    } else {
      localStates = raw.localStates.map(normalizeStateCode).filter(Boolean);
      if (!localStates.length) problems.push('localStates has no usable entries');
    }
  }

  const local = problems.length ? null : normalizeTier(raw.local, 'local', problems);
  const nonLocal = problems.length ? null : normalizeTier(raw.nonLocal, 'nonLocal', problems);

  if (problems.length) {
    // Loud by design: an unparseable deposit-rules blob must never quietly
    // decide money. The location falls back to its standard deposit config.
    // Deduped per location+problems: depositSnapshot runs once per vehicle
    // type per availability search, and one bad blob must not flood the log.
    const dedupeKey = `${ctx.locationId || ''}|${problems.join(';')}`;
    if (!loggedMalformed.has(dedupeKey)) {
      if (loggedMalformed.size > 200) loggedMalformed.clear();
      loggedMalformed.add(dedupeKey);
      logger.error('[deposit-rules] malformed locationConfig.depositRules — rule NOT applied, using standard deposit config', {
        locationId: ctx.locationId || null,
        problems
      });
    }
    return null;
  }

  return { localStates, local, nonLocal };
}

/**
 * Classify the renter. Precedence: licence state, then address state, then
 * UNKNOWN → LOCAL (conservative). A present licence that is not a local
 * state — including foreign licences that don't map to a US code — is
 * NON_LOCAL, exactly like the contract treats it.
 */
export function classifyRenterLocality(renter = {}, localStates = []) {
  const license = normalizeStateCode(renter.licenseState);
  if (license) {
    return { locality: localStates.includes(license) ? 'LOCAL' : 'NON_LOCAL', basis: 'LICENSE' };
  }
  const address = normalizeStateCode(renter.addressState);
  if (address) {
    return { locality: localStates.includes(address) ? 'LOCAL' : 'NON_LOCAL', basis: 'ADDRESS' };
  }
  return { locality: 'LOCAL', basis: 'UNKNOWN' };
}

/**
 * Full decision for one renter under one location's rules. Returns null when
 * rules is null. milesPerDay is a number or null; null + unlimitedMileage
 * true means uncapped (JSON can't hold Infinity, so the sentinel is applied
 * later by decideIncludedMilesPerDay).
 */
export function evaluateDepositRule({ rules, renter = {} }) {
  if (!rules) return null;
  const { locality, basis } = classifyRenterLocality(renter, rules.localStates);
  const tier = locality === 'LOCAL' ? rules.local : rules.nonLocal;
  return {
    locality,
    basis,
    localStates: rules.localStates,
    securityDepositAmount: money2(tier.securityDeposit),
    milesPerDay: tier.milesPerDay ?? null,
    unlimitedMileage: !!tier.unlimitedMileage
  };
}

/** Safe parse of ReservationPricingSnapshot.securityDepositRuleJson. */
export function parseDepositRuleDecision(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Mileage allowance from a frozen decision: UNLIMITED_MILES (Infinity) for
 * uncapped, the capped number, or null when the decision carries no mileage
 * information (caller falls back to vehicle type, then the legacy 200).
 */
export function decideIncludedMilesPerDay({ decision }) {
  if (!decision) return null;
  if (decision.unlimitedMileage === true) return UNLIMITED_MILES;
  const miles = Number(decision.milesPerDay);
  if (Number.isFinite(miles) && miles > 0) return miles;
  return null;
}
