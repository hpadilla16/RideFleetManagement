/**
 * Voltswitch GPS Telematics API Client
 *
 * Pull-based integration. Auth flow:
 *   1. POST /auth/token  (email + password) → authToken
 *   2. POST /auth/login   (authToken + email + password) → userHash
 *   3. All subsequent calls send authToken + userHash in headers
 *
 * Docs: https://app.voltswitchgps.com/api-rest/v1/docs/
 */

const BASE_URL = 'https://app.voltswitchgps.com/rest/v1';

// In-memory session cache (per-tenant). Refreshed when expired or on 401.
const sessions = new Map();

// ─── Auth ────────────────────────────────────────────────────────────

async function getToken(email, password) {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) throw new Error(`Voltswitch /auth/token failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const token = data?.token || data?.authToken || data?.authorization || data?.data?.token;
  if (!token) throw new Error('Voltswitch /auth/token returned no token');
  return token;
}

async function login(authToken, email, password) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authToken
    },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) throw new Error(`Voltswitch /auth/login failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const userHash = data?.userHash || data?.user_hash || data?.data?.userHash || data?.data?.user_hash;
  if (!userHash) throw new Error('Voltswitch /auth/login returned no userHash');
  return { userHash, userData: data };
}

/**
 * Authenticate and cache the session. Returns { authToken, userHash }.
 * Reuses cached session if still valid (< 25 min old).
 */
export async function authenticate({ email, password, tenantId = '_default' }) {
  const cached = sessions.get(tenantId);
  const now = Date.now();
  // Reuse session if younger than 25 minutes
  if (cached && (now - cached.createdAt) < 25 * 60 * 1000) {
    return { authToken: cached.authToken, userHash: cached.userHash };
  }

  const authToken = await getToken(email, password);
  const { userHash } = await login(authToken, email, password);

  sessions.set(tenantId, { authToken, userHash, createdAt: now });
  return { authToken, userHash };
}

/** Clear cached session (e.g. on 401 retry) */
export function clearSession(tenantId = '_default') {
  sessions.delete(tenantId);
}

// ─── API call helper ─────────────────────────────────────────────────

async function apiCall(method, path, { authToken, userHash, body = null } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': authToken,
    'User-Hash': userHash
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

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
 */
export async function getAllDevices(session, { page = 1, limit = 500 } = {}) {
  const data = await apiCall('POST', '/devices/getAll', {
    ...session,
    body: { page, limit }
  });
  return Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
}

/**
 * Get details for a specific device by IMEI or device ID.
 */
export async function getDeviceDetails(session, { deviceId }) {
  return apiCall('POST', '/devices/details', {
    ...session,
    body: { device_id: deviceId }
  });
}

/**
 * Get device info (activation, subscription details).
 */
export async function getDeviceInfo(session, { deviceId }) {
  return apiCall('POST', '/devices/deviceinfo', {
    ...session,
    body: { device_id: deviceId }
  });
}

/**
 * Get current location for a specific device.
 */
export async function getDeviceLocation(session, { deviceId }) {
  const data = await apiCall('POST', '/devices/location', {
    ...session,
    body: { device_id: deviceId }
  });
  return normalizeLocationEvent(data);
}

/**
 * Get location history for a device (max 7 day range).
 */
export async function getDeviceHistory(session, { deviceId, startDate, endDate }) {
  return apiCall('POST', '/devices/history', {
    ...session,
    body: { device_id: deviceId, start_date: startDate, end_date: endDate }
  });
}

/**
 * Get device miles log.
 */
export async function getDeviceMilesLog(session, { deviceId, startDate, endDate }) {
  return apiCall('POST', '/devices/mileslog', {
    ...session,
    body: { device_id: deviceId, start_date: startDate, end_date: endDate }
  });
}

/**
 * Get device alert log.
 */
export async function getDeviceAlertLog(session, { deviceId, startDate, endDate }) {
  return apiCall('POST', '/devices/alertlog', {
    ...session,
    body: { device_id: deviceId, start_date: startDate, end_date: endDate }
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
export async function locateOnDemand(session, { deviceId }) {
  return apiCall('POST', '/devices/locate_on_demand', {
    ...session,
    body: { device_id: deviceId }
  });
}

// ─── Normalization ───────────────────────────────────────────────────

/**
 * Normalize a Voltswitch device record into our VehicleTelematicsDevice shape.
 */
export function normalizeDevice(raw) {
  return {
    externalDeviceId: String(raw?.device_id || raw?.id || raw?.imei || ''),
    label: String(raw?.device_name || raw?.name || raw?.label || '').trim() || null,
    serialNumber: String(raw?.imei || raw?.serial || '').trim() || null,
    isActive: raw?.status === 'active' || raw?.is_active === true || raw?.active === true || raw?.status === 1,
    vin: String(raw?.vin || '').trim() || null,
    licensePlate: String(raw?.license_plate || raw?.plate || '').trim() || null,
    ownerName: String(raw?.owner_name || raw?.owner || '').trim() || null,
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
    eventAt: data?.timestamp || data?.last_ping || data?.event_time || data?.updated_at || new Date().toISOString(),
    latitude: parseCoord(data?.latitude || data?.lat),
    longitude: parseCoord(data?.longitude || data?.lng || data?.lon),
    speedMph: parseNum(data?.speed),
    heading: parseNum(data?.heading || data?.bearing),
    odometer: parseNum(data?.odometer || data?.mileage || data?.miles),
    fuelPct: parseNum(data?.fuel_level || data?.fuel),
    batteryPct: parseNum(data?.battery || data?.battery_level),
    engineOn: data?.engine_on ?? data?.ignition ?? (data?.engine_status === 'on' || data?.engine_status === 1) ?? null,
    address: String(data?.address || data?.location_address || '').trim() || null,
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
      const location = await getDeviceLocation(session, { deviceId: device.externalDeviceId });
      results.push({ device, location });
    } catch {
      // Device may not have a recent location — skip
      results.push({ device, location: null });
    }
  }

  return results;
}
