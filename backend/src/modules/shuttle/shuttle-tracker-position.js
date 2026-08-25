/**
 * Shuttle tracker — the pure decisions.
 *
 * Everything here is testable without Redis, Prisma or a GPS provider: what a
 * public payload may contain, when a position is too old to show, and whether
 * a link is still good. The service owns IO; this file owns the rules.
 *
 * THE RULE THAT MATTERS MOST: the public payload is built by PICKING fields,
 * never by spreading a record. A spread is one added column away from leaking
 * a plate or a customer name onto an unauthenticated page — the whitelist
 * fails closed instead.
 */

/** Older than this and we say OFFLINE rather than show a lying dot. */
export const POSITION_STALE_MS = 4 * 60 * 1000;
/** Older than this and the page shows "last known position" in amber. */
export const POSITION_AGING_MS = 90 * 1000;

/** Redis key naming, in one place so the worker and the API cannot drift. */
export const watchKey = (tenantId) => `shuttle:watch:${tenantId}`;
export const posKey = (vehicleId) => `shuttle:pos:${vehicleId}`;
/** Seconds a watch signal lives — the public page re-arms it on every poll. */
export const WATCH_TTL_S = 90;

/** Is this link usable right now? */
export function linkState(link, now = Date.now()) {
  if (!link) return 'NOT_FOUND';
  if (link.revokedAt) return 'REVOKED';
  const exp = link.expiresAt instanceof Date ? link.expiresAt.getTime() : new Date(link.expiresAt).getTime();
  if (!Number.isFinite(exp) || exp < now) return 'EXPIRED';
  return 'ACTIVE';
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The only request states the public page may learn about. CANCELLED and
 *  NO_SHOW deliberately collapse to null — the curb page shows progress, not
 *  the counter's bookkeeping. */
const PUBLIC_REQUEST_STATUSES = ['READY', 'VIEWED', 'COMPLETED'];

/**
 * The public payload — the ONLY shape the unauthenticated endpoint returns.
 *
 * DELIBERATE WHITELIST EXPANSION (2026-08-24, approved tracker polish,
 * mockup Screen 3). Exactly these crossed the public boundary, each picked
 * field-by-field, nothing else:
 *   • vehicle { name, color, plate }  (NEW #3 — "look for the white Ford
 *     Transit · IKT-482"; shuttle-configured vehicles only, by construction)
 *   • counterPhone                    (NEW #5 — the tel: fallback button)
 *   • brandName                       (NEW #1 — tenant brand header; the
 *     cascade never yields the platform's name)
 *   • requestStatus                   (NEW #2 — READY|VIEWED|COMPLETED|null,
 *     the existing state machine, no ETA invented)
 *   • walkingDirections               (NEW #4 — sede-written static text)
 *
 * DELIBERATE WHITELIST EXPANSION (2026-08-24, Phase 2 — approved #21, mockup
 * Screen 16). Exactly two more keys crossed, both booleans/short strings:
 *   • arrivedAtSpot                   (true only while a fresh provider ENTER
 *     on a pickup-spot zone stands un-exited — see arrivalState)
 *   • arrivedSpotName                 (the zone's staff-given name, e.g.
 *     "Pickup Lot B"; null unless arrived)
 * No coordinates, no zone geometry, no alert history cross here — the page
 * learns "it is at your spot", nothing about how we know.
 *
 * DELIBERATE WHITELIST EXPANSION (2026-08-25, Phase 3 core — approved mockup
 * Screens 8a/8b/9). Exactly three more keys crossed:
 *   • assigned                        (true only when the viewer's OPEN
 *     request carries an assignedVehicleId the config still owns — then the
 *     single-position keys show THAT van, not the freshest)
 *   • shuttles                        (NON_STOP only — every configured
 *     shuttle's fix, each entry built by publicShuttleEntry's own pick;
 *     Screen 8b "the loop", no ids, no ETA)
 *   • locationSharing                 ({ active, distanceMeters } — the
 *     viewer's OWN sharing state. distance only, NEVER an echo of their
 *     coordinates; see shuttle-customer-location.js)
 * Anything further needs its own review — do not spread, keep picking.
 *
 * @param {object} args
 * @param {{latitude,longitude,heading,speedMph,eventAt}|null} args.position latest fix
 * @param {{mode,headwayMinutes}} args.config
 * @param {{name,latitude,longitude}|null} args.location
 * @param {string} [args.pickupInstructions]
 * @param {string} [args.walkingDirections]
 * @param {string|null} [args.brandName]
 * @param {string|null} [args.counterPhone]
 * @param {{make,model,color,plate}|null} [args.vehicle]
 * @param {string|null} [args.requestStatus]
 * @param {number} [args.now]
 */
export function publicPositionPayload({
  position, config, location, pickupInstructions = '',
  walkingDirections = '', brandName = null, counterPhone = null,
  vehicle = null, requestStatus = null,
  arrivedAtSpot = false, arrivedSpotName = null,
  assigned = false, shuttles = null, locationSharing = null,
  intake = null, pickupSpot = null,
  now = Date.now(),
}) {
  // The pickup POINT (where to stand) is the location's own coordinates —
  // already public knowledge (it's the rental counter's address), and it lets
  // the page draw "you are here → wait there". Absent coordinates simply omit
  // the key; the page degrades to text instructions.
  const pickupLat = num(location?.latitude);
  const pickupLng = num(location?.longitude);

  // NEW #3 — vehicle identity, PICKED field-by-field. The name is make+model
  // only: year/VIN/internalNumber stay staff-side. All-empty rows (a vehicle
  // record with no make/model/color/plate) simply omit the key.
  const vehicleName = [vehicle?.make, vehicle?.model].map((p) => String(p || '').trim()).filter(Boolean).join(' ') || null;
  const vehicleColor = String(vehicle?.color || '').trim() || null;
  const vehiclePlate = String(vehicle?.plate || '').trim() || null;
  const vehicleOut = (vehicleName || vehicleColor || vehiclePlate)
    ? { name: vehicleName, color: vehicleColor, plate: vehiclePlate }
    : null;

  const status = String(requestStatus || '').toUpperCase();
  const base = {
    mode: config?.mode === 'NON_STOP' ? 'NON_STOP' : 'ON_DEMAND',
    headwayMinutes: num(config?.headwayMinutes) || null,
    locationName: location?.name || null,
    pickupInstructions: String(pickupInstructions || ''),
    // ── deliberate whitelist additions (2026-08-24) — see header comment ──
    walkingDirections: String(walkingDirections || ''),
    brandName: String(brandName || '').trim() || null,
    counterPhone: String(counterPhone || '').trim() || null,
    requestStatus: PUBLIC_REQUEST_STATUSES.includes(status) ? status : null,
    ...(vehicleOut ? { vehicle: vehicleOut } : {}),
    // ── Phase 2 arrival (2026-08-24, approved #21) — see header comment ──
    arrivedAtSpot: arrivedAtSpot === true,
    arrivedSpotName: arrivedAtSpot === true ? (String(arrivedSpotName || '').trim() || null) : null,
    // ── Phase 3 core (2026-08-25, Screens 8a/8b/9) — see header comment ──
    assigned: assigned === true,
    // Intake config for the request flow (Phase 3 fix): without this the page
    // cannot know a sede enabled intake, and its legacy one-tap POST would 400.
    // Field-picked; caps are plain numbers, nothing else from intakeJson crosses.
    intake: {
      enabled: intake?.enabled === true,
      partySizeCap: num(intake?.partySizeCap),
      bagsCap: num(intake?.bagsCap),
    },
    // The designated pickup spot, exposed ONLY when the location has exactly
    // one active spot (no ambiguity to resolve without the customer's position).
    // Field-picked: zone id + name + its walking text; geometry never crosses.
    pickupSpot: pickupSpot
      ? {
          zoneId: String(pickupSpot.id || pickupSpot.zoneId || ''),
          name: String(pickupSpot.name || ''),
          walkingDirections: String(pickupSpot.walkingDirections || ''),
        }
      : null,
    locationSharing: {
      active: locationSharing?.active === true,
      distanceMeters: locationSharing?.active === true ? num(locationSharing?.distanceMeters) : null,
    },
    // NON_STOP only, and only entries publicShuttleEntry itself built — the
    // caller cannot smuggle a raw row through the array.
    ...(config?.mode === 'NON_STOP' && Array.isArray(shuttles)
      ? { shuttles: shuttles.filter((s) => s && s[SHUTTLE_ENTRY_MARK] === true).map(({ [SHUTTLE_ENTRY_MARK]: _m, ...rest }) => rest) }
      : {}),
    // ─────────────────────────────────────────────────────────────────────
    ...(pickupLat !== null && pickupLng !== null
      ? { pickup: { latitude: pickupLat, longitude: pickupLng } }
      : {}),
  };

  const at = position?.eventAt instanceof Date
    ? position.eventAt.getTime()
    : position?.eventAt ? new Date(position.eventAt).getTime() : NaN;
  const lat = num(position?.latitude);
  const lng = num(position?.longitude);

  // No fix, an unparseable one, or one old enough to mislead: OFFLINE, with
  // no coordinates at all. A 40-minute-old dot presented as live is the one
  // way this feature actively harms trust — the customer walks to where the
  // shuttle no longer is.
  if (lat === null || lng === null || !Number.isFinite(at) || now - at > POSITION_STALE_MS) {
    return { ...base, status: 'OFFLINE' };
  }

  return {
    ...base,
    status: now - at > POSITION_AGING_MS ? 'AGING' : 'LIVE',
    position: {
      latitude: lat,
      longitude: lng,
      heading: num(position.heading),
      speedMph: num(position.speedMph),
      asOf: new Date(at).toISOString(),
      ageSeconds: Math.max(0, Math.round((now - at) / 1000)),
    },
  };
}

/** Proof-of-construction mark: only entries publicShuttleEntry built may
 *  enter the public `shuttles` array. A Symbol, so it can never serialize. */
export const SHUTTLE_ENTRY_MARK = Symbol('publicShuttleEntry');

/**
 * ONE public loop-shuttle entry (Screen 8b) — picked field-by-field, same
 * rule as the main payload. No vehicle id (the loop page has no per-vehicle
 * action), no VIN/year/internalNumber, and OFFLINE entries carry NO
 * coordinates — a dead dot on the loop map lies exactly like the single one.
 *
 * @param {{make,model,color,plate}|null} vehicle owned Vehicle row
 * @param {{latitude,longitude,heading,speedMph,eventAt}|null} position
 */
export function publicShuttleEntry({ vehicle, position, now = Date.now() }) {
  const name = [vehicle?.make, vehicle?.model].map((p) => String(p || '').trim()).filter(Boolean).join(' ') || null;
  const base = {
    [SHUTTLE_ENTRY_MARK]: true,
    name,
    color: String(vehicle?.color || '').trim() || null,
    plate: String(vehicle?.plate || '').trim() || null,
  };

  const at = position?.eventAt instanceof Date
    ? position.eventAt.getTime()
    : position?.eventAt ? new Date(position.eventAt).getTime() : NaN;
  const lat = num(position?.latitude);
  const lng = num(position?.longitude);
  if (lat === null || lng === null || !Number.isFinite(at) || now - at > POSITION_STALE_MS) {
    return { ...base, status: 'OFFLINE' };
  }
  return {
    ...base,
    status: now - at > POSITION_AGING_MS ? 'AGING' : 'LIVE',
    position: {
      latitude: lat,
      longitude: lng,
      heading: num(position.heading),
      speedMph: num(position.speedMph),
      asOf: new Date(at).toISOString(),
      ageSeconds: Math.max(0, Math.round((now - at) / 1000)),
    },
  };
}

/** Vehicle ids a config exposes — tolerant of the Json column's shapes. */
export function configVehicleIds(config) {
  const raw = config?.vehicleIdsJson;
  const list = Array.isArray(raw) ? raw : [];
  return list.map((v) => String(v || '').trim()).filter(Boolean);
}
