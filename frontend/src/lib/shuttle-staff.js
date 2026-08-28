/**
 * Pure helpers for the Phase-3 STAFF surfaces (approved mockup Screens 10 +
 * 17c, 2026-08-25): waiting-customer pins/list, the assignment picker, and
 * driver-shift management. No fetch, no React — unit-testable alone.
 *
 * Data comes from GET /api/shuttle-monitor/positions (`waitingCustomers[]`
 * + `shuttles[]`) — these helpers only reshape it for the UI.
 */

/** "Juan P." → "JP", "K. Osei" → "KO", "Madonna" → "MA", "" → "·".
 *  The initials dot is the mockup's customer pin identity (Screen 10). */
export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '·';
  const letterOf = (w) => {
    const m = String(w).match(/\p{L}|\p{N}/u);
    return m ? m[0] : w[0];
  };
  if (parts.length === 1) {
    const w = parts[0];
    return (w.slice(0, 2).length === 2 ? w.slice(0, 2) : w).toUpperCase();
  }
  return (letterOf(parts[0]) + letterOf(parts[parts.length - 1])).toUpperCase();
}

/** Share-fix age → the same freshness language the shuttles use
 *  ("45s", then minutes past 90s). Null for garbage. */
export function shareAgeText(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return null;
  const v = Math.max(0, Math.round(s));
  if (v < 90) return `${v}s`;
  return `${Math.round(v / 60)}m`;
}

/** ONLY customers actively sharing with a usable fix get a map pin —
 *  non-sharers stay list-only (mockup honesty rule, Screen 10).
 *  null/'' never coerce to coordinate 0,0 — a missing fix is missing. */
const coord = (v) => (v == null || v === '' ? NaN : Number(v));
export function sharingPins(customers = []) {
  return (Array.isArray(customers) ? customers : []).filter((c) => (
    !!c && c.sharing === true
    && Number.isFinite(coord(c.lat)) && Number.isFinite(coord(c.lng))
  ));
}

/** The assignable shuttles at one location, deduped by vehicle — the select
 *  options for the assignment picker. Source rows are monitor `shuttles[]`. */
export function vehicleOptionsAt(shuttles = [], locationId) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(shuttles) ? shuttles : []) {
    if (!s?.vehicleId) continue;
    if (locationId && s.locationId !== locationId) continue;
    if (seen.has(s.vehicleId)) continue;
    seen.add(s.vehicleId);
    out.push({
      vehicleId: s.vehicleId,
      label: s.label || s.plate || s.vehicleId,
      plate: s.plate || null,
    });
  }
  return out;
}

/** The tracker mode at a location (config is per location, so every shuttle
 *  row there carries the same mode). Null when the location has no shuttles.
 *  Assignment is ON_DEMAND-only — loop mode has no dispatch to pick. */
export function modeAt(shuttles = [], locationId) {
  const at = (Array.isArray(shuttles) ? shuttles : [])
    .filter((s) => s && (!locationId || s.locationId === locationId));
  if (!at.length) return null;
  return at.some((s) => s.mode === 'ON_DEMAND') ? 'ON_DEMAND' : 'NON_STOP';
}

/** The two assignment payload shapes → one: the monitor's waitingCustomers
 *  carry {vehicleId,label,plate}, the queue rows carry {id,name,plate}. */
export function normalizeAssignedVehicle(v) {
  if (!v) return null;
  const id = v.vehicleId || v.id || null;
  if (!id) return null;
  return {
    vehicleId: String(id),
    label: v.label || v.name || null,
    plate: v.plate || null,
  };
}

/** Mint options for the driver-shift form: one entry per (vehicle, location)
 *  pair, because mintShift needs locationId when a vehicle serves several. */
export function shiftVehicleOptions(shuttles = []) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(shuttles) ? shuttles : []) {
    if (!s?.vehicleId) continue;
    const key = `${s.vehicleId}|${s.locationId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      vehicleId: s.vehicleId,
      locationId: s.locationId || null,
      label: [s.label || s.plate || s.vehicleId, s.plate].filter(Boolean).join(' · '),
      locationName: s.locationName || null,
    });
  }
  return out;
}

/** linkPath ("/driver/<token>") → the full URL staff hand to the driver. */
export function driverShiftLink(linkPath, origin) {
  const p = String(linkPath || '').trim();
  if (!p) return '';
  const o = String(origin || '').replace(/\/+$/, '');
  return `${o}${p.startsWith('/') ? '' : '/'}${p}`;
}
