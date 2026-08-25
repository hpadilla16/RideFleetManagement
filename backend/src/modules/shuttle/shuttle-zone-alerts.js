/**
 * Shuttle zones + alerts — the pure decisions (Phase 2, 2026-08-24; approved
 * mockup Screens 4/5/16). No Prisma, no fetch, no Redis: everything here is
 * testable in the DB-free chain. IO lives in shuttle-zones.service.js and
 * shuttle-alerts.scheduler.js.
 *
 * DEFENSIVE BY CONTRACT: the provider's alert shape is ASSUMED (the apidoc is
 * auth-gated — see the section header in telematics-onestepgps.js), so
 * normalizeProviderAlert accepts several field spellings, maps types by
 * keyword, and answers { skipped, reason } for anything it does not
 * recognize. A skipped entry is a warn in the scheduler, never a crash and
 * never an invented alert.
 */
import crypto from 'crypto';

export const ZONE_KINDS = ['ZONE', 'ROUTE'];
export const ALERT_TYPES = ['ENTER', 'EXIT', 'OFF_ROUTE'];

/** ROUTE corridor tolerance bounds (meters). */
export const ROUTE_TOLERANCE_DEFAULT_M = 300;
export const ROUTE_TOLERANCE_MIN_M = 50;
export const ROUTE_TOLERANCE_MAX_M = 5000;

/** How long an ENTER keeps saying "your shuttle is at the spot" (Screen 16).
 *  After this, with no fresher signal, the banner drops rather than lie. */
export const ARRIVAL_FRESH_MS = 10 * 60 * 1000;

// ─── Zone input validation ──────────────────────────────────────────────────

const isFiniteNum = (v) => Number.isFinite(Number(v));
const validLat = (v) => isFiniteNum(v) && Math.abs(Number(v)) <= 90;
const validLng = (v) => isFiniteNum(v) && Math.abs(Number(v)) <= 180;

/**
 * Validate + normalize a zone create/update body. Returns
 * { ok: true, zone } with a clean record, or { ok: false, error }.
 * Geometry: ZONE needs >= 3 points (a polygon; rectangles arrive as their 4
 * corners), ROUTE needs >= 2 (a polyline). Every point must be a real
 * coordinate — one NaN and the whole save is refused, because a half-valid
 * polygon synced to the provider detects nothing while looking configured.
 */
export function validateZoneInput(body = {}) {
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > 80) return { ok: false, error: 'name must be 80 characters or fewer' };

  const kind = String(body.kind || 'ZONE').toUpperCase();
  if (!ZONE_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${ZONE_KINDS.join(', ')}` };

  const rawPoints = Array.isArray(body.geometry?.points) ? body.geometry.points
    : Array.isArray(body.points) ? body.points : [];
  const points = [];
  for (const p of rawPoints) {
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (!validLat(lat) || !validLng(lng)) return { ok: false, error: 'every point needs a valid lat and lng' };
    points.push({ lat, lng });
  }
  const minPoints = kind === 'ROUTE' ? 2 : 3;
  if (points.length < minPoints) {
    return { ok: false, error: `${kind} geometry needs at least ${minPoints} points` };
  }
  if (points.length > 200) return { ok: false, error: 'geometry is limited to 200 points' };

  let toleranceM = null;
  if (kind === 'ROUTE') {
    toleranceM = body.toleranceM == null ? ROUTE_TOLERANCE_DEFAULT_M : Number(body.toleranceM);
    if (!Number.isFinite(toleranceM) || toleranceM < ROUTE_TOLERANCE_MIN_M || toleranceM > ROUTE_TOLERANCE_MAX_M) {
      return { ok: false, error: `toleranceM must be between ${ROUTE_TOLERANCE_MIN_M} and ${ROUTE_TOLERANCE_MAX_M} meters` };
    }
    toleranceM = Math.round(toleranceM);
  }

  return {
    ok: true,
    zone: {
      name,
      kind,
      isPickupSpot: kind === 'ZONE' && body.isPickupSpot === true,
      walkingDirections: String(body.walkingDirections || '').trim().slice(0, 500) || null,
      geometryJson: { type: kind === 'ROUTE' ? 'polyline' : (String(body.geometry?.type || 'polygon').toLowerCase() === 'rectangle' ? 'rectangle' : 'polygon'), points },
      toleranceM,
      notifyOnEnter: kind === 'ZONE' && body.notifyOnEnter === true,
      notifyOnExit: kind === 'ZONE' && body.notifyOnExit === true,
      notifyOnOffRoute: kind === 'ROUTE' && body.notifyOnOffRoute === true,
      active: body.active !== false,
    },
  };
}

// ─── Staff alert recipients ─────────────────────────────────────────────────

/**
 * Parse the per-location recipients list (ShuttleTrackerConfig.
 * alertRecipientsJson) into a clean array. Tolerant of the Json column's
 * shapes; entries with no reachable channel are dropped. The SAME function
 * validates staff input (PUT /recipients) and reads at fan-out time, so the
 * two can never drift.
 */
export function parseAlertRecipients(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const r of list.slice(0, 20)) {
    if (!r || typeof r !== 'object') continue;
    const email = String(r.email || '').trim().toLowerCase();
    const phone = String(r.phone || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const channels = Array.isArray(r.channels)
      ? [...new Set(r.channels.map((c) => String(c || '').toUpperCase()).filter((c) => c === 'EMAIL' || c === 'SMS'))]
      : [];
    const wantsEmail = channels.includes('EMAIL') && !!email;
    const wantsSms = channels.includes('SMS') && !!phone;
    if (!wantsEmail && !wantsSms) continue;
    out.push({
      name: String(r.name || '').trim().slice(0, 80) || null,
      email: email || null,
      phone: phone.slice(0, 32) || null,
      channels: [...(wantsEmail ? ['EMAIL'] : []), ...(wantsSms ? ['SMS'] : [])],
    });
  }
  return out;
}

// ─── Provider alert normalization ───────────────────────────────────────────

const pickFirst = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
};

/** Keyword type mapping — tolerant of enter/entry/arrive, exit/leave/depart,
 *  and anything route-flavored. Unknown → null (caller skips with a warn). */
export function mapAlertType(rawType) {
  const t = String(rawType || '').toLowerCase();
  if (!t) return null;
  if (/route/.test(t)) return 'OFF_ROUTE';
  if (/enter|entry|arriv|geofence[_ -]?in\b|zone[_ -]?in\b/.test(t)) return 'ENTER';
  if (/exit|leave|left|depart|geofence[_ -]?out\b|zone[_ -]?out\b/.test(t)) return 'EXIT';
  return null;
}

/** Stable fallback ref when the provider entry has no id of its own. */
export function alertDedupeRef({ deviceId, zoneRef, type, atIso }) {
  const h = crypto.createHash('sha256')
    .update([deviceId || '', zoneRef || '', type || '', atIso || ''].join('|'))
    .digest('hex')
    .slice(0, 32);
  return `derived:${h}`;
}

/**
 * One raw provider alert entry → our normalized row, or a skip verdict.
 *
 * @param {object} raw provider entry (shape assumed — several spellings tried)
 * @param {object} ctx
 * @param {Map<string,{id:string}>} ctx.zoneByProviderId providerZoneId → our zone
 * @param {Map<string,string>} ctx.vehicleByExternalId device_id → vehicleId
 * @param {number} [ctx.now]
 * @returns {{ok:true, alert:object} | {ok:false, reason:string}}
 */
export function normalizeProviderAlert(raw, { zoneByProviderId, vehicleByExternalId, now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };

  const type = mapAlertType(pickFirst(raw, ['alert_type', 'type', 'event_type', 'alert_name', 'name']));
  if (!type) return { ok: false, reason: 'unrecognized alert type' };

  const atRaw = pickFirst(raw, ['dt_alert', 'occurred_at', 'dt_tracker', 'dt_server', 'created_at', 'timestamp']);
  const occurredAt = atRaw ? new Date(atRaw) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) return { ok: false, reason: 'no parseable timestamp' };
  // A "future" alert beyond small clock skew is provider garbage, not news.
  if (occurredAt.getTime() > now + 5 * 60 * 1000) return { ok: false, reason: 'timestamp in the future' };

  const zoneRef = pickFirst(raw, ['zone_id', 'zoneId']) ?? pickFirst(raw.zone || {}, ['zone_id', 'id', '_id']);
  const deviceId = pickFirst(raw, ['device_id', 'deviceId']) ?? pickFirst(raw.device || {}, ['device_id', 'id']);

  const zone = zoneRef != null ? zoneByProviderId?.get(String(zoneRef)) || null : null;
  // OFF_ROUTE may legitimately reference a route or nothing; ENTER/EXIT with
  // a zone we do not know is recorded zone-less (feed-only, no fan-out).
  const vehicleId = deviceId != null ? vehicleByExternalId?.get(String(deviceId)) || null : null;

  const providerRefRaw = pickFirst(raw, ['alert_id', 'device_alert_id', 'id', '_id', 'uuid']);
  const providerRef = providerRefRaw != null
    ? String(providerRefRaw)
    : alertDedupeRef({
      deviceId: deviceId != null ? String(deviceId) : '',
      zoneRef: zoneRef != null ? String(zoneRef) : '',
      type,
      atIso: occurredAt.toISOString(),
    });

  return {
    ok: true,
    alert: {
      type,
      occurredAt,
      providerRef,
      zoneId: zone?.id || null,
      vehicleId,
      rawJson: safeRawJson(raw),
    },
  };
}

/** Raw entry preserved for triage — bounded so one chatty entry cannot bloat
 *  the table. Never contains our API key (it never enters the entry). */
function safeRawJson(raw) {
  try { return JSON.stringify(raw).slice(0, 2000); } catch { return null; }
}

// ─── Arrival state (the public tracker's banner, Screen 16) ─────────────────

/**
 * Given recent pickup-spot alerts for a location (newest first, ENTER/EXIT
 * only), decide whether the page may say "your shuttle has arrived".
 * The latest event wins: an ENTER within the freshness window with no later
 * EXIT for the same zone+vehicle = arrived. Anything else = not arrived —
 * a stale "it's here" is worse than none (same trust rule as OFFLINE).
 *
 * @param {Array<{type, zoneId, vehicleId, occurredAt}>} alerts newest first
 * @param {Map<string,{name:string}>} zoneById
 */
export function arrivalState(alerts = [], zoneById = new Map(), now = Date.now()) {
  for (const a of alerts) {
    const at = a?.occurredAt instanceof Date ? a.occurredAt.getTime() : new Date(a?.occurredAt || 0).getTime();
    if (!Number.isFinite(at) || now - at > ARRIVAL_FRESH_MS) break; // sorted: rest are older
    if (a.type === 'EXIT') {
      // The newest fresh event for this zone+vehicle is a departure — any
      // older ENTER for the same pair is history, so stop considering it.
      return { arrivedAtSpot: false, spotName: null };
    }
    if (a.type === 'ENTER') {
      const zone = a.zoneId ? zoneById.get(a.zoneId) : null;
      return {
        arrivedAtSpot: true,
        spotName: zone?.name || null,
        spotWalkingDirections: zone?.walkingDirections || null,
        arrivedZoneId: a.zoneId || null,
      };
    }
  }
  return { arrivedAtSpot: false, spotName: null };
}

// ─── Message builders ───────────────────────────────────────────────────────

const TYPE_LABEL = {
  ENTER: 'entered',
  EXIT: 'exited',
  OFF_ROUTE: 'left the route corridor',
};

/** Staff notification copy (email subject/text + one-segment SMS). */
export function buildStaffAlertMessages({ type, zoneName, vehicleLabel, locationName, occurredAt }) {
  const what = TYPE_LABEL[type] || String(type || '').toLowerCase();
  const who = vehicleLabel || 'Shuttle';
  const where = zoneName ? ` ${zoneName}` : '';
  const at = occurredAt instanceof Date ? occurredAt : new Date(occurredAt || Date.now());
  const hhmm = at.toISOString().slice(11, 16);
  const sede = locationName ? ` — ${locationName}` : '';
  const line = `${who} ${what}${where} at ${hhmm} UTC${sede}`;
  return {
    subject: `Shuttle alert: ${who} ${what}${where}${sede}`,
    text: `${line}\n\nThis is an automated geofence alert from the shuttle monitor. Timestamps are the GPS provider's event time.`,
    smsBody: `Shuttle alert: ${line}`,
  };
}

/**
 * Customer arrival SMS (Screen 16). Bilingual like the link invite; repeats
 * nothing sensitive — spot name, walking text, and the already-public vehicle
 * identity only.
 */
export function buildArrivalSms({ spotName, walkingDirections, vehicleName, vehiclePlate, brandName, locale }) {
  const es = String(locale || '').toLowerCase().startsWith('es');
  const who = brandName || 'Ride Fleet';
  const spot = spotName || (es ? 'tu punto de recogida' : 'your pickup spot');
  const van = [vehicleName, vehiclePlate ? `(${vehiclePlate})` : ''].filter(Boolean).join(' ');
  const vanLine = van ? (es ? ` Busca ${van}.` : ` Look for ${van}.`) : '';
  const walk = String(walkingDirections || '').trim();
  const walkLine = walk ? ` ${walk}` : '';
  return es
    ? `${who}: tu shuttle llegó a ${spot}.${vanLine}${walkLine}`
    : `${who}: your shuttle has arrived at ${spot}.${vanLine}${walkLine}`;
}
