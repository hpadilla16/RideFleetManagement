/**
 * Inspection photo shape/key normalization (2026-06-10 bugfix).
 *
 * Standalone (no prisma/no side effects) so it can be unit-tested fast without
 * pulling the service's DB chain.
 *
 * Two flows write `photosJson` in DIFFERENT shapes:
 *   - desktop wizard  -> object map { front: <dataUrl|url>, rear: ... }
 *   - mobile flow     -> array [{ key, dataUrl, notes, ... }]
 * AND the mobile flow uses snake_case angle keys (front_seat/rear_seat/dash)
 * while the desktop report grid expects camelCase (frontSeat/rearSeat/dashboard).
 *
 * normalizeInspectionPhotos() collapses both shapes to the object map the read
 * path + frontend expect, applying the key aliases. Backward-compatible: legacy
 * map rows pass through (just key-normalized). Fixes inspections already saved
 * with no migration.
 */

const INSPECTION_PHOTO_KEY_ALIASES = Object.freeze({
  front_seat: 'frontSeat',
  rear_seat: 'rearSeat',
  dash: 'dashboard'
});

export function canonicalPhotoKey(key) {
  const k = String(key || '').trim();
  return INSPECTION_PHOTO_KEY_ALIASES[k] || k;
}

// Fuel level: the mobile inspection page captures an enum string
// (FULL/THREE_QUARTERS/HALF/QUARTER/EMPTY); the desktop wizard and the
// agreement columns use a 0..1 fraction; the contract template formats
// `Math.round(fuel*100)%`. Collapse every shape to a fraction (or null).
const FUEL_ENUM_TO_FRACTION = Object.freeze({
  FULL: 1,
  THREE_QUARTERS: 0.75,
  HALF: 0.5,
  QUARTER: 0.25,
  EMPTY: 0
});

export function fuelLevelToFraction(value) {
  if (value == null || value === '') return null;
  // Already numeric (0..1 fraction, possibly as a string like "0.75").
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n >= 0 && n <= 1) return n;
    // Tolerate percent-style numbers (e.g. 75) just in case.
    if (n > 1 && n <= 100) return n / 100;
    return null;
  }
  const key = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (key in FUEL_ENUM_TO_FRACTION) return FUEL_ENUM_TO_FRACTION[key];
  // Human fractions ("3/4", "1/2") — defensive; some legacy rows have them.
  const frac = key.match(/^(\d+)\/(\d+)$/);
  if (frac && Number(frac[2]) > 0) {
    const v = Number(frac[1]) / Number(frac[2]);
    return v >= 0 && v <= 1 ? v : null;
  }
  return null;
}

export function normalizeInspectionPhotos(parsed) {
  if (!parsed || typeof parsed !== 'object') return {};
  if (Array.isArray(parsed)) {
    const out = {};
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const key = canonicalPhotoKey(item.key);
      if (!key) continue;
      const src = item.dataUrl || item.url || item.src || null;
      if (!src) continue;
      out[key] = src;
    }
    return out;
  }
  // Object map: re-key through the aliases so snake_case map rows also align.
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v == null) continue;
    out[canonicalPhotoKey(k)] = v;
  }
  return out;
}
