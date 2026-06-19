/**
 * Competitor-pool hygiene for Market Intelligence.
 *
 * The Expedia scraper stores vendor names exactly as they appear on the listing,
 * so the same company shows up under many spellings ("U-Save" / "U-Save Car
 * Rental", "ACE" / "ACE Rent A Car", "NÜ Car Rentals" / "NU", "Nextcar" /
 * "NextCar"). That double-counts vendors and corrupts "cheapest competitor".
 * Worse, the tenant's OWN brand (e.g. ZezGo at SJU) shows up as a competitor, so
 * the engine ends up undercutting itself.
 *
 * This module gives us:
 *   - vendorKey(raw)         → a canonical key for dedup/exclusion matching.
 *   - normalizeVendorName(raw) → a clean display name (suffix stripped, trimmed).
 *   - DEFAULT_EXCLUDE_KEYS    → own brands we never compete against.
 *   - excludeSetFor(keys)     → a Set<vendorKey> built from raw names or keys.
 *   - isExcludedVendor(raw, set) → predicate used by the aggregators.
 *
 * All pure (no prisma) so it's trivially unit-testable and safe to call in tight
 * aggregation loops.
 */

// Trailing descriptors that don't distinguish a brand. Longest phrases first so
// "Car Rentals" is removed before the standalone "Rentals" rule can mangle it.
const SUFFIXES = [
  'RENT A CAR', 'RENT-A-CAR', 'CAR RENTALS', 'CAR RENTAL', 'CAR HIRE',
  'AUTO RENTALS', 'AUTO RENTAL', 'RENTALS', 'RENTAL',
];

// No hardcoded brands: the exclusion list is configured PER TENANT from the UI
// (Settings → Market Intelligence → "Excluded competitors"), stored on
// Tenant.marketExcludedVendors. Each tenant lists their own brand(s) + any
// vendors they don't want in the competitor pool. This module just provides the
// matching machinery; the names come from the tenant's config.
export const DEFAULT_EXCLUDE_KEYS = [];

function stripDiacritics(s) {
  // NÜ → NU, etc. (NFD splits the accent into a combining mark we then drop.)
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Canonical key: uppercase, de-accented, suffix-stripped, alphanumerics only. */
export function vendorKey(raw) {
  if (!raw) return '';
  let s = stripDiacritics(String(raw)).toUpperCase();
  s = s.replace(/[^A-Z0-9]+/g, ' ').trim(); // punctuation → space
  for (const suf of SUFFIXES) {
    if (s.endsWith(' ' + suf) || s === suf) {
      s = s.slice(0, s.length - suf.length).trim();
      break;
    }
  }
  return s.replace(/\s+/g, ''); // "U SAVE" → "USAVE"
}

/** Clean display name: strip a trailing descriptor, collapse whitespace. */
export function normalizeVendorName(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim();
  const up = stripDiacritics(s).toUpperCase();
  for (const suf of SUFFIXES) {
    if (up.endsWith(' ' + suf)) {
      s = s.slice(0, s.length - suf.length).trim();
      break;
    }
  }
  return s;
}

/** Build a Set of vendorKeys from a mix of raw names and/or keys. */
export function excludeSetFor(namesOrKeys = []) {
  const set = new Set(DEFAULT_EXCLUDE_KEYS);
  for (const n of (Array.isArray(namesOrKeys) ? namesOrKeys : [])) {
    const k = vendorKey(n);
    if (k) set.add(k);
  }
  return set;
}

/** True when this vendor should be dropped from the competitor pool. */
export function isExcludedVendor(raw, excludeSet) {
  if (!excludeSet || excludeSet.size === 0) return false;
  return excludeSet.has(vendorKey(raw));
}
