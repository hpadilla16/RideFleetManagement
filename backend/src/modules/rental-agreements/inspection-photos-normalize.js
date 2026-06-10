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
