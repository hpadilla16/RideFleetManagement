/**
 * Admin routes for the Economy (RezLight) franchise integration (Fase 5).
 *
 * Mounted at `/api/admin/integrations/economy` — the SAME shape TL International
 * is mounted at `/api/admin/integrations/tl-international` (tenantRateLimit +
 * router). Every route requires `requireAuth + requireRole('SUPER_ADMIN',
 * 'ADMIN')`; ADMIN is hard-scoped to their own tenant via resolveTenantId
 * (non-super branch returns req.user.tenantId — cannot cross-tenant query),
 * byte-identical to TL.
 *
 * Master enable/disable is stored where TL stores its per-tenant config:
 * `Tenant.integrationConfig` (Json) — specifically `integrationConfig.economy.enabled`.
 * Additive (no migration). Credentials are ONE {username,password} blob per
 * tenant in IntegrationCredential (unique (tenantId, sourceSystem='ECONOMY')),
 * encrypted with lib/integration-crypto (AES-256-GCM). The password is NEVER
 * logged or returned.
 *
 * Endpoint inventory:
 *   GET   /status                                  → panel health summary
 *   PUT   /enabled              { enabled }        → master enable/disable (tenant)
 *   POST  /credentials          { username, password } → set/rotate creds (encrypted)
 *   POST  /test-auth                               → live auth probe (economy.service.testAuth)
 *   POST  /run-now                                 → enqueue a one-off economy.sync job
 *   GET   /runs?limit=                             → recent ExternalSyncRun rows
 *   GET   /locations                               → EconomyLocationConfig rows (+ Ride location)
 *   POST  /locations            { externalArea, locationId, enabled?, lookbackDays?, lookaheadDays? }
 *   PUT   /locations/:id        { locationId?, enabled?, lookbackDays?, lookaheadDays? }
 *   POST  /locations/:id/toggle { enabled }        → toggle a single area on/off
 *   DELETE /locations/:id                          → remove an area config
 *   GET   /pending-imports                         → MANUAL_REVIEW / PENDING tray (source ECONOMY)
 *   POST  /pending-imports/:id/promote             → manual promote
 *   POST  /pending-imports/:id/reject              → reject
 *
 * Feature-flag posture (mirrors TL): the routes ALWAYS exist and config is
 * ALWAYS editable, exactly like TL, whose routes never gate on
 * TL_INTEGRATION_ENABLED. The autonomous scheduler is what
 * ECONOMY_INTEGRATION_ENABLED gates (in economy.scheduler.js) — flipping the
 * flag off keeps the panel usable but the cron dark. run-now still enqueues (it
 * needs REDIS_URL, same 503 as TL when the queue is disabled); the /status
 * response surfaces `integrationEnabled` so the panel can note "disabled".
 */

import { Router } from 'express';
import { requireAuth, requireRole, isSuperAdmin } from '../../../middleware/auth.js';
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import {
  setCredentials,
  testAuth,
  SOURCE_SYSTEM,
} from './economy.service.js';
import {
  enqueueOneOffSync,
  promoteWithMappings,
} from './economy.worker.js';
import { effectiveWindowDays, areaFromLocPickup, timeZoneForArea } from './economy.constants.js';
import { integrationEnabled } from './economy.scheduler.js';

export const economyRouter = Router();

// Same authorization as TL: SUPER_ADMIN + ADMIN, ADMIN hard-scoped by resolveTenantId.
economyRouter.use(requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'));

// ---------------------------------------------------------------------------
// Helpers (cloned from tl-international.routes.js)
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

// Master enable flag lives in Tenant.integrationConfig.economy.enabled (JSON,
// additive — same seam TL uses for per-tenant config). Default false → dark.
async function readMasterEnabled(tenantId) {
  if (!tenantId) return false;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { integrationConfig: true },
  });
  const cfg = tenant?.integrationConfig;
  return !!(cfg && typeof cfg === 'object' && cfg.economy && cfg.economy.enabled === true);
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
    economy: { ...(base.economy && typeof base.economy === 'object' ? base.economy : {}), enabled: !!enabled },
  };
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { integrationConfig: next },
  });
  return !!enabled;
}

// Estimate the next scheduled run from the last run + the cron cadence, but only
// when the autonomous integration flag is on (else there is no cron).
function estimateNextRunAt(lastRun) {
  if (!integrationEnabled()) return null;
  const minutes = Number(process.env.ECONOMY_SYNC_INTERVAL_MINUTES || 15);
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

async function assertLocationInTenant(tenantId, locationId) {
  const loc = await prisma.location.findFirst({
    where: { id: locationId, tenantId },
    select: { id: true },
  });
  return !!loc;
}

// ---------------------------------------------------------------------------
// GET /status — health summary for EconomyIntegrationPanel
// ---------------------------------------------------------------------------

economyRouter.get('/status', asyncHandler(async (req, res) => {
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
    prisma.economyLocationConfig.findMany({
      where: { tenantId },
      orderBy: { externalArea: 'asc' },
      select: {
        id: true, externalArea: true, locationId: true, enabled: true,
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

economyRouter.put('/enabled', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return send400(res, 'enabled (boolean) is required');
  const next = await writeMasterEnabled(tenantId, enabled);
  logger.info('[economy-routes] master enable toggled', { tenantId, enabled: next, userId: req.user?.id });
  res.json({ ok: true, masterEnabled: next });
}));

// ---------------------------------------------------------------------------
// POST /credentials — set/rotate {username, password} (encrypted at rest)
// The password is NEVER logged or returned.
// ---------------------------------------------------------------------------

economyRouter.post('/credentials', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password ?? '');
  if (!username) return send400(res, 'username is required');
  if (!password) return send400(res, 'password is required');

  const row = await setCredentials(tenantId, { username, password }, req.user?.id || null);
  // NOTE: never echo the password back. Return presence + rotation only.
  logger.info('[economy-routes] credentials set', { tenantId, credentialId: row.id, userId: req.user?.id });
  res.json({ ok: true, credentialId: row.id, rotatedAt: row.rotatedAt });
}));

// ---------------------------------------------------------------------------
// POST /test-auth — live auth probe
// ---------------------------------------------------------------------------

economyRouter.post('/test-auth', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const result = await testAuth(tenantId);
  res.json(result);
}));

// ---------------------------------------------------------------------------
// POST /run-now — enqueue a one-off sync (mirrors TL: 503 when queue disabled)
// ---------------------------------------------------------------------------

economyRouter.post('/run-now', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  // Guard: the per-tenant master switch must be ON to run a sync. This mirrors
  // the scheduler gate (enumerateActiveTenants) so a manual run can't bypass a
  // tenant that has deliberately disabled the integration. The
  // ECONOMY_INTEGRATION_ENABLED env flag remains the global gate for the cron.
  if (!(await readMasterEnabled(tenantId))) {
    return res.status(409).json({ error: 'Integration is disabled for this tenant. Enable it before running a sync.' });
  }
  const jobId = await enqueueOneOffSync(tenantId, `manual:${req.user?.id || 'unknown'}`);
  if (!jobId) {
    return res.status(503).json({ error: 'Queue disabled (REDIS_URL unset)' });
  }
  logger.info('[economy-routes] manual sync enqueued', { tenantId, jobId, userId: req.user?.id });
  res.json({ ok: true, jobId, tenantId });
}));

// ---------------------------------------------------------------------------
// GET /runs?limit= — recent sync runs
// ---------------------------------------------------------------------------

economyRouter.get('/runs', asyncHandler(async (req, res) => {
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
// EconomyLocationConfig CRUD — "which reservations to watch"
// ---------------------------------------------------------------------------

// GET /locations — list config rows joined with the Ride location name.
economyRouter.get('/locations', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  if (!tenantId) return res.json({ rows: [] });
  const rows = await prisma.economyLocationConfig.findMany({
    where: { tenantId },
    orderBy: { externalArea: 'asc' },
    select: {
      id: true, externalArea: true, locationId: true, enabled: true,
      lookbackDays: true, lookaheadDays: true, createdAt: true,
    },
  });
  // Attach location name/code for display (best-effort; missing loc → null).
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

// POST /locations — create an area config.
economyRouter.post('/locations', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const externalArea = String(req.body?.externalArea || '').trim().toUpperCase();
  const locationId = String(req.body?.locationId || '').trim();
  const enabled = req.body?.enabled === undefined ? true : !!req.body.enabled;

  if (!/^[A-Z]{3}$/.test(externalArea)) {
    return send400(res, 'externalArea must be a 3-letter code (e.g. MIA)');
  }
  if (!locationId) return send400(res, 'locationId is required');
  if (!(await assertLocationInTenant(tenantId, locationId))) {
    return send400(res, 'locationId does not belong to this tenant');
  }

  const lookbackDays = normalizeDaysInput(req.body?.lookbackDays);
  const lookaheadDays = normalizeDaysInput(req.body?.lookaheadDays);
  if (Number.isNaN(lookbackDays)) return send400(res, 'lookbackDays must be 0-3650 or null');
  if (Number.isNaN(lookaheadDays)) return send400(res, 'lookaheadDays must be 0-3650 or null');

  // Guard against the unique (tenantId, externalArea) collision with a clean 409.
  const existing = await prisma.economyLocationConfig.findUnique({
    where: { tenantId_externalArea: { tenantId, externalArea } },
    select: { id: true },
  });
  if (existing) {
    return res.status(409).json({ error: `Area ${externalArea} already configured`, id: existing.id });
  }

  const row = await prisma.economyLocationConfig.create({
    data: {
      tenantId,
      externalArea,
      locationId,
      enabled,
      lookbackDays: lookbackDays === undefined ? null : lookbackDays,
      lookaheadDays: lookaheadDays === undefined ? null : lookaheadDays,
    },
  });
  logger.info('[economy-routes] area config created', { tenantId, externalArea, id: row.id });
  res.json({ ok: true, row });
}));

// PUT /locations/:id — update mapping / window / enabled.
economyRouter.put('/locations/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;

  const owned = await prisma.economyLocationConfig.findFirst({
    where: { id, tenantId },
    select: { id: true },
  });
  if (!owned) return res.status(404).json({ error: 'Area config not found' });

  const data = {};
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

  const row = await prisma.economyLocationConfig.update({ where: { id }, data });
  res.json({ ok: true, row });
}));

// POST /locations/:id/toggle — flip enabled on a single area.
economyRouter.post('/locations/:id/toggle', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  if (typeof req.body?.enabled !== 'boolean') return send400(res, 'enabled (boolean) is required');

  const updated = await prisma.economyLocationConfig.updateMany({
    where: { id, tenantId },
    data: { enabled: !!req.body.enabled },
  });
  if (!updated.count) return res.status(404).json({ error: 'Area config not found' });
  res.json({ ok: true, enabled: !!req.body.enabled });
}));

// DELETE /locations/:id
economyRouter.delete('/locations/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  const deleted = await prisma.economyLocationConfig.deleteMany({ where: { id, tenantId } });
  if (!deleted.count) return res.status(404).json({ error: 'Area config not found' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// GET /pending-imports — MANUAL_REVIEW + PENDING tray (source ECONOMY)
// ---------------------------------------------------------------------------

economyRouter.get('/pending-imports', asyncHandler(async (req, res) => {
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
    },
  });
  res.json({ rows, count: rows.length });
}));

// ---------------------------------------------------------------------------
// POST /pending-imports/:id/promote — manual promotion (source ECONOMY)
// ---------------------------------------------------------------------------

economyRouter.post('/pending-imports/:id/promote', asyncHandler(async (req, res) => {
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
    const { evaluatePromotion } = await import('../tl-international/promotion-matcher.service.js');
    // Economy's authoritative location is EconomyLocationConfig for the row's
    // area — pass it as overrideLocationId so the shared matcher skips the
    // LocationCodeMap gate (same posture as the worker's auto path).
    const area = areaFromLocPickup(extRes.pickupLocation);
    const cfg = area
      ? await prisma.economyLocationConfig.findUnique({
        where: { tenantId_externalArea: { tenantId, externalArea: area } },
        select: { locationId: true, enabled: true },
      })
      : null;
    const overrideLocationId = cfg?.enabled ? cfg.locationId : undefined;
    const decision = await evaluatePromotion(extRes, { prisma, overrideLocationId });
    if (decision.decision === 'AUTO') {
      resolvedCustomerId = resolvedCustomerId || decision.mappedCustomer?.id || null;
      resolvedLocationId = resolvedLocationId || overrideLocationId || decision.mappedLocation?.id || null;
      resolvedCategory = resolvedCategory || decision.mappedVehicleCategory || null;
    } else {
      resolvedLocationId = resolvedLocationId || overrideLocationId || null;
    }
  }

  if (!resolvedCustomerId) return send400(res, 'customerId is required (no auto-match)');
  if (!resolvedLocationId) return send400(res, 'locationIdOverride is required (no auto-mapped location)');

  // Resolve the per-area timezone from the row's pickup location (first 3 chars →
  // area → IANA zone) and pass it through, matching the auto worker path. Without
  // this a LAX manual promote would default to America/New_York; with it the
  // duplicate detector truncates pickup days against the operator's wall clock.
  const timeZone = timeZoneForArea(areaFromLocPickup(extRes.pickupLocation));

  const result = await promoteWithMappings(extRes, {
    customerId: resolvedCustomerId,
    locationId: resolvedLocationId,
    vehicleCategory: resolvedCategory,
    timeZone,
    promotedByUserId: req.user?.id || null,
    isAuto: false,
  });
  res.json({ ok: true, ...result });
}));

// ---------------------------------------------------------------------------
// POST /pending-imports/:id/reject
// ---------------------------------------------------------------------------

economyRouter.post('/pending-imports/:id/reject', asyncHandler(async (req, res) => {
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

export default economyRouter;
