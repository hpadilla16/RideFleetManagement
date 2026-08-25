/**
 * Shuttle zones + alert-recipients admin routes (Phase 2, 2026-08-24;
 * approved mockup Screen 4). Mounted at /api/shuttle-zones.
 *
 * SECURITY GATE: requireAuth + requireRole('SUPER_ADMIN','ADMIN') on the
 * whole router — zone geometry decides what fires customer-facing
 * notifications, so it sits at the connector tier (same as the OneStepGPS
 * panel), NOT the wider OPS tier of the tracker config. ADMIN is hard-scoped
 * to their own tenant via resolveTenantId; SUPER_ADMIN picks one explicitly.
 * Every mutation records an AdminAuditLog row (ZONE_CREATE/UPDATE/DELETE,
 * ALERT_RECIPIENTS_CHANGE) — best-effort, fire-and-forget, house pattern.
 *
 * NO public surface here. The only public artifact of this feature is the
 * arrival fields inside the existing token-gated tracker payload (whitelist
 * pinned in shuttle-tracker-position.test.mjs).
 */
import { Router } from 'express';
import { requireAuth, requireRole, isSuperAdmin } from '../../middleware/auth.js';
import { shuttleZonesService } from './shuttle-zones.service.js';
import { auditFromReq, AUDIT_ACTIONS, AUDIT_OUTCOME } from '../audit/audit.service.js';

const AUDIT_PROVIDER = 'ONESTEPGPS';

export const shuttleZonesRouter = Router();
shuttleZonesRouter.use(requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'));

function resolveTenantId(req) {
  if (isSuperAdmin(req.user)) {
    const t = req.query?.tenantId || req.body?.tenantId || req.user?.tenantId;
    if (!t) throw Object.assign(new Error('tenantId is required (SUPER_ADMIN must pick one)'), { status: 400 });
    return String(t);
  }
  return req.user?.tenantId;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

shuttleZonesRouter.get('/', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
  const locationId = String(req.query?.locationId || '').trim() || null;
  res.json({ zones: await shuttleZonesService.list({ tenantId, locationId }) });
}));

shuttleZonesRouter.post('/', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
  const zone = await shuttleZonesService.create({
    tenantId,
    locationId: req.body?.locationId,
    body: req.body || {},
  });
  auditFromReq(req, {
    action: AUDIT_ACTIONS.ZONE_CREATE,
    tenantId,
    targetType: 'SHUTTLE_ZONE',
    targetId: zone.id,
    metadata: {
      provider: AUDIT_PROVIDER, locationId: zone.locationId, name: zone.name,
      kind: zone.kind, isPickupSpot: zone.isPickupSpot,
    },
  });
  res.json({ ok: true, zone });
}));

// ── Per-location staff alert recipients (Screen 4 "Who gets alerted") ───────

shuttleZonesRouter.get('/recipients', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
  const locationId = String(req.query?.locationId || '').trim();
  if (!locationId) return res.status(400).json({ error: 'locationId is required' });
  res.json(await shuttleZonesService.getRecipients({ tenantId, locationId }));
}));

shuttleZonesRouter.put('/recipients', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
  const out = await shuttleZonesService.setRecipients({
    tenantId,
    locationId: req.body?.locationId,
    recipients: req.body?.recipients,
  });
  auditFromReq(req, {
    action: AUDIT_ACTIONS.ALERT_RECIPIENTS_CHANGE,
    tenantId,
    targetType: 'LOCATION',
    targetId: out.locationId,
    // Counts + channels only: the recipients' emails/phones are staff PII the
    // audit row does not need (redactSensitive would mask them anyway).
    metadata: {
      provider: AUDIT_PROVIDER,
      recipientCount: out.recipients.length,
      channels: [...new Set(out.recipients.flatMap((r) => r.channels))],
    },
  });
  res.json(out);
}));

// NOTE: the literal /recipients routes are registered BEFORE the /:id params
// — Express matches in order, and PUT /recipients must never be swallowed by
// PUT /:id with id='recipients'.
shuttleZonesRouter.put('/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
  const zoneId = String(req.params.id || '');
  try {
    const zone = await shuttleZonesService.update({ tenantId, zoneId, body: req.body || {} });
    auditFromReq(req, {
      action: AUDIT_ACTIONS.ZONE_UPDATE,
      tenantId,
      targetType: 'SHUTTLE_ZONE',
      targetId: zoneId,
      metadata: { provider: AUDIT_PROVIDER, name: zone.name, kind: zone.kind, active: zone.active },
    });
    res.json({ ok: true, zone });
  } catch (err) {
    if (err.status === 404) {
      // FAILURE trail (mirrors the mapping-create pattern): an update aimed at
      // a zone outside the tenant is exactly what an auditor wants to see.
      auditFromReq(req, {
        action: AUDIT_ACTIONS.ZONE_UPDATE,
        outcome: AUDIT_OUTCOME.FAILURE,
        tenantId,
        targetType: 'SHUTTLE_ZONE',
        targetId: zoneId,
        metadata: { provider: AUDIT_PROVIDER, reason: 'ZONE_NOT_FOUND' },
      });
    }
    throw err;
  }
}));

shuttleZonesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
  const zoneId = String(req.params.id || '');
  try {
    await shuttleZonesService.remove({ tenantId, zoneId });
  } catch (err) {
    if (err.status === 404) {
      auditFromReq(req, {
        action: AUDIT_ACTIONS.ZONE_DELETE,
        outcome: AUDIT_OUTCOME.FAILURE,
        tenantId,
        targetType: 'SHUTTLE_ZONE',
        targetId: zoneId,
        metadata: { provider: AUDIT_PROVIDER, reason: 'ZONE_NOT_FOUND' },
      });
    }
    throw err;
  }
  auditFromReq(req, {
    action: AUDIT_ACTIONS.ZONE_DELETE,
    tenantId,
    targetType: 'SHUTTLE_ZONE',
    targetId: zoneId,
    metadata: { provider: AUDIT_PROVIDER },
  });
  res.json({ ok: true });
}));
