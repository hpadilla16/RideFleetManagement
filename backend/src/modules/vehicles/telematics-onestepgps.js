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
 * GET a public API path with the tenant's key. The key lives ONLY in the
 * Authorization header; error messages carry status + a truncated body with
 * any occurrence of the key redacted (an echoing proxy must not leak it into
 * our logs).
 */
async function apiGet(tenantId, path, params = {}) {
  const apiKey = await getApiKey(tenantId);
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await withTimeout(
    doFetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    }),
    CALL_TIMEOUT_MS,
    `onestepgps GET ${path}`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const safe = String(text).split(apiKey).join('[redacted]').slice(0, 200);
    throw new Error(`OneStepGPS GET ${path} failed: ${res.status} ${safe}`);
  }
  return res.json();
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
