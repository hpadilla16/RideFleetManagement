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
export function summarizeOpenRequests(rows, now = Date.now(), vehicleById = {}) {
  const byLocation = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const locId = String(r?.locationId || '');
    if (!locId) continue;
    if (!byLocation.has(locId)) byLocation.set(locId, []);
    byLocation.get(locId).push(r);
  }
  // Phase 3: "Van 2 · IKT-482" beside the waiting name. Resolved from the
  // caller's ALREADY tenant-verified vehicle map — an id the map does not
  // know (stale, foreign) renders as null, never a lookup here.
  const assignedOut = (r) => {
    const v = r?.assignedVehicleId ? vehicleById[r.assignedVehicleId] : null;
    return v ? { vehicleId: String(v.id || r.assignedVehicleId), label: vehicleLabel(v), plate: String(v.plate || '').trim() || null } : null;
  };
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
          bags: num(oldest.bags),
          pickupNote: String(oldest.pickupNote || '').trim() || null,
          waitingMinutes: Number.isFinite(createdAt) ? Math.max(0, Math.round((now - createdAt) / 60000)) : null,
          assignedVehicle: assignedOut(oldest),
        }
        : null,
      // "then: M. Rivera ×1 · K. Osei ×2" — names only, capped so one busy
      // sede cannot balloon the payload.
      next: list.slice(1, 4).map((r) => ({
        customerName: String(r.customerName || '').trim() || 'Customer',
        partySize: num(r.partySize) || 1,
        assignedVehicle: assignedOut(r),
      })),
    };
  }
  return out;
}

// ─── Alert feed detail (2026-08-26) ─────────────────────────────────────────

/**
 * Which request does this alert row talk about?
 *
 * Two honest sources, both already written by the no-show fan-out: the
 * rawJson's own `requestId`, and the deterministic `noshow:<requestId>`
 * providerRef that makes the row idempotent. Never a guess — anything else
 * yields null and the caller resolves no detail at all.
 */
export function alertRequestId(row) {
  const fromRaw = String(parseAlertRaw(row?.rawJson)?.requestId || '').trim();
  if (fromRaw) return fromRaw;
  const ref = String(row?.providerRef || '').trim();
  return ref.startsWith('noshow:') ? ref.slice('noshow:'.length) || null : null;
}

/** rawJson is a stored blob — a broken one is never a reason to fail a feed. */
function parseAlertRaw(rawJson) {
  if (!rawJson) return null;
  if (typeof rawJson === 'object') return rawJson;
  try {
    const parsed = JSON.parse(rawJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/**
 * The no-show detail line the staff feed renders — "Juan P. (2 pax, 3 maletas)
 * — marcado por el conductor", plus a [Contactar cliente] tel: action.
 *
 * FIELD-PICKED, never the raw blob: rawJson is written by several code paths
 * and one added key there must not become a new response field here. The
 * PHONE is deliberate and does NOT come from rawJson (which must stay
 * PII-light) — the caller resolves it from the ShuttleRequest row under the
 * caller's OWN tenant+location scope. This is a staff-authed endpoint
 * (requireAuth + module access), the same surface that already shows the
 * customer's name and shared coordinates, so a callback number is in scope;
 * it is still picked one field at a time.
 *
 * @param {object} row ShuttleAlert row
 * @param {string|null} [customerPhone] resolved by the caller, scope-checked
 * @returns {object|null} null when the row carries no no-show payload at all
 */
export function alertDetail(row, customerPhone = null) {
  const raw = parseAlertRaw(row?.rawJson);
  const requestId = alertRequestId(row);
  const name = String(raw?.customerName || '').trim() || null;
  const partySize = num(raw?.partySize);
  const bags = num(raw?.bags);
  const markedBy = String(raw?.markedBy || '').trim().slice(0, 40) || null;
  const phone = String(customerPhone || '').trim() || null;
  if (!requestId && !name && partySize === null && bags === null && !markedBy) return null;
  return { requestId: requestId || null, customerName: name, partySize, bags, markedBy, customerPhone: phone };
}

/**
 * May a location-scoped caller see this ZONE-LESS alert? (2026-08-26)
 *
 * The feed used to filter on `zoneId ∈ scoped zones`, which silently hid every
 * REQUEST_NO_SHOW / DRIVER_ISSUE without a zone from exactly the staff who
 * work that sede. Resolution, most authoritative first, and FAIL-CLOSED at
 * every step — an alert we cannot tie to an allowed location stays hidden:
 *   1. the alert's request (its locationId is the truth) — the caller passes
 *      the request only when it survived their own scopeWhere;
 *   2. otherwise the alert's vehicle, when that vehicle is configured as a
 *      shuttle at one of the caller's allowed locations;
 *   3. otherwise: not visible.
 *
 * @param {object} row ShuttleAlert row (zoneId null)
 * @param {object|null} scopedRequest the request row, already scope-filtered
 * @param {Set<string>} allowedVehicleIds vehicles configured at allowed sedes
 * @param {boolean} hasRequestRef did the row name a request at all?
 */
export function zoneLessAlertVisible({ row, scopedRequest = null, allowedVehicleIds = new Set(), hasRequestRef = false }) {
  if (hasRequestRef) return !!scopedRequest;
  const vehicleId = row?.vehicleId ? String(row.vehicleId) : '';
  return !!vehicleId && allowedVehicleIds.has(vehicleId);
}

/**
 * One waiting-customer entry for the STAFF monitor (Phase 3, Screen 10).
 * This is the ONE place the customer's shared coordinates leave the server —
 * behind requireAuth, from Redis, never persisted. Built by PICKING, same
 * rule as every payload here: name/party/bags/spot + the ephemeral fix.
 * Not sharing = same card, `sharing: false`, no lat/lng keys at all —
 * sharing is never required to be picked up.
 *
 * @param {object} args.request open ShuttleRequest row
 * @param {{lat,lng,at}|null} args.fix parseStoredFix output (null = not sharing)
 * @param {object|null} args.assignedVehicle vehicle row from the tenant-verified map
 * @param {string|null} [args.spotName] the pickupSpotZoneId's resolved zone name
 *   (2026-08-26): the id alone was useless to non-admin staff because
 *   /api/shuttle-zones is ADMIN-gated. One extra picked string, nothing else
 *   from the zone row.
 * @param {number} [args.now]
 */
export function waitingCustomerPayload({ request, fix, assignedVehicle = null, spotName = null, now = Date.now() }) {
  const createdAt = request?.createdAt ? new Date(request.createdAt).getTime() : NaN;
  return {
    requestId: String(request?.id || ''),
    locationId: String(request?.locationId || ''),
    name: String(request?.customerName || '').trim() || 'Customer',
    partySize: num(request?.partySize) || 1,
    bags: num(request?.bags),
    pickupSpotZoneId: request?.pickupSpotZoneId || null,
    pickupSpotName: String(spotName || '').trim() || null,
    waitingMinutes: Number.isFinite(createdAt) ? Math.max(0, Math.round((now - createdAt) / 60000)) : null,
    assignedVehicle: assignedVehicle
      ? { vehicleId: String(assignedVehicle.id || ''), label: vehicleLabel(assignedVehicle), plate: String(assignedVehicle.plate || '').trim() || null }
      : null,
    sharing: !!fix,
    ...(fix
      ? {
        lat: num(fix.lat),
        lng: num(fix.lng),
        ageSeconds: Number.isFinite(Number(fix.at)) ? Math.max(0, Math.round((now - Number(fix.at)) / 1000)) : null,
      }
      : {}),
  };
}
