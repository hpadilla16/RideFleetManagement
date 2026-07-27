/**
 * Admin routes for the NU Car Rentals (affiliates portal) franchise integration
 * (Fase 5). A true sibling of economy.routes.js — same auth guard, same
 * tenant-scoping, same feature-flag posture — adapted for NU's KEY DIFFERENCE:
 * NU is location 1:1. One NU affiliate login maps to ONE Ride location, so the
 * config is a SINGLE NuLocationConfig mapping (NU account → one Ride location),
 * NOT Economy's multi-area table.
 *
 * Mounted at `/api/admin/integrations/nu` — the SAME shape TL/Economy are mounted
 * at (tenantRateLimit + router). Every route requires `requireAuth +
 * requireRole('SUPER_ADMIN', 'ADMIN')`; ADMIN is hard-scoped to their own tenant
 * via resolveTenantId (non-super branch returns req.user.tenantId — cannot
 * cross-tenant query), byte-identical to TL/Economy.
 *
 * Master enable/disable is stored where TL/Economy store per-tenant config:
 * `Tenant.integrationConfig` (Json) — specifically `integrationConfig.nu.enabled`.
 * Additive (no migration). Credentials are ONE {username,password} blob per
 * tenant in IntegrationCredential (unique (tenantId, sourceSystem='NU')),
 * encrypted with lib/integration-crypto (AES-256-GCM). The password is NEVER
 * logged or returned.
 *
 * Endpoint inventory (identical shape to Economy):
 *   GET   /status                                  → panel health summary
 *   PUT   /enabled              { enabled }        → master enable/disable (tenant)
 *   POST  /credentials          { username, password } → set/rotate creds (encrypted)
 *   POST  /test-auth                               → live auth probe (nu.service.testAuth)
 *   POST  /run-now                                 → enqueue a one-off nu.sync job
 *   GET   /runs?limit=                             → recent ExternalSyncRun rows
 *   GET   /locations                               → NuLocationConfig rows (+ Ride location)
 *   POST  /locations            { locationId, externalCenter?, enabled?, lookbackDays?, lookaheadDays? }
 *   PUT   /locations/:id        { locationId?, externalCenter?, enabled?, lookbackDays?, lookaheadDays? }
 *   POST  /locations/:id/toggle { enabled }        → toggle the mapping on/off
 *   DELETE /locations/:id                          → remove the mapping
 *   GET   /pending-imports                         → MANUAL_REVIEW / PENDING tray (source NU, + isPrepaid)
 *   POST  /pending-imports/:id/promote             → manual promote (source NU)
 *   POST  /pending-imports/:id/reject              → reject
 *
 * Feature-flag posture (mirrors TL/Economy): the routes ALWAYS exist and config
 * is ALWAYS editable. NU_INTEGRATION_ENABLED gates only the autonomous scheduler
 * (nu.scheduler.js) — flipping the flag off keeps the panel usable but the cron
 * dark. run-now still enqueues (needs REDIS_URL, same 503 as TL when the queue is
 * disabled) and is gated by the per-tenant master switch (409 when disabled); the
 * /status response surfaces `integrationEnabled` so the panel can note "disabled".
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
  SOURCE_SYSTEM,
} from './nu.service.js';
import {
  enqueueOneOffSync,
  promoteWithMappings,
} from './nu.worker.js';
import { effectiveWindowDays, TIME_ZONE } from './nu.constants.js';
import { integrationEnabled } from './nu.scheduler.js';

export const nuRouter = Router();

// Same authorization as TL/Economy: SUPER_ADMIN + ADMIN, ADMIN hard-scoped by
// resolveTenantId.
nuRouter.use(requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'));

// ---------------------------------------------------------------------------
// Helpers (cloned from economy.routes.js)
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

// Master enable flag lives in Tenant.integrationConfig.nu.enabled (JSON,
// additive — same seam TL/Economy use for per-tenant config). Default false → dark.
async function readMasterEnabled(tenantId) {
  if (!tenantId) return false;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { integrationConfig: true },
  });
  const cfg = tenant?.integrationConfig;
  return !!(cfg && typeof cfg === 'object' && cfg.nu && cfg.nu.enabled === true);
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
    nu: { ...(base.nu && typeof base.nu === 'object' ? base.nu : {}), enabled: !!enabled },
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
  const minutes = Number(process.env.NU_SYNC_INTERVAL_MINUTES || 15);
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

// NU portal center code (e.g. "100" = Ft. Lauderdale). Optional metadata for the
// 1:1 case; kept so multi-center NU accounts can be supported later. Blank → null.
function normalizeCenterInput(v) {
  if (v === undefined) return undefined;   // leave untouched
  if (v === null || v === '') return null; // explicit clear
  return String(v).trim().slice(0, 32) || null;
}

async function assertLocationInTenant(tenantId, locationId) {
  const loc = await prisma.location.findFirst({
    where: { id: locationId, tenantId },
    select: { id: true },
  });
  return !!loc;
}

// 1:1 invariant enforced at WRITE time: NU is ONE active location per tenant.
// Returns the first OTHER enabled config row (excluding `exceptId`), or null.
// Callers reject a create/enable that would leave a SECOND enabled row with a
// 409, so the worker + manual-promote paths never face an ambiguous config.
async function findOtherEnabledConfig(tenantId, exceptId = null) {
  return prisma.nuLocationConfig.findFirst({
    where: { tenantId, enabled: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { id: true, locationId: true },
  });
}

const ONE_ACTIVE_LOCATION_MESSAGE =
  'NU is one active location per tenant. Disable the other mapping first.';

// ---------------------------------------------------------------------------
// GET /status — health summary for NuIntegrationPanel
// ---------------------------------------------------------------------------

nuRouter.get('/status', asyncHandler(async (req, res) => {
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
    prisma.nuLocationConfig.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, externalCenter: true, locationId: true, enabled: true,
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

nuRouter.put('/enabled', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return send400(res, 'enabled (boolean) is required');
  const next = await writeMasterEnabled(tenantId, enabled);
  logger.info('[nu-routes] master enable toggled', { tenantId, enabled: next, userId: req.user?.id });
  res.json({ ok: true, masterEnabled: next });
}));

// ---------------------------------------------------------------------------
// POST /credentials — set/rotate {username, password} (encrypted at rest)
// The password is NEVER logged or returned.
// ---------------------------------------------------------------------------

nuRouter.post('/credentials', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password ?? '');
  if (!username) return send400(res, 'username is required');
  if (!password) return send400(res, 'password is required');

  const row = await setCredentials(tenantId, { username, password }, req.user?.id || null);
  // NOTE: never echo the password back. Return presence + rotation only.
  logger.info('[nu-routes] credentials set', { tenantId, credentialId: row.id, userId: req.user?.id });
  res.json({ ok: true, credentialId: row.id, rotatedAt: row.rotatedAt });
}));

// ---------------------------------------------------------------------------
// POST /test-auth — live auth probe
// ---------------------------------------------------------------------------

nuRouter.post('/test-auth', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const result = await testAuth(tenantId);
  res.json(result);
}));

// ---------------------------------------------------------------------------
// POST /run-now — enqueue a one-off sync (mirrors Economy: 409 when the tenant
// master switch is off, 503 when queue disabled)
// ---------------------------------------------------------------------------

nuRouter.post('/run-now', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  // Guard: the per-tenant master switch must be ON to run a sync. Mirrors the
  // scheduler gate (enumerateActiveTenants) so a manual run can't bypass a tenant
  // that has deliberately disabled the integration. NU_INTEGRATION_ENABLED remains
  // the global gate for the cron.
  if (!(await readMasterEnabled(tenantId))) {
    return res.status(409).json({ error: 'Integration is disabled for this tenant. Enable it before running a sync.' });
  }
  const jobId = await enqueueOneOffSync(tenantId, `manual:${req.user?.id || 'unknown'}`);
  if (!jobId) {
    return res.status(503).json({ error: 'Queue disabled (REDIS_URL unset)' });
  }
  logger.info('[nu-routes] manual sync enqueued', { tenantId, jobId, userId: req.user?.id });
  res.json({ ok: true, jobId, tenantId });
}));

// ---------------------------------------------------------------------------
// GET /runs?limit= — recent sync runs
// ---------------------------------------------------------------------------

nuRouter.get('/runs', asyncHandler(async (req, res) => {
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
// NuLocationConfig CRUD — "which reservations to watch".
//
// KEY DIFFERENCE from Economy: NU is 1:1. There is NO per-area filter — the
// config is a SINGLE mapping (NU account → one Ride location). The CRUD stays
// generic (NuLocationConfig rows, unique (tenantId, locationId)) so a multi-center
// NU account could add more rows later, but the validation/UX assumes one active
// mapping and carries an optional `externalCenter` (e.g. "100"/FLL) instead of a
// 3-letter area code.
// ---------------------------------------------------------------------------

// GET /locations — list config rows joined with the Ride location name.
nuRouter.get('/locations', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  if (!tenantId) return res.json({ rows: [] });
  const rows = await prisma.nuLocationConfig.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, externalCenter: true, locationId: true, enabled: true,
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

// POST /locations — create the (single) 1:1 mapping.
nuRouter.post('/locations', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const locationId = String(req.body?.locationId || '').trim();
  const enabled = req.body?.enabled === undefined ? true : !!req.body.enabled;

  if (!locationId) return send400(res, 'locationId is required');
  if (!(await assertLocationInTenant(tenantId, locationId))) {
    return send400(res, 'locationId does not belong to this tenant');
  }

  const externalCenter = normalizeCenterInput(req.body?.externalCenter);
  const lookbackDays = normalizeDaysInput(req.body?.lookbackDays);
  const lookaheadDays = normalizeDaysInput(req.body?.lookaheadDays);
  if (Number.isNaN(lookbackDays)) return send400(res, 'lookbackDays must be 0-3650 or null');
  if (Number.isNaN(lookaheadDays)) return send400(res, 'lookaheadDays must be 0-3650 or null');

  // Guard against the unique (tenantId, locationId) collision with a clean 409.
  const existing = await prisma.nuLocationConfig.findUnique({
    where: { tenantId_locationId: { tenantId, locationId } },
    select: { id: true },
  });
  if (existing) {
    return res.status(409).json({ error: 'This Ride location is already mapped', id: existing.id });
  }

  // 1:1 invariant: reject a create that would leave a SECOND enabled row. Only
  // an enabled create can breach it (a disabled row is inert).
  if (enabled) {
    const other = await findOtherEnabledConfig(tenantId);
    if (other) {
      return res.status(409).json({ error: ONE_ACTIVE_LOCATION_MESSAGE, id: other.id });
    }
  }

  const row = await prisma.nuLocationConfig.create({
    data: {
      tenantId,
      locationId,
      // Default the center to "100" (FLL) for the 1:1 case when the caller omits it.
      externalCenter: externalCenter === undefined ? '100' : externalCenter,
      enabled,
      lookbackDays: lookbackDays === undefined ? null : lookbackDays,
      lookaheadDays: lookaheadDays === undefined ? null : lookaheadDays,
    },
  });
  logger.info('[nu-routes] location mapping created', { tenantId, locationId, id: row.id });
  res.json({ ok: true, row });
}));

// PUT /locations/:id — update mapping / center / window / enabled.
nuRouter.put('/locations/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;

  const owned = await prisma.nuLocationConfig.findFirst({
    where: { id, tenantId },
    select: { id: true },
  });
  if (!owned) return res.status(404).json({ error: 'Location mapping not found' });

  const data = {};
  if (req.body?.locationId !== undefined) {
    const locationId = String(req.body.locationId || '').trim();
    if (!locationId) return send400(res, 'locationId cannot be empty');
    if (!(await assertLocationInTenant(tenantId, locationId))) {
      return send400(res, 'locationId does not belong to this tenant');
    }
    // Guard the unique (tenantId, locationId) when re-pointing the mapping.
    const clash = await prisma.nuLocationConfig.findUnique({
      where: { tenantId_locationId: { tenantId, locationId } },
      select: { id: true },
    });
    if (clash && clash.id !== id) {
      return res.status(409).json({ error: 'This Ride location is already mapped', id: clash.id });
    }
    data.locationId = locationId;
  }
  if (req.body?.enabled !== undefined) data.enabled = !!req.body.enabled;

  // 1:1 invariant: enabling this row must not create a SECOND enabled row.
  if (data.enabled === true) {
    const other = await findOtherEnabledConfig(tenantId, id);
    if (other) {
      return res.status(409).json({ error: ONE_ACTIVE_LOCATION_MESSAGE, id: other.id });
    }
  }

  const externalCenter = normalizeCenterInput(req.body?.externalCenter);
  if (externalCenter !== undefined) data.externalCenter = externalCenter;

  const lookbackDays = normalizeDaysInput(req.body?.lookbackDays);
  const lookaheadDays = normalizeDaysInput(req.body?.lookaheadDays);
  if (Number.isNaN(lookbackDays)) return send400(res, 'lookbackDays must be 0-3650 or null');
  if (Number.isNaN(lookaheadDays)) return send400(res, 'lookaheadDays must be 0-3650 or null');
  if (lookbackDays !== undefined) data.lookbackDays = lookbackDays;
  if (lookaheadDays !== undefined) data.lookaheadDays = lookaheadDays;

  const row = await prisma.nuLocationConfig.update({ where: { id }, data });
  res.json({ ok: true, row });
}));

// POST /locations/:id/toggle — flip enabled on the mapping.
nuRouter.post('/locations/:id/toggle', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  if (typeof req.body?.enabled !== 'boolean') return send400(res, 'enabled (boolean) is required');
  const nextEnabled = !!req.body.enabled;

  // 1:1 invariant: toggling ON must not create a SECOND enabled row. (Toggling
  // OFF is always safe.)
  if (nextEnabled) {
    const owned = await prisma.nuLocationConfig.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: 'Location mapping not found' });
    const other = await findOtherEnabledConfig(tenantId, id);
    if (other) {
      return res.status(409).json({ error: ONE_ACTIVE_LOCATION_MESSAGE, id: other.id });
    }
  }

  const updated = await prisma.nuLocationConfig.updateMany({
    where: { id, tenantId },
    data: { enabled: nextEnabled },
  });
  if (!updated.count) return res.status(404).json({ error: 'Location mapping not found' });
  res.json({ ok: true, enabled: nextEnabled });
}));

// DELETE /locations/:id
nuRouter.delete('/locations/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  const deleted = await prisma.nuLocationConfig.deleteMany({ where: { id, tenantId } });
  if (!deleted.count) return res.status(404).json({ error: 'Location mapping not found' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// GET /pending-imports — MANUAL_REVIEW + PENDING tray (source NU).
//
// Selects `isPrepaid` in addition to Economy's fields so the tray can show the
// NU-specific prepaid vs pay-at-destination badge (PP/OP → prepaid, blank →
// pay-at-destination; the counter collects the latter). Money posture is
// unchanged — Ride only records estimatedTotal, never charges.
// ---------------------------------------------------------------------------

nuRouter.get('/pending-imports', asyncHandler(async (req, res) => {
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
      isPrepaid: true,
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
// POST /pending-imports/:id/promote — manual promotion (source NU).
//
// NU is 1:1: the authoritative location is the tenant's single enabled
// NuLocationConfig row (no per-area lookup). Pass its locationId as
// overrideLocationId so the shared matcher skips the LocationCodeMap gate (same
// posture as the worker's auto path). FLL timezone throughout.
// ---------------------------------------------------------------------------

nuRouter.post('/pending-imports/:id/promote', asyncHandler(async (req, res) => {
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
    // NU's authoritative location is the single enabled NuLocationConfig row —
    // pass it as overrideLocationId so the shared matcher skips the LocationCodeMap
    // gate (same posture as the worker's auto path).
    const cfg = await prisma.nuLocationConfig.findFirst({
      where: { tenantId, enabled: true },
      orderBy: { createdAt: 'asc' },
      select: { locationId: true },
    });
    const overrideLocationId = cfg?.locationId || undefined;
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

  // NU is 1:1 FLL → the fixed Eastern timezone (no per-area resolution).
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

nuRouter.post('/pending-imports/:id/reject', asyncHandler(async (req, res) => {
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

export default nuRouter;
