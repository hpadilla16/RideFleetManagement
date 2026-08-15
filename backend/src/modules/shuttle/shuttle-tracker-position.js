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

/**
 * The public payload — the ONLY shape the unauthenticated endpoint returns.
 *
 * @param {object} args
 * @param {{latitude,longitude,heading,speedMph,eventAt}|null} args.position latest fix
 * @param {{mode,headwayMinutes}} args.config
 * @param {{name}|null} args.location
 * @param {string} [args.pickupInstructions]
 * @param {number} [args.now]
 */
export function publicPositionPayload({ position, config, location, pickupInstructions = '', now = Date.now() }) {
  const base = {
    mode: config?.mode === 'NON_STOP' ? 'NON_STOP' : 'ON_DEMAND',
    headwayMinutes: num(config?.headwayMinutes) || null,
    locationName: location?.name || null,
    pickupInstructions: String(pickupInstructions || ''),
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

/** Vehicle ids a config exposes — tolerant of the Json column's shapes. */
export function configVehicleIds(config) {
  const raw = config?.vehicleIdsJson;
  const list = Array.isArray(raw) ? raw : [];
  return list.map((v) => String(v || '').trim()).filter(Boolean);
}
