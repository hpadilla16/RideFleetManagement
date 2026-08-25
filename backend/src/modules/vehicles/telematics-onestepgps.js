/**
 * OneStepGPS Telematics API Client
 *
 * Pull-based integration against the OneStepGPS public REST API.
 * Contract notes: doc/onestepgps-api-contract-2026-08-24.md (extracted from
 * https://track.onestepgps.com/v3/apidoc/, 2026-08-24 — the API is marked
 * "under development"; rate limits are undocumented, so callers stay
 * conservative: the shuttle fast poll makes ONE bulk call per tenant tick).
 *
 * Auth: a single API key per tenant, sent as `Authorization: Bearer <key>`.
 * The doc also allows an `api-key` QUERY PARAM — never use it: keys in URLs
 * end up in access logs. The key is stored AES-256-GCM encrypted in
 * IntegrationCredential (unique (tenantId, sourceSystem='ONESTEPGPS')), the
 * same lib/integration-crypto storage Economy/Advantage/Flexways use — and
 * deliberately NOT in the telematicsConfig appSetting blob, so no settings
 * save can ever erase it (the pre-2026-08-13 VoltSwitch bug: saving the
 * Settings page silently dropped the connector's credentials).
 *
 * UNITS (the one real trap): OneStepGPS speed is native km/h, unit-tagged as
 * `device_point_detail.speed = { value, unit: "km/h", display }`. Our house
 * storage is VehicleTelematicsEvent.speedMph — speedToMph() converts honoring
 * the unit tag (km/h ×0.621371, mph passthrough, unknown unit → warn once and
 * treat as km/h). The raw top-level `speed` number is ambiguous per the doc
 * and is only used as a km/h fallback when the tagged object is absent.
 *
 * The API key must NEVER appear in logs, thrown errors, or GET responses.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { withTimeout } from '../../lib/with-timeout.js';
import { encrypt, decrypt } from '../../lib/integration-crypto.js';

const BASE_URL = 'https://track.onestepgps.com/v3/api/public/';
export const SOURCE_SYSTEM = 'ONESTEPGPS';
const CALL_TIMEOUT_MS = Math.max(50, parseInt(process.env.ONESTEPGPS_TIMEOUT_MS || String(10 * 1000), 10) || 10 * 1000);
const KMH_TO_MPH = 0.621371;

// The bulk device-info endpoint is opt-in per field via boolean query flags.
const DEVICE_INFO_FLAGS = {
  device_id: 'true',
  display_name: 'true',
  lat_lng: 'true',
  dt_tracker: 'true',
  license_plate: 'true',
  active_state: 'true',
  latest_device_point: 'true',
};

export class OneStepGpsAuthError extends Error {
  constructor(message = 'OneStepGPS API key missing or invalid') {
    super(message);
    this.name = 'OneStepGpsAuthError';
  }
}

/**
 * The provider answered, but not in a shape we recognize (Phase 2 zones/
 * alerts — the apidoc is auth-gated and marked "under development", so the
 * zone/alert contract is ASSUMED, not verified; see the section header
 * below). Callers treat this as "sync stays PENDING / entry skipped with a
 * warn", never as a crash.
 */
export class OneStepGpsShapeError extends Error {
  constructor(message = 'OneStepGPS response shape not recognized') {
    super(message);
    this.name = 'OneStepGpsShapeError';
  }
}

// ─── Test seams (production path unchanged when unset) ───────────────────────

let _prismaOverride = null;
function db() { return _prismaOverride || prisma; }
export function _setPrismaForTests(p) { _prismaOverride = p || null; }

let _fetchOverride = null;
function doFetch(...args) { return (_fetchOverride || fetch)(...args); }
export function _setFetchForTests(fn) { _fetchOverride = fn || null; }

// ─── Credential storage (Postgres-backed, AES-256-GCM) ───────────────────────

export async function setApiKey(tenantId, apiKey, userId = null) {
  if (!tenantId) throw new Error('tenantId required');
  const key = String(apiKey ?? '').trim();
  if (!key) throw new Error('apiKey required');

  const encryptedPayload = encrypt(JSON.stringify({ apiKey: key }));
  const row = await db().integrationCredential.upsert({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
    create: {
      tenantId,
      sourceSystem: SOURCE_SYSTEM,
      encryptedPayload,
      rotatedAt: new Date(),
      rotatedByUserId: userId,
    },
    update: {
      encryptedPayload,
      rotatedAt: new Date(),
      rotatedByUserId: userId,
      // Reset test status — caller should re-test after rotation.
      lastTestedAt: null,
      lastTestStatus: null,
    },
  });
  logger.info('[onestepgps] api key rotated', { tenantId, credentialId: row.id });
  return { id: row.id, rotatedAt: row.rotatedAt };
}

export async function clearApiKey(tenantId) {
  if (!tenantId) throw new Error('tenantId required');
  const out = await db().integrationCredential.deleteMany({
    where: { tenantId, sourceSystem: SOURCE_SYSTEM },
  });
  logger.info('[onestepgps] api key cleared', { tenantId, deleted: out.count });
  return { deleted: out.count };
}

export async function getApiKey(tenantId) {
  if (!tenantId) throw new OneStepGpsAuthError('tenantId required to load OneStepGPS API key');
  const row = await db().integrationCredential.findUnique({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
  });
  if (!row?.encryptedPayload) {
    throw new OneStepGpsAuthError(`No OneStepGPS API key stored for tenant ${tenantId}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(decrypt(row.encryptedPayload));
  } catch (err) {
    throw new OneStepGpsAuthError(
      `Failed to decrypt OneStepGPS API key for tenant ${tenantId}: ${err.message}`
    );
  }
  if (!parsed?.apiKey) throw new OneStepGpsAuthError(`OneStepGPS credential for tenant ${tenantId} has no apiKey`);
  return parsed.apiKey;
}

/** Readiness gate for the shuttle fast poll: key stored → tenant is live. */
export async function hasApiKey(tenantId) {
  if (!tenantId) return false;
  const row = await db().integrationCredential.findUnique({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
    select: { encryptedPayload: true },
  });
  return !!row?.encryptedPayload;
}

/** Panel status. NEVER includes the key — booleans and timestamps only. */
export async function getCredentialStatus(tenantId) {
  if (!tenantId) return { hasApiKey: false };
  const row = await db().integrationCredential.findUnique({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
    select: { encryptedPayload: true, rotatedAt: true, lastTestedAt: true, lastTestStatus: true },
  });
  return {
    hasApiKey: !!row?.encryptedPayload,
    rotatedAt: row?.rotatedAt || null,
    lastTestedAt: row?.lastTestedAt || null,
    lastTestStatus: row?.lastTestStatus || null,
  };
}

async function recordTestStatus(tenantId, status) {
  await db().integrationCredential.update({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
    data: { lastTestedAt: new Date(), lastTestStatus: status },
  }).catch(() => { /* swallow — caller already reporting */ });
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/**
 * One API call with the tenant's key. The key lives ONLY in the Authorization
 * header; error messages carry status + a truncated body with any occurrence
 * of the key redacted (an echoing proxy must not leak it into our logs).
 */
async function apiCall(tenantId, method, path, { params = {}, body = undefined } = {}) {
  const apiKey = await getApiKey(tenantId);
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const init = {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await withTimeout(
    doFetch(url.toString(), init),
    CALL_TIMEOUT_MS,
    `onestepgps ${method} ${path}`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const safe = String(text).split(apiKey).join('[redacted]').slice(0, 200);
    throw new Error(`OneStepGPS ${method} ${path} failed: ${res.status} ${safe}`);
  }
  // Mutations may answer 204/empty/non-JSON — a body-less success is null;
  // callers that NEED a body (zone create) shape-check what they got.
  try { return await res.json(); } catch { return null; }
}

async function apiGet(tenantId, path, params = {}) {
  return apiCall(tenantId, 'GET', path, { params });
}

/** device-info returns a bare array; tolerate a paginated wrapper too. */
function deviceRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.result_list)) return data.result_list;
  return [];
}

// ─── Normalization ───────────────────────────────────────────────────────────

function parseCoord(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function parseHeading(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** RFC3339 (e.g. "2018-08-27T05:34:55Z") → Date, or null when unparseable. */
export function parseRfc3339(value) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Unknown speed units warn ONCE per unit per process — a fleet of devices all
// reporting "knots" must not turn the log into a firehose.
const warnedSpeedUnits = new Set();
export function _resetSpeedUnitWarningsForTests() { warnedSpeedUnits.clear(); }

/**
 * Unit-honoring speed conversion → mph (our storage unit).
 * - `{ value, unit }` object (device_point_detail.speed): km/h ×0.621371,
 *   mph passthrough, unknown unit → warn once + treat as km/h (the native unit).
 * - bare number (top-level `speed` fallback): treated as km/h per the contract.
 * Returns null for missing/unparseable/negative values.
 */
export function speedToMph(speed, warnFn) {
  const warn = warnFn || ((msg, meta) => logger.warn(msg, meta));
  let value;
  let unit = 'km/h';
  if (speed != null && typeof speed === 'object') {
    value = Number(speed.value);
    unit = String(speed.unit ?? 'km/h').trim().toLowerCase() || 'km/h';
  } else {
    value = Number(speed);
  }
  if (speed == null || !Number.isFinite(value) || value < 0) return null;
  if (unit === 'mph' || unit === 'mi/h') return round2(value);
  if (unit !== 'km/h' && unit !== 'kph' && unit !== 'kmh') {
    if (!warnedSpeedUnits.has(unit)) {
      warnedSpeedUnits.add(unit);
      warn('[onestepgps] unknown speed unit — treating as km/h', { unit });
    }
  }
  return round2(value * KMH_TO_MPH);
}

/**
 * One raw device-info entry → our normalized shape, or null when the entry is
 * unusable (no device_id). Coordinates prefer latest_device_point (it carries
 * dt_tracker + angle); top-level lat/lng is the fallback. eventAt is
 * dt_tracker (device fix time), NOT dt_server.
 */
export function normalizeDeviceInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const externalDeviceId = String(raw.device_id ?? '').trim();
  if (!externalDeviceId) return null;

  const point = (raw.latest_device_point && typeof raw.latest_device_point === 'object')
    ? raw.latest_device_point : null;
  const detail = (point?.device_point_detail && typeof point.device_point_detail === 'object')
    ? point.device_point_detail : null;

  const latitude = parseCoord(point?.lat ?? raw.lat ?? raw.lat_lng?.lat);
  const longitude = parseCoord(point?.lng ?? raw.lng ?? raw.lat_lng?.lng);
  const heading = parseHeading(point?.angle ?? detail?.heading);
  const speedMph = speedToMph(detail?.speed ?? point?.speed ?? null);
  const eventAt = parseRfc3339(point?.dt_tracker || raw.dt_tracker);

  return {
    externalDeviceId,
    displayName: String(raw.display_name ?? '').trim() || null,
    licensePlate: String(raw.license_plate ?? '').trim() || null,
    activeState: String(raw.active_state ?? '').trim() || null,
    latitude,
    longitude,
    heading,
    speedMph,
    eventAt,
  };
}

// ─── High-level calls ────────────────────────────────────────────────────────

/**
 * Connection probe for the connector panel: minimal-flag device-info call.
 * Reports ok + device count; records lastTestStatus on the credential row.
 * Never throws the key — errors are the redacted apiGet messages.
 */
export async function testConnection(tenantId) {
  try {
    const data = await apiGet(tenantId, 'device-info', { device_id: 'true' });
    const count = deviceRows(data).length;
    await recordTestStatus(tenantId, 'OK');
    return { ok: true, deviceCount: count };
  } catch (err) {
    await recordTestStatus(tenantId, 'ERROR');
    return { ok: false, error: err.message };
  }
}

/**
 * Admin device listing (for mapping devices to vehicles): every device the
 * key can see, position or not.
 */
export async function listDevices(tenantId) {
  const data = await apiGet(tenantId, 'device-info', DEVICE_INFO_FLAGS);
  const out = [];
  for (const raw of deviceRows(data)) {
    try {
      const device = normalizeDeviceInfo(raw);
      if (!device) continue;
      out.push({
        externalDeviceId: device.externalDeviceId,
        displayName: device.displayName,
        licensePlate: device.licensePlate,
        activeState: device.activeState,
        hasPosition: device.latitude != null && device.longitude != null,
        lastFixAt: device.eventAt ? device.eventAt.toISOString() : null,
      });
    } catch (err) {
      logger.warn('[onestepgps] skipping malformed device entry', { tenantId, message: err.message });
    }
  }
  return out;
}

/**
 * THE bulk position feed for the shuttle fast poll: ONE device-info call for
 * ALL devices. Entries missing lat/lng are skipped; a malformed entry is
 * skipped with a warn, never thrown — one bad device must not blind the rest
 * of the fleet.
 */
export async function getDevicesWithPositions(tenantId) {
  const data = await apiGet(tenantId, 'device-info', DEVICE_INFO_FLAGS);
  const out = [];
  for (const raw of deviceRows(data)) {
    try {
      const device = normalizeDeviceInfo(raw);
      if (!device) continue;
      if (device.latitude == null || device.longitude == null) continue;
      out.push(device);
    } catch (err) {
      logger.warn('[onestepgps] skipping malformed device entry', { tenantId, message: err.message });
    }
  }
  return out;
}

// ─── Zones + Alerts (Phase 2, 2026-08-24) — ASSUMED CONTRACT, DEFENSIVE ─────
//
// The apidoc (doc/onestepgps-api-contract-2026-08-24.md) covers device-info /
// device-point only; the Zone/ZoneGroup and Alert sections sit behind the
// auth-gated docs page and could not be re-read when this shipped, and no
// public client or spec exists (checked onestepgps's GitHub org, 2026-08-24 —
// only the units library is public). So everything below is built to the
// VERIFIED base contract (base URL, Bearer auth, bare-array-or-result_list
// unwrapping, RFC3339 UTC times) with the endpoint names and field spellings
// ASSUMED and overridable by env until a real capture pins them:
//
//   ONESTEPGPS_ZONES_PATH   (default 'zone')
//   ONESTEPGPS_ALERTS_PATH  (default 'alert')
//
// Tolerance rules: ids are picked from several candidate spellings; an
// answer with no recognizable id is an OneStepGpsShapeError the caller turns
// into "sync stays PENDING, warn logged" — never a crash, and NEVER a faked
// success. Raw alert entries are returned as-is; normalization (with its own
// warn+skip rules) lives in shuttle/shuttle-zone-alerts.js so it is testable
// without this client.

const zonesPath = () => (process.env.ONESTEPGPS_ZONES_PATH || 'zone').replace(/^\//, '');
// VERIFIED against the live apidoc (2026-08-25, via Hector's session): the
// account-wide polling endpoint is GET /v3/api/public/alert/user/devices/
// (cursor-paginated: limit, alert_cursor, alert_at_from/to, asc; response
// { result_length, result_list, alert_cursor, outside_time_bound }).
const alertsPath = () => (process.env.ONESTEPGPS_ALERTS_PATH || 'alert/user/devices/').replace(/^\//, '');

/** Tolerant id extraction from a zone create/update answer. */
export function pickProviderZoneId(data) {
  if (data == null) return null;
  if (typeof data === 'string' || typeof data === 'number') return String(data).trim() || null;
  if (typeof data !== 'object') return null;
  const containers = [data, data.zone, data.result, data.data];
  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    for (const key of ['zone_id', 'zoneId', 'id', '_id', 'uuid']) {
      const v = c[key];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return null;
}

/**
 * Create or update the provider-side copy of a zone. `points` is our
 * canonical [{lat,lng},...] list; both common spellings are sent so either
 * server-side reader finds one. Returns { providerZoneId }.
 */
export async function pushProviderZone(tenantId, { providerZoneId = null, name, points }) {
  // VERIFIED create-zone contract (live apidoc, second read 2026-08-25 after
  // their validator 500'd the first live push): zone_type is REQUIRED and
  // "Currently only \"polygon\" is supported"; vertices is "an array of FLOATS
  // representing latlng coordinates. [Lat, Lng, Lat, Lng, ...]" nested under
  // shape_data. Clean payload only — the legacy object-list spellings were
  // dropped the moment their validator proved it is strict, not tolerant.
  const flatVertices = (points || []).flatMap((p) => [Number(p.lat), Number(p.lng)]);
  const body = {
    display_name: String(name || '').slice(0, 120),
    zone_type: 'polygon',
    shape_data: { vertices: flatVertices },
    vertices: flatVertices,
  };
  let data;
  if (providerZoneId) {
    body.zone_id = providerZoneId;
    data = await apiCall(tenantId, 'PUT', `${zonesPath()}/${encodeURIComponent(providerZoneId)}`, { body });
    // An empty PUT answer is fine — the id we addressed is the id.
    return { providerZoneId: pickProviderZoneId(data) || providerZoneId };
  }
  data = await apiCall(tenantId, 'POST', zonesPath(), { body });
  const id = pickProviderZoneId(data);
  if (!id) {
    throw new OneStepGpsShapeError('zone create answered without a recognizable zone id');
  }
  return { providerZoneId: id };
}

/** Best-effort provider-side delete. 404-ish failures are the caller's call. */
export async function deleteProviderZone(tenantId, providerZoneId) {
  if (!providerZoneId) return { ok: true, skipped: true };
  await apiCall(tenantId, 'DELETE', `${zonesPath()}/${encodeURIComponent(providerZoneId)}`);
  return { ok: true };
}

/**
 * Raw alert entries since `sinceIso` (RFC3339). Window params are sent in
 * both documented device-point spellings (dt_server_from is the doc's own
 * "tail new records" idiom) — unknown params are assumed ignored. Returns the
 * unwrapped array UNNORMALIZED; a non-array answer is a ShapeError.
 */
export async function listRawAlerts(tenantId, { sinceIso } = {}) {
  const params = {};
  if (sinceIso) {
    params.dt_server_from = sinceIso;
    params.dt_from = sinceIso;
  }
  const data = await apiGet(tenantId, alertsPath(), params);
  if (Array.isArray(data)) return data;
  for (const key of ['result_list', 'alerts', 'data', 'result']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  throw new OneStepGpsShapeError('alerts endpoint answered with no recognizable list');
}
