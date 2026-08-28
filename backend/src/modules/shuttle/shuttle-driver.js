/**
 * Shuttle driver mode — the pure decisions (Phase 3 driver surface,
 * 2026-08-25; approved mockup Screens 12–15 + 17a). IO lives in
 * shuttle-driver.service.js; this file owns the rules and is testable
 * without Redis, Prisma or crypto entropy assertions beyond shape.
 *
 * THE SURFACE RULE: the driver page is PUBLIC-TOKEN territory, so every
 * payload here is built by PICKING fields, never by spreading a record —
 * same law as shuttle-tracker-position.js. The one deliberate difference
 * from the customer tracker: the roster MAY carry a waiting customer's
 * shared coordinates, because the driver holding a valid shift token is
 * exactly the person those coordinates exist for (same treatment as the
 * staff monitor: Redis-only read, never logged, never persisted).
 */
import crypto from 'node:crypto';
import { positionFreshness } from './shuttle-monitor.js';

/** 192-bit random, base64url — the house public-token mint (same as
 *  ShuttleTrackerLink's crypto.randomBytes(24).toString('base64url')). */
export function mintDriverToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Hard ceiling on a shift link's life. */
export const SHIFT_MAX_HOURS = 24;

/**
 * When does a freshly minted shift expire?
 *  - `hours` given → clamped to [1, 24] hours from now;
 *  - absent → end of the current day (23:59:59.999 server time), which is
 *    always under the 24h ceiling. Staff who need a graveyard shift crossing
 *    midnight pass hours explicitly.
 */
export function shiftExpiry({ hours = null, now = new Date() } = {}) {
  const at = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const h = Number(hours);
  if (Number.isFinite(h) && h > 0) {
    return new Date(at.getTime() + Math.min(SHIFT_MAX_HOURS, Math.max(1, h)) * 60 * 60 * 1000);
  }
  const end = new Date(at.getTime());
  end.setHours(23, 59, 59, 999);
  return end;
}

/** Is this shift usable right now? Mirrors linkState — the route collapses
 *  everything but ACTIVE into the same bare 404. */
export function shiftState(shift, now = Date.now()) {
  if (!shift) return 'NOT_FOUND';
  if (shift.revokedAt) return 'REVOKED';
  const exp = shift.expiresAt instanceof Date ? shift.expiresAt.getTime() : new Date(shift.expiresAt).getTime();
  if (!Number.isFinite(exp) || exp < now) return 'EXPIRED';
  return 'ACTIVE';
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ─── Driver inputs ───────────────────────────────────────────────────────────

/** The approved issue categories (mockup Screen 15), verbatim. */
export const DRIVER_ISSUE_CATEGORIES = ['MECANICO', 'ACCIDENTE', 'TRAFICO', 'CLIENTE_NO_APARECE', 'OTRO'];
export const ISSUE_NOTE_MAX = 500;

/** Validate the public issue POST. The error names the field, never echoes
 *  what was sent, and never mentions the token. */
export function validateIssueInput(body = {}) {
  const category = String(body?.category || '').trim().toUpperCase();
  if (!DRIVER_ISSUE_CATEGORIES.includes(category)) {
    return { ok: false, error: `category must be one of ${DRIVER_ISSUE_CATEGORIES.join(', ')}` };
  }
  const note = String(body?.note || '').trim().slice(0, ISSUE_NOTE_MAX);
  return { ok: true, issue: { category, note: note || null } };
}

export const MESSAGE_MAX = 500;

/** Validate a store→driver message (staff side). */
export function validateDriverMessage(raw) {
  const message = String(raw || '').trim();
  if (!message) return { ok: false, error: 'message is required' };
  if (message.length > MESSAGE_MAX) return { ok: false, error: `message must be at most ${MESSAGE_MAX} characters` };
  return { ok: true, message };
}

export const DRIVER_NAME_MAX = 80;

/** Validate the staff mint input's driver name (free text, no account). */
export function validateDriverName(raw) {
  const driverName = String(raw || '').trim();
  if (!driverName) return { ok: false, error: 'driverName is required' };
  if (driverName.length > DRIVER_NAME_MAX) return { ok: false, error: `driverName must be at most ${DRIVER_NAME_MAX} characters` };
  return { ok: true, driverName };
}

// ─── Driver payloads (public token surface — PICK, never spread) ────────────

/**
 * One zone/pickup-spot entry for the driver map (Screen 13). Geometry crosses
 * HERE deliberately — the driver draws the pickup spots and route corridor —
 * but only the drawing fields: no provider ids, no sync state, no notify
 * flags (those are staff configuration, not driving aids).
 */
export function driverZonePayload(zone) {
  return {
    id: String(zone?.id || ''),
    name: String(zone?.name || ''),
    kind: zone?.kind === 'ROUTE' ? 'ROUTE' : 'ZONE',
    isPickupSpot: zone?.isPickupSpot === true,
    geometry: zone?.geometryJson ?? null,
    toleranceM: num(zone?.toleranceM),
    walkingDirections: String(zone?.walkingDirections || '').trim() || null,
    // Spanish variant (2026-08-25) — the driver UI is ES-primary and prefers
    // this text, falling back to the English one.
    walkingDirectionsEs: String(zone?.walkingDirectionsEs || '').trim() || null,
  };
}

/**
 * One roster entry (Screen 14): a waiting customer the driver may pick up.
 *
 * Coordinates cross ONLY while a fresh shared fix exists (`sharing: true`),
 * same shape as the staff monitor's waitingCustomerPayload — the driver is
 * the person those coordinates exist for. Not sharing = same card, no
 * lat/lng keys at all. Phone numbers deliberately do NOT cross: the driver
 * calls the counter, the counter calls the customer.
 *
 * @param {object} args.request open ShuttleRequest row
 * @param {{lat,lng,at}|null} args.fix parseStoredFix output (null = not sharing)
 * @param {string|null} args.spotName resolved pickup-spot zone name
 * @param {string|null} args.shiftVehicleId the shift's own vehicle (highlight)
 * @param {object|null} args.assignedVehicle tenant-verified vehicle row for the
 *   request's assignedVehicleId (null = unassigned or unresolvable)
 */
export function driverRosterEntry({ request, fix = null, spotName = null, shiftVehicleId = null, assignedVehicle = null, now = Date.now() }) {
  const createdAt = request?.createdAt ? new Date(request.createdAt).getTime() : NaN;
  const assignedName = assignedVehicle
    ? [assignedVehicle.make, assignedVehicle.model].map((p) => String(p || '').trim()).filter(Boolean).join(' ') || null
    : null;
  return {
    id: String(request?.id || ''),
    name: String(request?.customerName || '').trim() || 'Customer',
    partySize: num(request?.partySize) || 1,
    bags: num(request?.bags),
    status: String(request?.status || ''),
    pickupNote: String(request?.pickupNote || '').trim() || null,
    pickupSpot: String(spotName || '').trim() || null,
    waitingMinutes: Number.isFinite(createdAt) ? Math.max(0, Math.round((now - createdAt) / 60000)) : null,
    // Highlight "assigned to THIS van" (ON_DEMAND, Screen 14). Distinct from
    // assignedVehicle so an unassigned roster and a foreign-van assignment
    // read differently on the page.
    assignedToYou: !!shiftVehicleId && request?.assignedVehicleId === shiftVehicleId,
    assignedVehicle: assignedVehicle
      ? { name: assignedName, plate: String(assignedVehicle.plate || '').trim() || null }
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

/**
 * The shift vehicle's OWN latest fix, for Driver Mode's "GPS LIVE · 14s" chip
 * (2026-08-26). Same house read and the SAME 90s/4min thresholds the staff
 * monitor and the customer page use — three surfaces may never disagree about
 * whether a shuttle is live.
 *
 * An OFFLINE fix carries NO coordinates, exactly like every other payload
 * here: a 40-minute-old dot on the driver's own map would send them chasing
 * their own ghost.
 *
 * @returns {{status:'LIVE'|'AGING'|'OFFLINE', ageSeconds:number|null, latitude?:number, longitude?:number}}
 */
export function driverOwnPosition(position, now = Date.now()) {
  const fresh = positionFreshness(position, now);
  const lat = num(position?.latitude);
  const lng = num(position?.longitude);
  const show = fresh.status !== 'OFFLINE' && lat !== null && lng !== null;
  return {
    status: fresh.status,
    ageSeconds: fresh.ageSeconds,
    ...(show ? { latitude: lat, longitude: lng } : {}),
  };
}

/** How far back the driver roster remembers what it just closed. */
export const RECENTLY_CLOSED_MS = 60 * 60 * 1000;
/** And how many rows, so a busy sede cannot balloon the driver payload. */
export const RECENTLY_CLOSED_MAX = 20;

/**
 * One "just handled" roster-history row (2026-08-26). Four picked fields, and
 * deliberately none of the live-roster extras: no phone, no coordinates, no
 * pickup note — the wait is over, the driver only needs to see that it closed
 * and how.
 */
export function driverClosedEntry(request) {
  const closedAt = request?.closedAt ? new Date(request.closedAt) : null;
  return {
    id: String(request?.id || ''),
    name: String(request?.customerName || '').trim() || 'Customer',
    status: String(request?.status || ''),
    closedAt: closedAt && Number.isFinite(closedAt.getTime()) ? closedAt.toISOString() : null,
  };
}
