/**
 * Route-corridor geometry + off-route state machine — PURE (2026-08-25,
 * owner-approved in-house detection). No Prisma, no fetch, no Redis: the IO
 * half lives in shuttle-alerts.scheduler.js (detectInHouseEvents), same split as
 * shuttle-zone-alerts.js.
 *
 * WHY IN-HOUSE: the GPS provider exposes no route/corridor alert API (the
 * apidoc gap documented in telematics-onestepgps.js), so ROUTE zones were
 * store-only. The worker already holds fresh house fixes every ~60s — that is
 * enough to answer "is this van inside the corridor?" ourselves.
 *
 * GEOMETRY APPROXIMATION (documented, deliberate): point-to-segment distance
 * uses an EQUIRECTANGULAR local projection — lat/lng deltas are scaled to
 * meters around the fix's latitude and the segment distance is computed in
 * that flat plane. At city scale (segments up to a few km, offsets up to the
 * 5 km tolerance cap) the error vs. true geodesic distance is well under 1%
 * — far inside the 50 m minimum tolerance — and it degrades gracefully, not
 * catastrophically, for longer segments. Not suitable near the poles or for
 * segments crossing the antimeridian; shuttle corridors do neither.
 */

const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in meters between two {lat,lng}. Exact (haversine). */
export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** {lat,lng} → planar meters relative to `origin` (equirectangular). */
function toLocalMeters(p, origin, cosLat) {
  return {
    x: toRad(p.lng - origin.lng) * cosLat * EARTH_RADIUS_M,
    y: toRad(p.lat - origin.lat) * EARTH_RADIUS_M,
  };
}

/**
 * Distance in meters from point `p` to the SEGMENT a→b (not the infinite
 * line). Equirectangular local projection centered on `p` (see header).
 */
export function pointToSegmentMeters(p, a, b) {
  const cosLat = Math.cos(toRad(p.lat));
  const A = toLocalMeters(a, p, cosLat);
  const B = toLocalMeters(b, p, cosLat);
  // p is the local origin (0,0).
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const len2 = abx * abx + aby * aby;
  // Degenerate segment (repeated vertex) → plain point distance.
  const t = len2 > 0 ? Math.max(0, Math.min(1, (-A.x * abx + -A.y * aby) / len2)) : 0;
  const cx = A.x + t * abx;
  const cy = A.y + t * aby;
  return Math.hypot(cx, cy);
}

const validPoint = (p) => p != null
  && Number.isFinite(Number(p.lat)) && Math.abs(Number(p.lat)) <= 90
  && Number.isFinite(Number(p.lng)) && Math.abs(Number(p.lng)) <= 180;

/**
 * Min distance (meters) from `point` to a polyline given as [{lat,lng},...].
 * Returns Infinity for unusable geometry (<2 valid points) — callers must
 * treat that as "cannot evaluate", never as "off route".
 */
export function distanceToPolylineM(point, polylinePoints) {
  if (!validPoint(point) || !Array.isArray(polylinePoints)) return Infinity;
  const pts = polylinePoints
    .map((p) => (validPoint(p) ? { lat: Number(p.lat), lng: Number(p.lng) } : null))
    .filter(Boolean);
  if (pts.length < 2) return Infinity;
  const p = { lat: Number(point.lat), lng: Number(point.lng) };
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pointToSegmentMeters(p, pts[i], pts[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/** Fallback when a ROUTE row predates (or lost) its tolerance. Mirrors
 *  ROUTE_TOLERANCE_DEFAULT_M in shuttle-zone-alerts.js — kept as a literal so
 *  this module stays dependency-free. */
export const DEFAULT_TOLERANCE_M = 300;

/**
 * Corridor verdict for one GPS fix against one ROUTE zone row.
 *
 * @param {{lat:number, lng:number}} fix
 * @param {{geometryJson?:{points?:Array}, toleranceM?:number}} route our ShuttleZone ROUTE row
 * @returns {{off:boolean, distanceM:number|null, toleranceM:number}}
 *   `off:false, distanceM:null` = geometry unusable — FAIL CLOSED (a broken
 *   route must alarm nobody; the zones editor prevents saving one anyway).
 */
export function isOffRoute(fix, route) {
  const toleranceM = Number.isFinite(Number(route?.toleranceM)) && Number(route.toleranceM) > 0
    ? Number(route.toleranceM)
    : DEFAULT_TOLERANCE_M;
  const d = distanceToPolylineM(fix, route?.geometryJson?.points);
  if (!Number.isFinite(d)) return { off: false, distanceM: null, toleranceM };
  return { off: d > toleranceM, distanceM: d, toleranceM };
}

// ─── Zone containment (in-house ENTER/EXIT, 2026-08-25 scope addition) ──────
//
// Discovered live: the provider's trigger system produced NOTHING for a real
// zone crossing, so ENTER/EXIT detection is ALSO ours now — provider alert
// ingestion remains as enrichment only. Containment is standard even–odd ray
// casting on the raw lat/lng plane: at city scale (zones spanning at most a
// few km, away from the poles and the antimeridian) the plane distortion
// cannot flip an in/out verdict except within a meter-ish sliver of the
// boundary, where GPS noise dominates anyway. Rectangles are stored as their
// 4 corner points, so the same polygon test covers them.

/**
 * Even–odd ray-cast containment. Points exactly ON an edge are undefined
 * (either verdict) — irrelevant at GPS accuracy.
 * @returns {boolean} false for unusable geometry (<3 valid points) — a broken
 *   polygon detects NOTHING (fail closed), never everything.
 */
export function pointInPolygon(point, polygonPoints) {
  if (!validPoint(point) || !Array.isArray(polygonPoints)) return false;
  const pts = polygonPoints
    .map((p) => (validPoint(p) ? { lat: Number(p.lat), lng: Number(p.lng) } : null))
    .filter(Boolean);
  if (pts.length < 3) return false;
  const x = Number(point.lng);
  const y = Number(point.lat);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].lng; const yi = pts[i].lat;
    const xj = pts[j].lng; const yj = pts[j].lat;
    const crosses = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Containment verdict for one fix against one ZONE row (polygon/rectangle —
 *  rectangles are stored as their 4 corners). */
export function isInsideZone(fix, zone) {
  return pointInPolygon(fix, zone?.geometryJson?.points);
}

// ─── Zone presence state machine (ENTER/EXIT) ───────────────────────────────
//
// Per (zoneId, vehicleId): the FIRST observation (and the first after a
// continuity gap) only SEEDS the baseline — a van already sitting inside a
// zone at worker boot must not fire a spurious ENTER. After that, any
// confirmed in/out flip emits immediately (1 tick): zones are hundreds of
// meters across and the arrival notification is latency-sensitive — a
// customer at the curb should not wait an extra minute for a debounce that
// guards against jitter the zone's own size already absorbs. (A van parked
// exactly ON a boundary can flap; that risk is documented, not hidden — the
// fix is drawing the zone around the parking spot, not through it.)

export function createZonePresenceTracker({ gapResetMs = GAP_RESET_MS } = {}) {
  /** @type {Map<string, {inside:boolean, lastSeenAt:number}>} */
  const pairs = new Map();

  return {
    /**
     * @returns {{fire: 'ENTER'|'EXIT'|null, baseline?: boolean}}
     */
    observe({ zoneId, vehicleId, inside, now }) {
      const key = `${zoneId}|${vehicleId}`;
      const s = pairs.get(key);
      if (!s || (s.lastSeenAt != null && now - s.lastSeenAt > gapResetMs)) {
        // Seed (or re-seed after a gap): establishes where the van IS,
        // emits nothing — transitions need a before AND an after.
        pairs.set(key, { inside, lastSeenAt: now });
        return { fire: null, baseline: true };
      }
      s.lastSeenAt = now;
      if (inside !== s.inside) {
        s.inside = inside;
        return { fire: inside ? 'ENTER' : 'EXIT' };
      }
      return { fire: null };
    },

    reset() { pairs.clear(); },

    prune(now, maxIdleMs = 60 * 60 * 1000) {
      for (const [key, s] of pairs) {
        if (s.lastSeenAt == null || now - s.lastSeenAt > maxIdleMs) pairs.delete(key);
      }
    },

    size() { return pairs.size; },
  };
}

// ─── Off-route state machine ────────────────────────────────────────────────
//
// Per (routeZoneId, vehicleId) pair, fed one observation per worker tick
// (~60s). Semantics:
//   * OFF_ROUTE fires only after DEBOUNCE_TICKS (2) consecutive off
//     observations — one bad fix (GPS jitter, a tunnel) never alarms.
//   * While the pair stays OFF, no further OFF_ROUTE fires — one excursion,
//     one alert.
//   * Recovery = RECOVERY_TICKS (2) consecutive in-corridor observations →
//     the pair returns to ON and a BACK_ON_ROUTE (feed-only) is emitted.
//   * COOLDOWN: a new OFF_ROUTE within COOLDOWN_MS (10 min) of the last one
//     is suppressed UNLESS a recovery happened in between. This is what stops
//     an observation gap (stale fixes reset the pair — see next point) from
//     re-firing the SAME excursion as if it were new: the fire history
//     survives the reset, the counters do not.
//   * An observation gap longer than GAP_RESET_MS breaks continuity: the
//     counters AND the ON/OFF state reset (the fire/cooldown history
//     survives). Two off fixes an hour apart are not evidence of one
//     excursion — and a still-off vehicle re-detected after a gap re-alerts
//     at most once per cooldown window.
//
// In-memory per worker process (like the fast poll's write memo): a restart
// merely forgets an in-flight excursion — worst case one duplicate alert per
// pair per restart, bounded by the providerRef minute bucket.

export const DEBOUNCE_TICKS = 2;
export const RECOVERY_TICKS = 2;
export const COOLDOWN_MS = 10 * 60 * 1000;
export const GAP_RESET_MS = 3 * 60 * 1000;

export function createOffRouteTracker({
  debounceTicks = DEBOUNCE_TICKS,
  recoveryTicks = RECOVERY_TICKS,
  cooldownMs = COOLDOWN_MS,
  gapResetMs = GAP_RESET_MS,
} = {}) {
  /** @type {Map<string, object>} pairKey → state */
  const pairs = new Map();

  return {
    /**
     * One tick's observation for one (route, vehicle).
     * @returns {{fire: 'OFF_ROUTE'|'BACK_ON_ROUTE'|null, firstOffAt?: number, suppressed?: boolean}}
     *   `firstOffAt` (epoch ms of the FIRST off observation of this
     *   excursion) rides along with OFF_ROUTE — it keys the idempotent
     *   providerRef.
     */
    observe({ zoneId, vehicleId, off, now }) {
      const key = `${zoneId}|${vehicleId}`;
      let s = pairs.get(key);
      if (!s) {
        s = { state: 'ON', offCount: 0, onCount: 0, firstOffAt: null, lastSeenAt: null, lastFiredAt: null, recoveredSinceFire: true };
        pairs.set(key, s);
      }
      if (s.lastSeenAt != null && now - s.lastSeenAt > gapResetMs) {
        // Continuity lost — start the pair over. lastFiredAt/recoveredSinceFire
        // deliberately survive: they are the cooldown's memory.
        s.state = 'ON';
        s.offCount = 0;
        s.onCount = 0;
        s.firstOffAt = null;
      }
      s.lastSeenAt = now;

      if (off) {
        s.onCount = 0;
        s.offCount += 1;
        if (s.firstOffAt == null) s.firstOffAt = now;
        if (s.state === 'ON' && s.offCount >= debounceTicks) {
          s.state = 'OFF';
          const inCooldown = s.lastFiredAt != null
            && !s.recoveredSinceFire
            && now - s.lastFiredAt < cooldownMs;
          if (inCooldown) return { fire: null, suppressed: true };
          s.lastFiredAt = now;
          s.recoveredSinceFire = false;
          return { fire: 'OFF_ROUTE', firstOffAt: s.firstOffAt };
        }
        return { fire: null };
      }

      s.offCount = 0;
      s.onCount += 1;
      if (s.state === 'OFF' && s.onCount >= recoveryTicks) {
        s.state = 'ON';
        s.firstOffAt = null;
        const hadFired = !s.recoveredSinceFire;
        s.recoveredSinceFire = true;
        // BACK_ON_ROUTE only closes an excursion that actually alerted —
        // a cooldown-suppressed excursion resolves silently.
        return hadFired ? { fire: 'BACK_ON_ROUTE' } : { fire: null };
      }
      if (s.state === 'ON' && !s.recoveredSinceFire && s.onCount >= recoveryTicks) {
        // A gap-reset pair proving itself back in the corridor re-arms the
        // cooldown silently (no state flip happened, so no BACK_ON_ROUTE).
        s.recoveredSinceFire = true;
      }
      return { fire: null };
    },

    /** Test seam + worker hygiene. */
    reset() { pairs.clear(); },

    /** Drop pairs not observed for `maxIdleMs` (route deleted, vehicle
     *  unconfigured) — but never one still inside its cooldown window. */
    prune(now, maxIdleMs = 60 * 60 * 1000) {
      for (const [key, s] of pairs) {
        const idle = s.lastSeenAt == null || now - s.lastSeenAt > maxIdleMs;
        const cooling = s.lastFiredAt != null && now - s.lastFiredAt < COOLDOWN_MS;
        if (idle && !cooling) pairs.delete(key);
      }
    },

    size() { return pairs.size; },
  };
}
