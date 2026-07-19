/**
 * Ride Kiosk — Fase B1 (2026-07-05). Device pairing + token lifecycle.
 * Spec: doc/kiosk-e2e-spec-2026-07-04.md.
 *
 * Trust model: a KioskDevice is a lobby tablet. Its long-lived token is
 * random (32 bytes, base64url), stored ONLY as a SHA-256 hex hash, shown
 * exactly once (pair/rotate). Pairing is a 6-digit single-use code with a
 * 10-min TTL and a brute-force lockout — /pair is the only unauthenticated
 * route and sits behind the public per-IP guards (tenant-rate-limit runs
 * after requireAuth and never covers /api/kiosk).
 */

import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { scopedSettingKey } from '../../lib/module-access.js';

export class KioskError extends Error {
  constructor(message, status = 400, code = null, details = null) {
    super(message);
    this.name = 'KioskError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const PAIRING_CODE_TTL_MIN = 10;
export const MAX_PAIRING_ATTEMPTS = 5;
export const PAIR_MISS_WINDOW_MS = 15 * 60 * 1000;

// Per-IP pairing-miss tracking (in-memory, same bucket style as
// public-endpoint-guards.js). A wrong code identifies no device, so misses
// are charged to the CALLER's IP — never to other tenants' outstanding codes
// (a cross-device DB increment would let one griefer kill every pairing
// platform-wide). Per-code single-use + TTL stay on the row itself.
const pairMissBuckets = new Map();

function prunePairMissBuckets(nowMs) {
  for (const [key, bucket] of pairMissBuckets.entries()) {
    if (!bucket || bucket.expiresAt <= nowMs) pairMissBuckets.delete(key);
  }
}

function pairMissCount(ip, nowMs) {
  prunePairMissBuckets(nowMs);
  const bucket = pairMissBuckets.get(ip);
  return bucket && bucket.expiresAt > nowMs ? bucket.count : 0;
}

function registerPairMiss(ip, nowMs) {
  const bucket = pairMissBuckets.get(ip);
  if (bucket && bucket.expiresAt > nowMs) bucket.count += 1;
  else pairMissBuckets.set(ip, { count: 1, expiresAt: nowMs + PAIR_MISS_WINDOW_MS });
}

/** Test hook — clears the in-memory per-IP pairing-miss buckets. */
export function resetPairMissTracking() {
  pairMissBuckets.clear();
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newDeviceToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function newPairingCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function pairingCodeExpiry(now = new Date()) {
  return new Date(now.getTime() + PAIRING_CODE_TTL_MIN * 60 * 1000);
}

/**
 * QA rider (B2): 6-digit codes across a fleet CAN collide, and pairDevice
 * looks devices up by pairingCodeHash — a collision would pair the wrong
 * tablet. Regenerate until the code is unique among ACTIVE devices.
 */
async function mintUniquePairingCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newPairingCode();
    const clash = await prisma.kioskDevice.findFirst({
      where: { pairingCodeHash: sha256Hex(code), status: 'ACTIVE' },
      select: { id: true },
    });
    if (!clash) return code;
  }
  throw new KioskError('Could not mint a unique pairing code — try again', 500, 'PAIRING_CODE_MINT_FAILED');
}

// A tablet that hasn't authenticated a request in 15 min is considered
// offline (B3 heartbeat rider — requireKioskDevice bumps lastSeenAt).
export const DEVICE_OFFLINE_AFTER_MS = 15 * 60 * 1000;

export function deviceConnectivity(device, now = Date.now()) {
  const lastSeenMs = device?.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
  return now - lastSeenMs <= DEVICE_OFFLINE_AFTER_MS ? 'ONLINE' : 'OFFLINE';
}

function deviceView(device) {
  return {
    id: device.id,
    tenantId: device.tenantId,
    locationId: device.locationId,
    name: device.name,
    status: device.status,
    connectivity: deviceConnectivity(device),
    walkupEnabled: device.walkupEnabled,
    tokenVersion: device.tokenVersion,
    pairingPending: !!device.pairingCodeHash,
    pairingCodeExpiresAt: device.pairingCodeExpiresAt,
    lastSeenAt: device.lastSeenAt,
    appVersion: device.appVersion,
    rotatedAt: device.rotatedAt,
    revokedAt: device.revokedAt,
    createdAt: device.createdAt,
  };
}

function requireTenantId(scope = {}) {
  if (!scope?.tenantId) {
    throw new KioskError('A tenant scope is required (super-admins pass ?tenantId=)', 400, 'TENANT_SCOPE_REQUIRED');
  }
  return scope.tenantId;
}

async function getScopedDevice(deviceId, scope = {}) {
  const device = await prisma.kioskDevice.findFirst({
    where: { id: deviceId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
  });
  if (!device) throw new KioskError('Kiosk device not found', 404, 'DEVICE_NOT_FOUND');
  return device;
}

/**
 * Admin: register a tablet. The row is created with a throwaway token hash
 * (plaintext discarded — the device is unusable until paired) plus a fresh
 * pairing code that the admin reads off the screen and types on the tablet.
 */
async function createDevice({ name, locationId, walkupEnabled } = {}, scope = {}) {
  const tenantId = requireTenantId(scope);
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new KioskError('name is required', 400);
  if (!locationId) throw new KioskError('locationId is required', 400);

  const location = await prisma.location.findFirst({ where: { id: locationId, tenantId }, select: { id: true } });
  if (!location) throw new KioskError('Location not found for this tenant', 404, 'LOCATION_NOT_FOUND');

  const pairingCode = await mintUniquePairingCode();
  const device = await prisma.kioskDevice.create({
    data: {
      tenantId,
      locationId,
      name: cleanName.slice(0, 120),
      // Placeholder: hash of a token nobody knows. pairDevice() issues the real one.
      tokenHash: sha256Hex(newDeviceToken()),
      pairingCodeHash: sha256Hex(pairingCode),
      pairingCodeExpiresAt: pairingCodeExpiry(),
      pairingAttempts: 0,
      walkupEnabled: walkupEnabled !== false,
    },
  });

  logger.info('[kiosk] device created', { deviceId: device.id, tenantId, locationId });
  return { device: deviceView(device), pairingCode, pairingCodeExpiresAt: device.pairingCodeExpiresAt };
}

/**
 * Admin: mint a fresh pairing code. Also the recovery path after ANY device
 * lockout — resets both the pairing counter and the per-device reservation-
 * lookup lockout (lookupMisses / lookupLockedUntil).
 */
async function issuePairingCode(deviceId, scope = {}) {
  const device = await getScopedDevice(deviceId, scope);
  if (device.status !== 'ACTIVE') throw new KioskError('Device is revoked — create a new device instead', 409, 'DEVICE_REVOKED');

  const pairingCode = await mintUniquePairingCode();
  const updated = await prisma.kioskDevice.update({
    where: { id: device.id },
    data: {
      pairingCodeHash: sha256Hex(pairingCode),
      pairingCodeExpiresAt: pairingCodeExpiry(),
      pairingAttempts: 0,
      lookupMisses: 0,
      lookupLockedUntil: null,
    },
  });
  logger.info('[kiosk] pairing code issued', { deviceId: device.id, tenantId: device.tenantId });
  return { device: deviceView(updated), pairingCode, pairingCodeExpiresAt: updated.pairingCodeExpiresAt };
}

/**
 * PUBLIC: exchange a pairing code for the device token. Single-use: the code
 * is consumed atomically (guarded updateMany) so two concurrent pairs can't
 * both win. Misses are tracked per CALLER IP in memory (MAX_PAIRING_ATTEMPTS
 * per PAIR_MISS_WINDOW_MS → 429) on top of the route's public rate-limit
 * guard; per-device pairingAttempts remains as a lockout the admin resets
 * with a fresh code.
 */
async function pairDevice({ pairingCode, ip } = {}) {
  const code = String(pairingCode || '').trim();
  const now = new Date();
  const nowMs = now.getTime();
  const ipKey = String(ip || 'unknown');
  const invalid = new KioskError('Invalid or expired pairing code', 401, 'INVALID_PAIRING_CODE');

  if (pairMissCount(ipKey, nowMs) >= MAX_PAIRING_ATTEMPTS) {
    throw new KioskError('Too many pairing attempts — try again later or ask an admin for a new code', 429, 'PAIRING_LOCKED');
  }

  if (!/^\d{6}$/.test(code)) {
    registerPairMiss(ipKey, nowMs);
    throw invalid;
  }

  const device = await prisma.kioskDevice.findFirst({
    where: { pairingCodeHash: sha256Hex(code), status: 'ACTIVE' },
  });
  const expired = !device?.pairingCodeExpiresAt || new Date(device.pairingCodeExpiresAt) <= now;
  // pairingAttempts is RESERVED: nothing increments it in the request path
  // today (misses are tracked per-IP since the B1 review — see
  // registerPairMiss above). The check stays as a fail-closed guard for any
  // future attributed increment; admin pairing-code reissue resets it.
  const lockedOut = (device?.pairingAttempts || 0) >= MAX_PAIRING_ATTEMPTS;
  if (!device || expired || lockedOut) {
    registerPairMiss(ipKey, nowMs);
    if (device && lockedOut) {
      throw new KioskError('Too many pairing attempts — ask an admin for a new code', 401, 'PAIRING_LOCKED');
    }
    throw invalid;
  }

  const token = newDeviceToken();
  const consumed = await prisma.kioskDevice.updateMany({
    where: { id: device.id, pairingCodeHash: device.pairingCodeHash, status: 'ACTIVE' },
    data: {
      pairingCodeHash: null,
      pairingCodeExpiresAt: null,
      pairingAttempts: 0,
      tokenHash: sha256Hex(token),
      tokenVersion: { increment: 1 },
      lastSeenAt: now,
    },
  });
  if (consumed.count !== 1) throw invalid; // lost the race — code already consumed

  logger.info('[kiosk] device paired', { deviceId: device.id, tenantId: device.tenantId });
  // Location + tenant joins so the kiosk header can render
  // "International Rental Corp — Orlando MCO · Kiosk 1" straight from the
  // pair response (B3b + Graphic Design review). vozia = B3f Get Help embed
  // bootstrap (null → the frontend stays dark/fail-soft).
  const [location, tenant, vozia] = await Promise.all([
    deviceLocation(device), deviceTenant(device), deviceVozia(device),
  ]);
  return {
    deviceToken: token,
    device: {
      id: device.id,
      tenantId: device.tenantId,
      locationId: device.locationId,
      name: device.name,
      walkupEnabled: device.walkupEnabled,
      location,
      tenant,
      vozia,
    },
  };
}

async function deviceLocation(device) {
  const location = await prisma.location.findFirst({
    where: { id: device.locationId, ...(device.tenantId ? { tenantId: device.tenantId } : {}) },
    select: { id: true, name: true },
  }).catch(() => null);
  return location ? { id: location.id, name: location.name } : null;
}

// Tenant display name for guest-facing kiosk branding (Tenant.name — the same
// row field the tenants admin surfaces; email branding may layer a settings
// companyName on top, which stays a B3b concern). SELECT the name ONLY —
// nothing else from the Tenant row ever reaches a lobby device. Fail-soft
// like the location join.
async function deviceTenant(device) {
  if (!device?.tenantId) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: device.tenantId },
    select: { name: true },
  }).catch(() => null);
  return tenant ? { name: tenant.name } : null;
}

// ── B3f: VozIA "Get Help" embed config ──────────────────────────────────────
// AppSetting voziaKioskConfig per tenant: { host, widgetKey }. The widgetKey
// is a RATE-LIMIT budget key that by contract travels in a public iframe URL
// (KIOSK-EMBED.md: "el key NO es auth — el secret per-conversation lo es") —
// stored server-side so rotating it is a config change, but it is NOT a
// credential. Fail-soft everywhere: unset/invalid → null → the kiosk's Get
// Help keeps today's escalate+staff behavior.

function voziaSettingKey(tenantId) {
  return scopedSettingKey('voziaKioskConfig', { tenantId });
}

function normalizeVoziaHost(rawHost) {
  const raw = String(rawHost || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  // R2: origin only — the frontend derives new URL(host).origin everywhere,
  // so a subpath-mounted host would misconfigure silently. Reject any path/
  // query/hash (port is fine).
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  return raw;
}

async function readVoziaConfig(tenantId) {
  if (!tenantId) return null;
  const row = await prisma.appSetting.findUnique({ where: { key: voziaSettingKey(tenantId) } }).catch(() => null);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    const host = normalizeVoziaHost(parsed?.host);
    if (!host) return null;
    return { host, widgetKey: parsed?.widgetKey ? String(parsed.widgetKey) : null };
  } catch {
    return null;
  }
}

async function deviceVozia(device) {
  return readVoziaConfig(device?.tenantId || null);
}

/** Admin GET /api/kiosk/vozia-config — full values (config, not credentials). */
async function getVoziaSettings(scope = {}) {
  const tenantId = requireTenantId(scope);
  return { config: await readVoziaConfig(tenantId) };
}

/**
 * Admin PUT /api/kiosk/vozia-config — { host, widgetKey? } (host must be an
 * https URL; trailing slash stripped) or { host: null } to clear.
 */
async function updateVoziaSettings(body = {}, scope = {}) {
  const tenantId = requireTenantId(scope);
  const key = voziaSettingKey(tenantId);

  if (body?.host === null) {
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(null) },
      update: { value: JSON.stringify(null) },
    });
    return { config: null };
  }

  const host = normalizeVoziaHost(body?.host);
  if (!host) {
    throw new KioskError('host must be an https:// URL', 422, 'INVALID_VOZIA_HOST');
  }
  const widgetKey = body?.widgetKey ? String(body.widgetKey).trim().slice(0, 128) : null;
  const config = { host, widgetKey };
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(config) },
    update: { value: JSON.stringify(config) },
  });
  logger.info('[kiosk] vozia config updated', { tenantId, host, hasWidgetKey: !!widgetKey });
  return { config };
}

/**
 * Device-authed GET /api/kiosk/device — a paired kiosk refreshes its own
 * display info (name, walk-up toggle, location + tenant labels, Get Help
 * embed config) without re-pairing.
 */
async function getOwnDevice(deviceCtx) {
  const device = await prisma.kioskDevice.findFirst({
    where: { id: deviceCtx.id, tenantId: deviceCtx.tenantId },
  });
  if (!device) throw new KioskError('Kiosk device not found', 404, 'DEVICE_NOT_FOUND');
  const [location, tenant, vozia] = await Promise.all([
    deviceLocation(device), deviceTenant(device), deviceVozia(device),
  ]);
  return { device: { ...deviceView(device), location, tenant, vozia } };
}

/**
 * Admin PATCH /api/kiosk/devices/:id — { walkupEnabled?: boolean,
 * name?: string (1-80) }. Powers the A1 "Manage" walk-up toggle (B3b).
 */
async function updateDevice(deviceId, patch = {}, scope = {}) {
  const device = await getScopedDevice(deviceId, scope); // 404 on cross-tenant
  const data = {};

  if (patch.walkupEnabled !== undefined) {
    if (typeof patch.walkupEnabled !== 'boolean') {
      throw new KioskError('walkupEnabled must be a boolean', 422, 'INVALID_DEVICE_PATCH');
    }
    data.walkupEnabled = patch.walkupEnabled;
  }
  if (patch.name !== undefined) {
    const cleanName = String(patch.name ?? '').trim();
    if (!cleanName || cleanName.length > 80) {
      throw new KioskError('name must be 1-80 characters', 422, 'INVALID_DEVICE_PATCH');
    }
    data.name = cleanName;
  }
  if (!Object.keys(data).length) {
    throw new KioskError('Provide walkupEnabled and/or name', 422, 'INVALID_DEVICE_PATCH');
  }

  const updated = await prisma.kioskDevice.update({ where: { id: device.id }, data });
  logger.info('[kiosk] device updated', { deviceId: device.id, tenantId: device.tenantId, fields: Object.keys(data) });
  return deviceView(updated);
}

/** Admin: rotate the device token. Old token dies immediately. */
async function rotateToken(deviceId, scope = {}) {
  const device = await getScopedDevice(deviceId, scope);
  if (device.status !== 'ACTIVE') throw new KioskError('Device is revoked', 409, 'DEVICE_REVOKED');

  const token = newDeviceToken();
  const updated = await prisma.kioskDevice.update({
    where: { id: device.id },
    data: { tokenHash: sha256Hex(token), tokenVersion: { increment: 1 }, rotatedAt: new Date() },
  });
  logger.info('[kiosk] device token rotated', { deviceId: device.id, tenantId: device.tenantId });
  return { deviceToken: token, device: deviceView(updated) };
}

/** Admin: kill the device. Its token stops authenticating on the next request. */
async function revokeDevice(deviceId, scope = {}) {
  const device = await getScopedDevice(deviceId, scope);
  const updated = await prisma.kioskDevice.update({
    where: { id: device.id },
    data: { status: 'REVOKED', revokedAt: new Date(), pairingCodeHash: null, pairingCodeExpiresAt: null },
  });
  logger.info('[kiosk] device revoked', { deviceId: device.id, tenantId: device.tenantId });
  return deviceView(updated);
}

async function listDevices(scope = {}, { locationId } = {}) {
  const tenantId = requireTenantId(scope);
  const devices = await prisma.kioskDevice.findMany({
    where: { tenantId, ...(locationId ? { locationId } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  return devices.map(deviceView);
}

export const kioskDeviceService = {
  createDevice,
  issuePairingCode,
  pairDevice,
  rotateToken,
  revokeDevice,
  listDevices,
  updateDevice,
  getOwnDevice,
  getVoziaSettings,
  updateVoziaSettings,
};
