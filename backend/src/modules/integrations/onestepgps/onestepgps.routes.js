/**
 * Admin routes for the OneStepGPS telematics connector (shuttle tracker GPS).
 *
 * Mounted at `/api/admin/integrations/onestepgps` — the same shape as
 * TL/Economy/NU/Flexways/Advantage (tenantRateLimit + router). Every route
 * requires requireAuth + requireRole('SUPER_ADMIN','ADMIN'); ADMIN is
 * hard-scoped to their own tenant via resolveTenantId (non-super branch
 * returns req.user.tenantId — cannot cross-tenant query).
 *
 * The API key is ONE encrypted blob per tenant in IntegrationCredential
 * (unique (tenantId, sourceSystem='ONESTEPGPS')), AES-256-GCM via
 * lib/integration-crypto. The key is NEVER logged or returned — /status
 * reports booleans and timestamps only. Because the key does NOT live in the
 * telematicsConfig appSetting blob, saving the Settings > Telematics page can
 * never erase it (the pre-2026-08-13 VoltSwitch erase bug is structurally
 * impossible here).
 *
 * Device→vehicle mappings are ordinary VehicleTelematicsDevice rows with
 * provider 'ONESTEPGPS' (String column — no migration), created through the
 * SAME vehiclesService.registerTelematicsDevice the per-vehicle endpoint
 * (POST /api/vehicles/:id/telematics/devices) uses. The mapping endpoints
 * here exist so the connector panel can map from a device list instead of
 * vehicle-by-vehicle.
 *
 * Endpoint inventory:
 *   GET    /status                 → { hasApiKey, rotatedAt, lastTestedAt, lastTestStatus, mappedDevices }
 *   POST   /credentials            { apiKey } → set/rotate the key (encrypted)
 *   DELETE /credentials            → clear the stored key
 *   POST   /test-connection        → live device-info probe → { ok, deviceCount }
 *   GET    /devices                → live device list (id, name, plate, active, lastFixAt) + mapped vehicleId
 *   GET    /device-mappings        → VehicleTelematicsDevice rows (provider ONESTEPGPS) for the tenant
 *   POST   /device-mappings        { vehicleId, externalDeviceId, label? } → upsert mapping
 *   DELETE /device-mappings/:id    → deactivate a mapping (isActive=false; events keep their FK)
 */

import { Router } from 'express';
import { requireAuth, requireRole, isSuperAdmin } from '../../../middleware/auth.js';
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import {
  setApiKey,
  clearApiKey,
  testConnection,
  listDevices,
  getCredentialStatus,
  OneStepGpsAuthError,
} from '../../vehicles/telematics-onestepgps.js';
import { vehiclesService } from '../../vehicles/vehicles.service.js';
import { auditFromReq, AUDIT_ACTIONS, AUDIT_OUTCOME } from '../../audit/audit.service.js';

// Every mutation below leaves an AdminAuditLog row via auditFromReq
// (SECURITY GATE): best-effort, never throws, actor/tenant/ip/userAgent from
// the request. metadata carries provider + mapping targets ONLY — the API key
// (or any fragment of it) must never be passed, not even for redaction.
const AUDIT_PROVIDER = 'ONESTEPGPS';

export const onestepgpsRouter = Router();

// Same authorization as the sibling integrations: SUPER_ADMIN + ADMIN, ADMIN hard-scoped.
onestepgpsRouter.use(requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'));

function resolveTenantId(req) {
  if (isSuperAdmin(req.user)) {
    const t = req.query?.tenantId || req.body?.tenantId || req.user?.tenantId;
    if (!t) throw new Error('tenantId is required (SUPER_ADMIN must pick one)');
    return String(t);
  }
  return req.user?.tenantId;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function send400(res, message) {
  return res.status(400).json({ error: message });
}

// ---------------------------------------------------------------------------
// Credentials + status
// ---------------------------------------------------------------------------

onestepgpsRouter.get('/status', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return send400(res, 'tenantId is required');
  const [status, mappedDevices] = await Promise.all([
    getCredentialStatus(tenantId),
    prisma.vehicleTelematicsDevice.count({
      where: { tenantId, provider: 'ONESTEPGPS', isActive: true },
    }),
  ]);
  // status carries booleans + timestamps only — never the key itself.
  res.json({ ...status, mappedDevices });
}));

onestepgpsRouter.post('/credentials', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return send400(res, 'tenantId is required');
  const apiKey = String(req.body?.apiKey ?? '').trim();
  if (!apiKey) return send400(res, 'apiKey is required');
  const row = await setApiKey(tenantId, apiKey, req.user?.id || null);
  // Audit the set/rotate — fire-and-forget; the key itself is NEVER passed.
  auditFromReq(req, {
    action: AUDIT_ACTIONS.TELEMATICS_KEY_SET,
    targetType: 'TENANT',
    targetId: tenantId,
    metadata: { provider: AUDIT_PROVIDER },
  });
  // The key is NEVER echoed back — the panel re-reads /status.
  res.json({ ok: true, credentialId: row.id, rotatedAt: row.rotatedAt });
}));

onestepgpsRouter.delete('/credentials', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return send400(res, 'tenantId is required');
  const out = await clearApiKey(tenantId);
  auditFromReq(req, {
    action: AUDIT_ACTIONS.TELEMATICS_KEY_CLEAR,
    targetType: 'TENANT',
    targetId: tenantId,
    metadata: { provider: AUDIT_PROVIDER, deleted: out.deleted },
  });
  res.json({ ok: true, deleted: out.deleted });
}));

onestepgpsRouter.post('/test-connection', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return send400(res, 'tenantId is required');
  const out = await testConnection(tenantId);
  // A failed probe is the tenant's configuration problem, not our server's —
  // 200 with ok:false so the panel renders the message instead of a 500 page.
  res.json(out);
}));

// ---------------------------------------------------------------------------
// Devices (live from the provider) + mappings (VehicleTelematicsDevice rows)
// ---------------------------------------------------------------------------

onestepgpsRouter.get('/devices', asyncHandler(async (req, res, next) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return send400(res, 'tenantId is required');
  try {
    const [devices, mappings] = await Promise.all([
      listDevices(tenantId),
      prisma.vehicleTelematicsDevice.findMany({
        where: { tenantId, provider: 'ONESTEPGPS', isActive: true },
        select: { externalDeviceId: true, vehicleId: true },
      }),
    ]);
    const vehicleByExternalId = new Map(mappings.map((m) => [m.externalDeviceId, m.vehicleId]));
    res.json({
      devices: devices.map((d) => ({
        ...d,
        mappedVehicleId: vehicleByExternalId.get(d.externalDeviceId) || null,
      })),
    });
  } catch (err) {
    if (err instanceof OneStepGpsAuthError) {
      return send400(res, 'No OneStepGPS API key is stored for this tenant. Save one first.');
    }
    next(err);
  }
}));

onestepgpsRouter.get('/device-mappings', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return send400(res, 'tenantId is required');
  const rows = await prisma.vehicleTelematicsDevice.findMany({
    where: { tenantId, provider: 'ONESTEPGPS' },
    orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
    select: {
      id: true, vehicleId: true, externalDeviceId: true, label: true,
      isActive: true, lastSeenAt: true, createdAt: true,
      vehicle: { select: { plate: true, make: true, model: true } },
    },
  });
  res.json({ mappings: rows });
}));

onestepgpsRouter.post('/device-mappings', asyncHandler(async (req, res, next) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return send400(res, 'tenantId is required');
  const vehicleId = String(req.body?.vehicleId ?? '').trim();
  const externalDeviceId = String(req.body?.externalDeviceId ?? '').trim();
  if (!vehicleId) return send400(res, 'vehicleId is required');
  if (!externalDeviceId) return send400(res, 'externalDeviceId is required');
  try {
    // Same service path as POST /api/vehicles/:id/telematics/devices: verifies
    // the vehicle belongs to the tenant, upserts on (provider, externalDeviceId).
    const row = await vehiclesService.registerTelematicsDevice(vehicleId, {
      provider: 'ONESTEPGPS',
      externalDeviceId,
      label: req.body?.label,
      isActive: true,
    }, { tenantId, allowCrossTenant: false });
    logger.info('[onestepgps] device mapping saved', { tenantId, vehicleId, externalDeviceId });
    auditFromReq(req, {
      action: AUDIT_ACTIONS.TELEMATICS_MAPPING_CREATE,
      targetType: 'VEHICLE',
      targetId: vehicleId,
      metadata: { provider: AUDIT_PROVIDER, vehicleId, externalDeviceId, mappingId: row.id },
    });
    res.json({ ok: true, mapping: row });
  } catch (err) {
    if (/Vehicle not found/i.test(String(err?.message || ''))) {
      // FAILURE trail (mirrors the LOGIN_FAILURE pattern): a mapping attempt
      // against a vehicle outside the tenant is exactly what an auditor wants.
      auditFromReq(req, {
        action: AUDIT_ACTIONS.TELEMATICS_MAPPING_CREATE,
        outcome: AUDIT_OUTCOME.FAILURE,
        targetType: 'VEHICLE',
        targetId: vehicleId,
        metadata: { provider: AUDIT_PROVIDER, vehicleId, externalDeviceId, reason: 'VEHICLE_NOT_FOUND' },
      });
      return res.status(404).json({ error: 'Vehicle not found in this tenant' });
    }
    next(err);
  }
}));

onestepgpsRouter.delete('/device-mappings/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return send400(res, 'tenantId is required');
  // Deactivate, not delete: VehicleTelematicsEvent rows keep their device FK,
  // and the fast poll only reads isActive: true.
  const mappingId = String(req.params.id || '');
  const out = await prisma.vehicleTelematicsDevice.updateMany({
    where: { id: mappingId, tenantId, provider: 'ONESTEPGPS' },
    data: { isActive: false },
  });
  if (!out.count) {
    auditFromReq(req, {
      action: AUDIT_ACTIONS.TELEMATICS_MAPPING_DEACTIVATE,
      outcome: AUDIT_OUTCOME.FAILURE,
      targetType: 'VEHICLE_TELEMATICS_DEVICE',
      targetId: mappingId,
      metadata: { provider: AUDIT_PROVIDER, mappingId, reason: 'MAPPING_NOT_FOUND' },
    });
    return res.status(404).json({ error: 'Mapping not found' });
  }
  auditFromReq(req, {
    action: AUDIT_ACTIONS.TELEMATICS_MAPPING_DEACTIVATE,
    targetType: 'VEHICLE_TELEMATICS_DEVICE',
    targetId: mappingId,
    metadata: { provider: AUDIT_PROVIDER, mappingId },
  });
  res.json({ ok: true });
}));
