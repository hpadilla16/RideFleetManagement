/**
 * Ephemeral customer location sharing — the pure decisions (Phase 3,
 * 2026-08-25; approved mockup Screens 9 + 10). IO lives in
 * shuttle-tracker.service.js (Redis) and the monitor service.
 *
 * THE PRIVACY CONSTRAINTS ARE BINDING (Screen 9, approved verbatim):
 *   • opt-in — the customer presses "Compartir ubicación"; nothing automatic
 *   • ephemeral — Redis with a short TTL, NEVER a database row
 *   • coordinates never appear in logs or audit metadata
 *   • the customer's own coords go back out ONLY on the staff-authed monitor
 *     read; the public tracker learns a straight-line distance, not an echo
 *   • auto-stops: TTL expiry, or the request closing (completed / cancelled /
 *     no-show) deletes the key
 *
 * Keys are request ids — cuids, no PII — matching the shuttle:pos naming.
 */
import { haversineKm } from '../vehicles/overdue-geofence.js';

/** Redis key per request. Request ids are cuids — no PII in key names. */
export const custLocKey = (requestId) => `shuttle:custloc:${requestId}`;
/** Seconds a shared fix lives; every push refreshes it (owner decision: 5min). */
export const CUSTOMER_LOC_TTL_S = 300;
/** A stored fix older than this reads as not-sharing even if the key survived
 *  (defensive — TTL should have reaped it first). */
export const CUSTOMER_LOC_FRESH_MS = CUSTOMER_LOC_TTL_S * 1000;

const num = (v) => {
  // null coerces to 0 under Number() — an absent coordinate must never
  // become "the equator", it must fail validation.
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Validate the public POST body. Strict: two finite in-range numbers or a
 * refusal — never store (or math on) garbage. The error string deliberately
 * does not echo what was sent.
 */
export function validateCustomerFix(body = {}) {
  const lat = num(body?.lat);
  const lng = num(body?.lng);
  if (lat === null || Math.abs(lat) > 90 || lng === null || Math.abs(lng) > 180) {
    return { ok: false, error: 'lat and lng must be valid coordinates' };
  }
  return { ok: true, fix: { lat, lng } };
}

/** Parse a stored Redis value back into a fix, or null. */
export function parseStoredFix(raw, now = Date.now()) {
  if (!raw) return null;
  let obj = null;
  try { obj = JSON.parse(raw); } catch { return null; }
  const lat = num(obj?.lat);
  const lng = num(obj?.lng);
  const at = num(obj?.at);
  if (lat === null || lng === null || at === null) return null;
  if (now - at > CUSTOMER_LOC_FRESH_MS) return null;
  return { lat, lng, at };
}

/** Straight-line distance in whole meters (owner decision: straight-line OK). */
export function distanceMeters(a, b) {
  const aLat = num(a?.lat ?? a?.latitude);
  const aLng = num(a?.lng ?? a?.longitude);
  const bLat = num(b?.lat ?? b?.latitude);
  const bLng = num(b?.lng ?? b?.longitude);
  if (aLat === null || aLng === null || bLat === null || bLng === null) return null;
  return Math.round(haversineKm(aLat, aLng, bLat, bLng) * 1000);
}

/**
 * What the PUBLIC tracker payload may say about the viewer's own sharing —
 * an active flag and a distance. NO coordinates: the page already knows where
 * the customer is (it is the one pushing); echoing coords back out of the
 * server would only widen the public surface for nothing.
 *
 * @param {object|null} fix the viewer's stored fix (parseStoredFix output)
 * @param {Array<{latitude,longitude}>} shuttlePositions candidate shuttle
 *   fixes — the assigned vehicle's only (on-demand, assigned) or all fresh
 *   ones (cyclical); nearest wins.
 */
export function publicLocationSharing(fix, shuttlePositions = []) {
  if (!fix) return { active: false, distanceMeters: null };
  let best = null;
  for (const p of Array.isArray(shuttlePositions) ? shuttlePositions : []) {
    const d = distanceMeters(fix, p);
    if (d !== null && (best === null || d < best)) best = d;
  }
  return { active: true, distanceMeters: best };
}
