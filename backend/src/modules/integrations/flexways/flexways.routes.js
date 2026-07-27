/**
 * Admin routes for the Flexways (MobilityPS) franchise integration (Fase 5).
 * A sibling of nu.routes.js — same auth guard, same tenant-scoping, same
 * feature-flag posture — adapted for Flexways' KEY DIFFERENCE: it is MULTI-SEDE.
 * A tenant maps N portal sedes (idSede) → N Ride locations, so the config is a
 * per-sede table (Economy's multi-row shape), NOT NU's single 1:1 row. There is
 * therefore NO "one active location" invariant; the identity key is idSede.
 *
 * Mounted at `/api/admin/integrations/flexways` (tenantRateLimit + router). Every
 * route requires requireAuth + requireRole('SUPER_ADMIN','ADMIN'); ADMIN is
 * hard-scoped to their own tenant via resolveTenantId (non-super branch returns
 * req.user.tenantId — cannot cross-tenant query).
 *
 * Master enable/disable lives in Tenant.integrationConfig.flexways.enabled (Json,
 * additive). Credentials are ONE {username,password} blob per tenant in
 * IntegrationCredential (unique (tenantId, sourceSystem='FLEXWAYS')), encrypted
 * with lib/integration-crypto (AES-256-GCM). The password is NEVER logged/returned.
 *
 * Endpoint inventory:
 *   GET   /status                                  → panel health summary
 *   PUT   /enabled              { enabled }        → master enable/disable (tenant)
 *   POST  /credentials          { username, password } → set/rotate creds (encrypted)
 *   POST  /test-auth            { idSede? }        → live auto-login probe
 *   POST  /force-relogin        { idSede? }        → emergency discard-jar + re-login
 *   POST  /run-now                                 → enqueue a one-off flexways.sync job
 *   GET   /runs?limit=                             → recent ExternalSyncRun rows
 *   GET   /locations                               → FlexwaysLocationConfig rows (+ Ride location)
 *   POST  /locations            { idSede, locationId, enabled?, lookbackDays?, lookaheadDays? }
 *   PUT   /locations/:id        { idSede?, locationId?, enabled?, lookbackDays?, lookaheadDays? }
 *   POST  /locations/:id/toggle { enabled }        → toggle the sede on/off
 *   DELETE /locations/:id                          → remove the sede mapping
 *   GET   /pending-imports                         → MANUAL_REVIEW / PENDING tray (source FLEXWAYS)
 *   POST  /pending-imports/:id/promote             → manual promote (source FLEXWAYS)
 *   POST  /pending-imports/:id/reject              → reject
 *
 * Feature-flag posture (mirror TL/Economy/NU): routes ALWAYS exist and config is
 * ALWAYS editable. FLEXWAYS_INTEGRATION_ENABLED gates only the autonomous
 * scheduler — flipping it off keeps the panel usable but the cron dark.
 */

import { Router } from 'express';
import { filterExternalRowsByLocationScope } from '../booking-source/pending-import-scope.js';
import { userAllowedLocationIds } from '../../../lib/tenant-scope.js';
import { requireAuth, requireRole, isSuperAdmin } from '../../../middleware/auth.js';
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import {
  setCredentials,
  testAuth,
  forceRelogin,
  SOURCE_SYSTEM,
} from './flexways.service.js';
import { enqueueOneOffSync, promoteWithMappings } from './flexways.worker.js';
import { effectiveWindowDays, TIME_ZONE } from './flexways.constants.js';
import { integrationEnabled } from './flexways.scheduler.js';

export const flexwaysRouter = Router();

// Same authorization as TL/Economy/NU: SUPER_ADMIN + ADMIN, ADMIN hard-scoped.
flexwaysRouter.use(requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'));

// ---------------------------------------------------------------------------
// Helpers (cloned from nu.routes.js)
// ---------------------------------------------------------------------------

function resolveTenantId(req) {
  if (isSuperAdmin(req.user)) {
    const t = req.query?.tenantId || req.body?.tenantId || req.user?.tenantId;
    if (!t) throw new Error('tenantId is required (SUPER_ADMIN must pick one)');
    return String(t);
  }
  return req.user?.tenantId;
}

function resolveTenantIdOrNull(req) {
  try { return resolveTenantId(req); } catch { return null; }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function send400(res, message) {
  return res.status(400).json({ error: message });
}

// Master enable flag lives in Tenant.integrationConfig.flexways.enabled (JSON,
// additive). Default false → dark.
async function readMasterEnabled(tenantId) {
  if (!tenantId) return false;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { integrationConfig: true },
  });
  const cfg = tenant?.integrationConfig;
  return !!(cfg && typeof cfg === 'object' && cfg.flexways && cfg.flexways.enabled === true);
}

async function writeMasterEnabled(tenantId, enabled) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { integrationConfig: true },
  });
  const base = (tenant?.integrationConfig && typeof tenant.integrationConfig === 'object')
    ? tenant.integrationConfig
    : {};
  const next = {
    ...base,
    flexways: {
      ...(base.flexways && typeof base.flexways === 'object' ? base.flexways : {}),
      enabled: !!enabled,
    },
  };
  await prisma.tenant.update({ where: { id: tenantId }, data: { integrationConfig: next } });
  return !!enabled;
}

function estimateNextRunAt(lastRun) {
  if (!integrationEnabled()) return null;
  const minutes = Number(process.env.FLEXWAYS_SYNC_INTERVAL_MINUTES || 15);
  const cadenceMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;
  const base = lastRun?.finishedAt || lastRun?.startedAt;
  const from = base ? new Date(base).getTime() : Date.now();
  return new Date(from + cadenceMs);
}

function normalizeDaysInput(v) {
  if (v === undefined) return undefined;   // leave untouched
  if (v === null || v === '') return null; // explicit clear → env fallback
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 3650) return NaN; // invalid sentinel
  return Math.floor(n);
}

// Portal sede id (e.g. "383"). Required identity for a Flexways config row.
function normalizeSedeInput(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return String(v).trim().slice(0, 32) || null;
}

async function assertLocationInTenant(tenantId, locationId) {
  const loc = await prisma.location.findFirst({
    where: { id: locationId, tenantId },
    select: { id: true },
  });
  return !!loc;
}

// ---------------------------------------------------------------------------
// GET /status — health summary for the Flexways panel
// ---------------------------------------------------------------------------

flexwaysRouter.get('/status', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  if (!tenantId) {
    return res.json({ configured: false, tenantId: null, integrationEnabled: integrationEnabled() });
  }

  const [credential, lastRun, configs, masterEnabled] = await Promise.all([
    prisma.integrationCredential.findUnique({
      where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
      select: {
        id: true,
        rotatedAt: true,
        lastTestedAt: true,
        lastTestStatus: true,
        // encryptedPayload intentionally NOT selected — presence only.
      },
    }),
    prisma.externalSyncRun.findFirst({
      where: { tenantId, sourceSystem: SOURCE_SYSTEM },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true, status: true, startedAt: true, finishedAt: true,
        pickupsFound: true, newlyInserted: true, autoPromoted: true, needsReview: true,
      },
    }),
    prisma.flexwaysLocationConfig.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, idSede: true, locationId: true, enabled: true,
        lookbackDays: true, lookaheadDays: true, createdAt: true,
      },
    }),
    readMasterEnabled(tenantId),
  ]);

  res.json({
    configured: !!credential,
    tenantId,
    integrationEnabled: integrationEnabled(), // env flag (autonomous cron)
    masterEnabled,                            // per-tenant master switch
    credential: credential
      ? {
        rotatedAt: credential.rotatedAt || null,
        lastTestedAt: credential.lastTestedAt || null,
        lastTestStatus: credential.lastTestStatus || null,
      }
      : null,
    locations: configs,
    lastRun: lastRun || null,
    nextRunAt: estimateNextRunAt(lastRun),
  });
}));

// ---------------------------------------------------------------------------
// PUT /enabled — master enable/disable for this tenant
// ---------------------------------------------------------------------------

flexwaysRouter.put('/enabled', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return send400(res, 'enabled (boolean) is required');
  const next = await writeMasterEnabled(tenantId, enabled);
  logger.info('[flexways-routes] master enable toggled', { tenantId, enabled: next, userId: req.user?.id });
  res.json({ ok: true, masterEnabled: next });
}));

// ---------------------------------------------------------------------------
// POST /credentials — set/rotate {username, password} (encrypted at rest)
// The password is NEVER logged or returned.
// ---------------------------------------------------------------------------

flexwaysRouter.post('/credentials', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password ?? '');
  if (!username) return send400(res, 'username is required');
  if (!password) return send400(res, 'password is required');

  const row = await setCredentials(tenantId, { username, password }, req.user?.id || null);
  logger.info('[flexways-routes] credentials set', { tenantId, credentialId: row.id, userId: req.user?.id });
  res.json({ ok: true, credentialId: row.id, rotatedAt: row.rotatedAt });
}));

// ---------------------------------------------------------------------------
// POST /test-auth — live auto-login probe (optionally against a specific sede)
// ---------------------------------------------------------------------------

flexwaysRouter.post('/test-auth', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const idSede = req.body?.idSede ? String(req.body.idSede).trim() : null;
  const result = await testAuth(tenantId, { idSede });
  res.json(result);
}));

// ---------------------------------------------------------------------------
// POST /force-relogin — emergency: discard the session jar + re-login now.
// The worker re-authenticates on its own; this is the manual fallback.
// ---------------------------------------------------------------------------

flexwaysRouter.post('/force-relogin', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  try {
    const result = await forceRelogin(tenantId);
    logger.info('[flexways-routes] force re-login', { tenantId, userId: req.user?.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ ok: false, status: 'ERROR', message: err.message });
  }
}));

// ---------------------------------------------------------------------------
// POST /run-now — enqueue a one-off sync (409 when master switch off, 503 when
// queue disabled)
// ---------------------------------------------------------------------------

flexwaysRouter.post('/run-now', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!(await readMasterEnabled(tenantId))) {
    return res.status(409).json({ error: 'Integration is disabled for this tenant. Enable it before running a sync.' });
  }
  const jobId = await enqueueOneOffSync(tenantId, `manual:${req.user?.id || 'unknown'}`);
  if (!jobId) {
    return res.status(503).json({ error: 'Queue disabled (REDIS_URL unset)' });
  }
  logger.info('[flexways-routes] manual sync enqueued', { tenantId, jobId, userId: req.user?.id });
  res.json({ ok: true, jobId, tenantId });
}));

// ---------------------------------------------------------------------------
// GET /runs?limit= — recent sync runs
// ---------------------------------------------------------------------------

flexwaysRouter.get('/runs', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  const limit = Math.min(Math.max(parseInt(req.query?.limit || '50', 10), 1), 200);
  const where = tenantId
    ? { tenantId, sourceSystem: SOURCE_SYSTEM }
    : { sourceSystem: SOURCE_SYSTEM };
  const runs = await prisma.externalSyncRun.findMany({
    where,
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
  res.json({ runs });
}));

// ---------------------------------------------------------------------------
// FlexwaysLocationConfig CRUD — the per-sede mapping (idSede → Ride location).
// MULTI-SEDE: N rows per tenant, identity key idSede, NO 1:1 invariant.
// ---------------------------------------------------------------------------

// GET /locations — list sede configs joined with the Ride location name.
flexwaysRouter.get('/locations', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  if (!tenantId) return res.json({ rows: [] });
  const rows = await prisma.flexwaysLocationConfig.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, idSede: true, locationId: true, enabled: true,
      lookbackDays: true, lookaheadDays: true, createdAt: true,
    },
  });
  const locIds = Array.from(new Set(rows.map((r) => r.locationId).filter(Boolean)));
  const locs = locIds.length
    ? await prisma.location.findMany({
      where: { id: { in: locIds }, tenantId },
      select: { id: true, name: true, code: true },
    })
    : [];
  const locById = new Map(locs.map((l) => [l.id, l]));
  res.json({
    rows: rows.map((r) => ({
      ...r,
      location: locById.get(r.locationId) || null,
      effectiveWindow: effectiveWindowDays(r),
    })),
  });
}));

// POST /locations — add a sede mapping (idSede → Ride location).
flexwaysRouter.post('/locations', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const idSede = normalizeSedeInput(req.body?.idSede);
  const locationId = String(req.body?.locationId || '').trim();
  const enabled = req.body?.enabled === undefined ? true : !!req.body.enabled;

  if (!idSede) return send400(res, 'idSede is required');
  if (!locationId) return send400(res, 'locationId is required');
  if (!(await assertLocationInTenant(tenantId, locationId))) {
    return send400(res, 'locationId does not belong to this tenant');
  }

  const lookbackDays = normalizeDaysInput(req.body?.lookbackDays);
  const lookaheadDays = normalizeDaysInput(req.body?.lookaheadDays);
  if (Number.isNaN(lookbackDays)) return send400(res, 'lookbackDays must be 0-3650 or null');
  if (Number.isNaN(lookaheadDays)) return send400(res, 'lookaheadDays must be 0-3650 or null');

  // Guard the unique (tenantId, idSede) collision with a clean 409.
  const existing = await prisma.flexwaysLocationConfig.findUnique({
    where: { tenantId_idSede: { tenantId, idSede } },
    select: { id: true },
  });
  if (existing) {
    return res.status(409).json({ error: 'This sede (idSede) is already mapped', id: existing.id });
  }

  const row = await prisma.flexwaysLocationConfig.create({
    data: {
      tenantId,
      idSede,
      locationId,
      enabled,
      lookbackDays: lookbackDays === undefined ? null : lookbackDays,
      lookaheadDays: lookaheadDays === undefined ? null : lookaheadDays,
    },
  });
  logger.info('[flexways-routes] sede mapping created', { tenantId, idSede, locationId, id: row.id });
  res.json({ ok: true, row });
}));

// PUT /locations/:id — update sede / location / window / enabled.
flexwaysRouter.put('/locations/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;

  const owned = await prisma.flexwaysLocationConfig.findFirst({
    where: { id, tenantId },
    select: { id: true },
  });
  if (!owned) return res.status(404).json({ error: 'Sede mapping not found' });

  const data = {};

  if (req.body?.idSede !== undefined) {
    const idSede = normalizeSedeInput(req.body.idSede);
    if (!idSede) return send400(res, 'idSede cannot be empty');
    const clash = await prisma.flexwaysLocationConfig.findUnique({
      where: { tenantId_idSede: { tenantId, idSede } },
      select: { id: true },
    });
    if (clash && clash.id !== id) {
      return res.status(409).json({ error: 'This sede (idSede) is already mapped', id: clash.id });
    }
    data.idSede = idSede;
  }

  if (req.body?.locationId !== undefined) {
    const locationId = String(req.body.locationId || '').trim();
    if (!locationId) return send400(res, 'locationId cannot be empty');
    if (!(await assertLocationInTenant(tenantId, locationId))) {
      return send400(res, 'locationId does not belong to this tenant');
    }
    data.locationId = locationId;
  }

  if (req.body?.enabled !== undefined) data.enabled = !!req.body.enabled;

  const lookbackDays = normalizeDaysInput(req.body?.lookbackDays);
  const lookaheadDays = normalizeDaysInput(req.body?.lookaheadDays);
  if (Number.isNaN(lookbackDays)) return send400(res, 'lookbackDays must be 0-3650 or null');
  if (Number.isNaN(lookaheadDays)) return send400(res, 'lookaheadDays must be 0-3650 or null');
  if (lookbackDays !== undefined) data.lookbackDays = lookbackDays;
  if (lookaheadDays !== undefined) data.lookaheadDays = lookaheadDays;

  const row = await prisma.flexwaysLocationConfig.update({ where: { id }, data });
  res.json({ ok: true, row });
}));

// POST /locations/:id/toggle — flip enabled on the sede.
flexwaysRouter.post('/locations/:id/toggle', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  if (typeof req.body?.enabled !== 'boolean') return send400(res, 'enabled (boolean) is required');
  const nextEnabled = !!req.body.enabled;

  const updated = await prisma.flexwaysLocationConfig.updateMany({
    where: { id, tenantId },
    data: { enabled: nextEnabled },
  });
  if (!updated.count) return res.status(404).json({ error: 'Sede mapping not found' });
  res.json({ ok: true, enabled: nextEnabled });
}));

// DELETE /locations/:id
flexwaysRouter.delete('/locations/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  const deleted = await prisma.flexwaysLocationConfig.deleteMany({ where: { id, tenantId } });
  if (!deleted.count) return res.status(404).json({ error: 'Sede mapping not found' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// GET /pending-imports — MANUAL_REVIEW + PENDING tray (source FLEXWAYS).
// ---------------------------------------------------------------------------

flexwaysRouter.get('/pending-imports', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  const where = {
    sourceSystem: SOURCE_SYSTEM,
    promotionStatus: { in: ['PENDING', 'MANUAL_REVIEW'] },
    ...(tenantId ? { tenantId } : {}),
  };
  const rows = await prisma.externalReservation.findMany({
    where,
    orderBy: [{ pickupAt: 'asc' }, { createdAt: 'desc' }],
    take: 200,
    select: {
      id: true,
      externalRef: true,
      promotionStatus: true,
      needsReviewReason: true,
      pickupAt: true,
      pickupLocation: true,
      dropoffAt: true,
      dropoffLocation: true,
      customerFirstName: true,
      customerLastName: true,
      customerEmail: true,
      customerPhone: true,
      vehicleAcriss: true,
      vehicleDescription: true,
      totalAmount: true,
      currency: true,
      lastSyncedAt: true,
      firstSeenAt: true,
      rawJson: true,
    },
  });
  // Location scoping (2026-07-27): a location-scoped admin only sees pending
  // imports for their own sede(s); unscoped admins see everything.
  const scopedRows = await filterExternalRowsByLocationScope(rows, {
    tenantId,
    allowedLocationIds: userAllowedLocationIds(req.user),
    sourceSystem: SOURCE_SYSTEM,
  });
  const outRows = scopedRows.map(({ rawJson, ...rest }) => rest);
  res.json({ rows: outRows, count: outRows.length });
}));

// ---------------------------------------------------------------------------
// POST /pending-imports/:id/promote — manual promotion (source FLEXWAYS).
//
// Multi-sede: the operator supplies the target Ride location (locationIdOverride)
// — the panel knows the sede→location mapping. If omitted we let the shared
// matcher resolve (LocationCodeMap / customer match); a missing location is a 400,
// same guard as NU. Passing the location as overrideLocationId skips the
// LocationCodeMap gate (same posture as the worker's auto path). FLEXWAYS TZ.
// ---------------------------------------------------------------------------

flexwaysRouter.post('/pending-imports/:id/promote', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  const { customerId, vehicleCategoryOverride, locationIdOverride } = req.body || {};

  const extRes = await prisma.externalReservation.findFirst({
    where: { id, tenantId, sourceSystem: SOURCE_SYSTEM },
  });
  if (!extRes) return res.status(404).json({ error: 'External reservation not found' });
  if (extRes.promotionStatus === 'AUTO_PROMOTED' || extRes.promotionStatus === 'PROMOTED') {
    return res.status(409).json({ error: 'Already promoted', promotedToReservationId: extRes.promotedToReservationId });
  }
  if (extRes.promotionStatus === 'REJECTED') {
    return res.status(409).json({ error: 'This row has been rejected; unreject before promoting' });
  }

  let resolvedCustomerId = customerId || null;
  let resolvedLocationId = locationIdOverride || null;
  let resolvedCategory = vehicleCategoryOverride || null;

  if (!resolvedCustomerId || !resolvedLocationId) {
    const { evaluatePromotion } = await import('../booking-source/promotion-matcher.service.js');
    const overrideLocationId = resolvedLocationId || undefined;
    const decision = await evaluatePromotion(extRes, { prisma, overrideLocationId });
    if (decision.decision === 'AUTO') {
      resolvedCustomerId = resolvedCustomerId || decision.mappedCustomer?.id || null;
      resolvedLocationId = resolvedLocationId || decision.mappedLocation?.id || null;
      resolvedCategory = resolvedCategory || decision.mappedVehicleCategory || null;
    }
  }

  if (!resolvedCustomerId) return send400(res, 'customerId is required (no auto-match)');
  if (!resolvedLocationId) return send400(res, 'locationIdOverride is required (no auto-mapped location)');

  const result = await promoteWithMappings(extRes, {
    customerId: resolvedCustomerId,
    locationId: resolvedLocationId,
    vehicleCategory: resolvedCategory,
    timeZone: TIME_ZONE,
    promotedByUserId: req.user?.id || null,
    isAuto: false,
  });
  res.json({ ok: true, ...result });
}));

// ---------------------------------------------------------------------------
// POST /pending-imports/:id/reject
// ---------------------------------------------------------------------------

flexwaysRouter.post('/pending-imports/:id/reject', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  const { reason } = req.body || {};

  const updated = await prisma.externalReservation.updateMany({
    where: { id, tenantId, sourceSystem: SOURCE_SYSTEM, promotionStatus: { notIn: ['PROMOTED', 'AUTO_PROMOTED'] } },
    data: {
      promotionStatus: 'REJECTED',
      rejectedReason: reason ? String(reason).slice(0, 500) : null,
      rejectedAt: new Date(),
    },
  });
  if (!updated.count) return res.status(404).json({ error: 'Row not found or already promoted' });
  res.json({ ok: true });
}));

export default flexwaysRouter;
