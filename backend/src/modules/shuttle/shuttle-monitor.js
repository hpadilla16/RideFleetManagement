/**
 * Staff Shuttle Monitor — the pure decisions (2026-08-24, approved mockup
 * Screen 1).
 *
 * Same split as shuttle-tracker-position.js: this file owns the rules
 * (freshness classification, what a monitor card may contain, how the open
 * queue is summarized) and is testable without Redis or Prisma. The service
 * owns IO.
 *
 * FRESHNESS REUSES THE PUBLIC THRESHOLDS — the staff map and the customer
 * page must never disagree about whether a shuttle is "live": both read
 * POSITION_AGING_MS (90s) and POSITION_STALE_MS (4min) from the same place.
 */
import { POSITION_AGING_MS, POSITION_STALE_MS } from './shuttle-tracker-position.js';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Classify one fix. NO_DEVICE is decided by the caller (it depends on the
 * device mapping, not the fix); this only grades what a fix says.
 *
 * @returns {{status:'LIVE'|'AGING'|'OFFLINE', ageSeconds:number|null, asOf:string|null}}
 */
export function positionFreshness(position, now = Date.now()) {
  const at = position?.eventAt instanceof Date
    ? position.eventAt.getTime()
    : position?.eventAt ? new Date(position.eventAt).getTime() : NaN;
  const lat = num(position?.latitude);
  const lng = num(position?.longitude);
  if (lat === null || lng === null || !Number.isFinite(at) || now - at > POSITION_STALE_MS) {
    return { status: 'OFFLINE', ageSeconds: null, asOf: null };
  }
  return {
    status: now - at > POSITION_AGING_MS ? 'AGING' : 'LIVE',
    ageSeconds: Math.max(0, Math.round((now - at) / 1000)),
    asOf: new Date(at).toISOString(),
  };
}

/** "2023 Ford Transit 350" — the staff-facing display name for a unit. */
export function vehicleLabel(vehicle) {
  const parts = [vehicle?.year, vehicle?.make, vehicle?.model].map((p) => String(p || '').trim()).filter(Boolean);
  return parts.join(' ') || String(vehicle?.internalNumber || '').trim() || 'Shuttle';
}

/**
 * One side-panel card. Built by PICKING fields, same rule as the public
 * payload — this is a staff endpoint so plate/name are fine, but a spread
 * would still ship whatever column lands on Vehicle next.
 *
 * @param {object} args
 * @param {object} args.vehicle   Vehicle row (id, year, make, model, color, plate, internalNumber)
 * @param {boolean} args.hasDevice an active VehicleTelematicsDevice exists
 * @param {object|null} args.position latest fix {latitude,longitude,heading,speedMph,eventAt}
 * @param {object} args.config    ShuttleTrackerConfig row
 * @param {object|null} args.location {id,name}
 * @param {number} [args.now]
 */
export function monitorShuttlePayload({ vehicle, hasDevice, position, config, location, now = Date.now() }) {
  const fresh = hasDevice ? positionFreshness(position, now) : { status: 'NO_DEVICE', ageSeconds: null, asOf: null };
  const lat = num(position?.latitude);
  const lng = num(position?.longitude);
  const showPosition = hasDevice && fresh.status !== 'OFFLINE' && fresh.status !== 'NO_DEVICE' && lat !== null && lng !== null;
  return {
    vehicleId: String(vehicle?.id || ''),
    label: vehicleLabel(vehicle),
    plate: String(vehicle?.plate || '').trim() || null,
    color: String(vehicle?.color || '').trim() || null,
    locationId: location?.id || config?.locationId || null,
    locationName: location?.name || null,
    mode: config?.mode === 'NON_STOP' ? 'NON_STOP' : 'ON_DEMAND',
    headwayMinutes: num(config?.headwayMinutes),
    status: fresh.status, // LIVE | AGING | OFFLINE | NO_DEVICE
    ageSeconds: fresh.ageSeconds,
    asOf: fresh.asOf,
    ...(showPosition
      ? {
        position: {
          latitude: lat,
          longitude: lng,
          heading: num(position?.heading),
          speedMph: num(position?.speedMph),
        },
      }
      : {}),
  };
}

/**
 * The per-location open-queue summary for the side panel. Requests are
 * queued per LOCATION, not dispatched per bus (mockup honesty note) — so the
 * card shows the queue of the location the shuttle serves.
 *
 * @param {Array} rows open ShuttleRequest rows, oldest first (buildListQuery
 *   order for the live queue)
 */
export function summarizeOpenRequests(rows, now = Date.now()) {
  const byLocation = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const locId = String(r?.locationId || '');
    if (!locId) continue;
    if (!byLocation.has(locId)) byLocation.set(locId, []);
    byLocation.get(locId).push(r);
  }
  const out = {};
  for (const [locId, list] of byLocation) {
    const oldest = list[0];
    const createdAt = oldest?.createdAt ? new Date(oldest.createdAt).getTime() : NaN;
    out[locId] = {
      openCount: list.length,
      oldest: oldest
        ? {
          customerName: String(oldest.customerName || '').trim() || 'Customer',
          partySize: num(oldest.partySize) || 1,
          pickupNote: String(oldest.pickupNote || '').trim() || null,
          waitingMinutes: Number.isFinite(createdAt) ? Math.max(0, Math.round((now - createdAt) / 60000)) : null,
        }
        : null,
      // "then: M. Rivera ×1 · K. Osei ×2" — names only, capped so one busy
      // sede cannot balloon the payload.
      next: list.slice(1, 4).map((r) => ({
        customerName: String(r.customerName || '').trim() || 'Customer',
        partySize: num(r.partySize) || 1,
      })),
    };
  }
  return out;
}
