/**
 * Voltswitch GPS Telematics API Client
 *
 * Pull-based integration. Auth flow:
 *   1. POST /auth/token  (username + password, form-urlencoded) → token
 *   2. POST /auth/login   (token header + username + password, form-urlencoded) → user_hash
 *   3. All subsequent calls send `token` + `user_hash` in headers, body as form-urlencoded
 *
 * Docs: https://app.voltswitchgps.com/api-rest/v1/docs/
 */

const BASE_URL = 'https://app.voltswitchgps.com/rest/v1';

// In-memory session cache (per-tenant). Refreshed when expired or on 401.
const sessions = new Map();

function toFormBody(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ─── Auth ────────────────────────────────────────────────────────────

async function getToken(username, password) {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: toFormBody({ username, password })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Voltswitch /auth/token failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Response may have the token in various fields
  const token = data?.token || data?.data?.token || data?.authToken || data?.authorization;
  if (!token) throw new Error(`Voltswitch /auth/token returned no token. Response: ${JSON.stringify(data).slice(0, 200)}`);
  return token;
}

async function login(token, username, password) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'token': token
    },
    body: toFormBody({ username, password })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Voltswitch /auth/login failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const userHash = data?.user_hash || data?.userHash || data?.data?.user_hash || data?.data?.userHash;
  if (!userHash) throw new Error(`Voltswitch /auth/login returned no user_hash. Response: ${JSON.stringify(data).slice(0, 200)}`);
  return { userHash, userData: data };
}

/**
 * Authenticate and cache the session. Returns { token, userHash }.
 * Reuses cached session if still valid (< 25 min old).
 */
export async function authenticate({ username, password, tenantId = '_default' }) {
  const cached = sessions.get(tenantId);
  const now = Date.now();
  if (cached && (now - cached.createdAt) < 25 * 60 * 1000) {
    return { token: cached.token, userHash: cached.userHash };
  }

  const token = await getToken(username, password);
  const { userHash } = await login(token, username, password);

  sessions.set(tenantId, { token, userHash, createdAt: now });
  return { token, userHash };
}

/** Clear cached session (e.g. on 401 retry) */
export function clearSession(tenantId = '_default') {
  sessions.delete(tenantId);
}

// ─── API call helper ─────────────────────────────────────────────────

async function apiCall(method, path, { token, userHash, body = null } = {}) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'token': token,
    'user_hash': userHash
  };
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = toFormBody(body);

  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Voltswitch ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Device endpoints ────────────────────────────────────────────────

/**
 * List all devices on the account (max 500 per call).
 * @param {object} session - { token, userHash }
 * @param {object} opts - { start } pagination offset
 */
export async function getAllDevices(session, { start = 0 } = {}) {
  const data = await apiCall('POST', '/devices/getAll', {
    ...session,
    body: { start }
  });
  return Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.devices) ? data.devices
    : Array.isArray(data) ? data : [];
}

/**
 * Get details for a specific device by IMEI.
 */
export async function getDeviceDetails(session, { imei }) {
  return apiCall('POST', '/devices/details', {
    ...session,
    body: { imei }
  });
}

/**
 * Get device info (activation, subscription details).
 */
export async function getDeviceInfo(session, { imei }) {
  return apiCall('POST', '/devices/deviceinfo', {
    ...session,
    body: { imei }
  });
}

/**
 * Get current location for a specific device by IMEI.
 */
export async function getDeviceLocation(session, { imei }) {
  const data = await apiCall('POST', '/devices/location', {
    ...session,
    body: { imei }
  });
  return normalizeLocationEvent(data);
}

/**
 * Get location history for a device (max 7 day range).
 */
export async function getDeviceHistory(session, { imei, startDate, endDate }) {
  return apiCall('POST', '/devices/history', {
    ...session,
    body: { imei, start_date: startDate, end_date: endDate }
  });
}

/**
 * Get device miles log.
 */
export async function getDeviceMilesLog(session, { imei, startDate, endDate }) {
  return apiCall('POST', '/devices/mileslog', {
    ...session,
    body: { imei, start_date: startDate, end_date: endDate }
  });
}

/**
 * Get device alert log.
 */
export async function getDeviceAlertLog(session, { imei, startDate, endDate }) {
  return apiCall('POST', '/devices/alertlog', {
    ...session,
    body: { imei, start_date: startDate, end_date: endDate }
  });
}

/**
 * Search devices by owner, device name, IMEI, or VIN.
 */
export async function searchDevices(session, { query }) {
  return apiCall('POST', '/devices/search', {
    ...session,
    body: { search: query }
  });
}

/**
 * Trigger a locate-on-demand ping for a device.
 */
export async function locateOnDemand(session, { imei }) {
  return apiCall('POST', '/devices/locate_on_demand', {
    ...session,
    body: { imei }
  });
}

// ─── Normalization ───────────────────────────────────────────────────

/**
 * Normalize a Voltswitch device record into our VehicleTelematicsDevice shape.
 * We use IMEI as the canonical externalDeviceId since all Voltswitch calls use IMEI.
 */
export function normalizeDevice(raw) {
  const imei = String(raw?.imei || raw?.IMEI || raw?.device_imei || '').trim();
  return {
    externalDeviceId: imei,
    label: String(raw?.device_name || raw?.name || raw?.label || raw?.device_label || '').trim() || null,
    serialNumber: imei || null,
    isActive: raw?.status === 'active' || raw?.status === 'Active' || raw?.is_active === true || raw?.status === 1 || raw?.device_status === 'active',
    vin: String(raw?.vin || raw?.VIN || raw?.vehicle_vin || '').trim() || null,
    licensePlate: String(raw?.license_plate || raw?.plate || raw?.vehicle_plate || '').trim() || null,
    ownerName: String(raw?.owner_name || raw?.owner || raw?.client_name || '').trim() || null,
    make: String(raw?.vehicle_make || raw?.make || '').trim() || null,
    model: String(raw?.vehicle_model || raw?.model || '').trim() || null,
    year: String(raw?.vehicle_year || raw?.year || '').trim() || null,
    lastEventAt: raw?.last_ping || raw?.last_event || raw?.updated_at || null,
    raw
  };
}

/**
 * Normalize a Voltswitch location/event into our telematics event shape.
 */
export function normalizeLocationEvent(raw) {
  const data = raw?.data || raw;
  return {
    eventType: 'PING',
    eventAt: data?.timestamp || data?.datetime || data?.last_ping || data?.event_time || data?.updated_at || new Date().toISOString(),
    latitude: parseCoord(data?.latitude || data?.lat),
    longitude: parseCoord(data?.longitude || data?.lng || data?.lon),
    speedMph: parseNum(data?.speed),
    heading: parseNum(data?.heading || data?.bearing || data?.angle),
    odometer: parseNum(data?.odometer || data?.mileage || data?.miles || data?.total_distance),
    fuelPct: parseNum(data?.fuel_level || data?.fuel),
    batteryPct: parseNum(data?.battery || data?.battery_level || data?.power),
    engineOn: data?.engine === 'on' || data?.engine === 1 || data?.engine === true
      || data?.ignition === 'on' || data?.ignition === 1 || data?.ignition === true
      || data?.acc === 'on' || data?.acc === 1 || null,
    address: String(data?.address || data?.location || data?.location_address || '').trim() || null,
    raw: data
  };
}

function parseCoord(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function parseNum(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ─── High-level sync helpers ─────────────────────────────────────────

/**
 * Fetch all devices and their current locations in one pass.
 * Returns normalized array ready for ingest.
 */
export async function syncAllDeviceLocations(session) {
  const devices = await getAllDevices(session);
  const results = [];

  for (const raw of devices) {
    const device = normalizeDevice(raw);
    if (!device.externalDeviceId) continue;

    try {
      const location = await getDeviceLocation(session, { imei: device.externalDeviceId });
      results.push({ device, location });
    } catch {
      results.push({ device, location: null });
    }
  }

  return results;
}
