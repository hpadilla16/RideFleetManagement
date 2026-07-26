/**
 * Admin routes for the Mex (TSD RezCentral) franchise integration (Fase 5).
 * A sibling of flexways.routes.js — same auth guard, same tenant-scoping, same
 * feature-flag posture — adapted for Mex's KEY DIFFERENCE: a config row is
 * identified by TWO columns, (tsdNumber, branch), not Flexways' single idSede.
 * TSD's report screen keys inventory by `lstTSDNumber` (61302 = Mex
 * Orlando) + `lstBranch` (MCO) and the grid echoes the pair back in one cell:
 * `Loc` = "61302.MCO". The model's unique is (tenantId, tsdNumber, branch).
 *
 * Mounted at `/api/admin/integrations/mex` (tenantRateLimit + router). Every
 * route requires requireAuth + requireRole('SUPER_ADMIN','ADMIN'); ADMIN is
 * hard-scoped to their own tenant via resolveTenantId (non-super branch returns
 * req.user.tenantId — cannot cross-tenant query).
 *
 * Master enable/disable lives in Tenant.integrationConfig.mex.enabled (Json,
 * additive). Credentials are ONE {username,password} blob per tenant in
 * IntegrationCredential (unique (tenantId, sourceSystem='MEX')), encrypted
 * with lib/integration-crypto (AES-256-GCM). The password is NEVER logged/returned.
 *
 * FIELD-NAME CONTRACT (the beta.301 lesson): the Flexways panel POSTed
 * `{ externalSede }` while its route read `req.body.idSede` — "Add sede" 400'd in
 * production. Here the location body is read through ONE exported function,
 * `readLocationBody`, and the panel builds its body through ONE exported builder
 * (frontend/src/lib/mex-location-contract.js). mex.routes.test.mjs
 * feeds the panel's builder output straight into this reader, so the two can never
 * drift silently again.
 *
 * MONEY: none. Mex is 100% Pay on Arrival (confirmed 2026-07-14) — the
 * integration only stages reservations + estimatedTotal; no prepaid surface, no
 * charge path, nothing here touches a card.
 *
 * Endpoint inventory:
 *   GET   /status                                  → panel health summary (+ live `health`)
 *   PUT   /enabled              { enabled }        → master enable/disable (tenant)
 *   POST  /credentials          { username, password } → set/rotate creds (encrypted)
 *   POST  /test-auth                               → live login probe (real TSD login)
 *   POST  /force-relogin                           → emergency discard-jar + re-login
 *   POST  /run-now                                 → enqueue a one-off mex.sync job
 *   GET   /runs?limit=                             → recent ExternalSyncRun rows
 *   GET   /locations                               → MexLocationConfig rows (+ Ride location)
 *   POST  /locations            { tsdNumber, branch, locationId, enabled?, lookbackDays?, lookaheadDays? }
 *   PUT   /locations/:id        { tsdNumber?, branch?, locationId?, enabled?, lookbackDays?, lookaheadDays? }
 *   POST  /locations/:id/toggle { enabled }        → toggle the config on/off
 *   DELETE /locations/:id                          → remove the mapping
 *   GET   /pending-imports                         → MANUAL_REVIEW / PENDING tray (source MEX)
 *   POST  /pending-imports/:id/promote             → manual promote (source MEX)
 *   POST  /pending-imports/:id/reject              → reject
 *
 * Feature-flag posture (mirror TL/Economy/NU/Flexways): routes ALWAYS exist and
 * config is ALWAYS editable. MEX_INTEGRATION_ENABLED gates only the
 * autonomous scheduler — flipping it off keeps the panel usable but the cron dark.
 *
 * See doc/mex-integration-plan-2026-07-13.md
 */

import { Router } from 'express';
import { requireAuth, requireRole, isSuperAdmin } from '../../../middleware/auth.js';
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import {
  setCredentials,
  testAuth,
  forceRelogin,
  SOURCE_SYSTEM,
} from './mex.service.js';
import { enqueueOneOffSync, promoteWithMappings } from './mex.worker.js';
import { effectiveWindowDays, TIME_ZONE } from './mex.constants.js';
import { integrationEnabled } from './mex.scheduler.js';

export const mexRouter = Router();

// Same authorization as TL/Economy/NU/Flexways: SUPER_ADMIN + ADMIN, ADMIN hard-scoped.
mexRouter.use(requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'));

// ---------------------------------------------------------------------------
// Helpers (cloned from flexways.routes.js)
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

// Master enable flag lives in Tenant.integrationConfig.mex.enabled (JSON,
// additive). Default false → dark.
async function readMasterEnabled(tenantId) {
  if (!tenantId) return false;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { integrationConfig: true },
  });
  const cfg = tenant?.integrationConfig;
  return !!(cfg && typeof cfg === 'object' && cfg.mex && cfg.mex.enabled === true);
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
    mex: {
      ...(base.mex && typeof base.mex === 'object' ? base.mex : {}),
      enabled: !!enabled,
    },
  };
  await prisma.tenant.update({ where: { id: tenantId }, data: { integrationConfig: next } });
  return !!enabled;
}

function estimateNextRunAt(lastRun) {
  if (!integrationEnabled()) return null;
  const minutes = Number(process.env.MEX_SYNC_INTERVAL_MINUTES || 15);
  const cadenceMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;
  const base = lastRun?.finishedAt || lastRun?.startedAt;
  const from = base ? new Date(base).getTime() : Date.now();
  return new Date(from + cadenceMs);
}

// ---------------------------------------------------------------------------
// THE FIELD-NAME CONTRACT — the ONE place a location body is read.
//
// Every location route below reads its body through readLocationBody(); the panel
// builds its body through buildMexLocationBody() (frontend lib). The test
// pipes one into the other. Do not read req.body.<field> for a config field
// anywhere else in this file.
// ---------------------------------------------------------------------------

/** The exact body keys the location routes understand. */
export const LOCATION_BODY_FIELDS = Object.freeze([
  'tsdNumber',
  'branch',
  'locationId',
  'enabled',
  'lookbackDays',
  'lookaheadDays',
]);

function normalizeDaysInput(v) {
  if (v === undefined) return undefined;   // leave untouched
  if (v === null || v === '') return null; // explicit clear → env fallback
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 3650) return NaN; // invalid sentinel
  return Math.floor(n);
}

/**
 * TSD account number ("61302"). Text by design — an identifier the portal renders
 * zero-padded, not a number to do math on. Pure. Exported for tests.
 */
export function normalizeTsdNumberInput(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return String(v).trim().slice(0, 32) || null;
}

/**
 * Branch code ("MCO"). Upper-cased because the grid's `Loc` suffix is upper-case
 * and the parser (parseLoc) upper-cases it too — a lower-case row here would
 * silently never match its config. Pure. Exported for tests.
 */
export function normalizeBranchInput(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return String(v).trim().toUpperCase().slice(0, 32) || null;
}

/**
 * Read a location config body into normalized values. `undefined` = field absent
 * (PUT: leave untouched). NaN on a days field = invalid input. Pure. Exported so
 * the routes test can feed it the PANEL's builder output and prove the two agree
 * on field names (the beta.301 regression).
 */
export function readLocationBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    tsdNumber: normalizeTsdNumberInput(b.tsdNumber),
    branch: normalizeBranchInput(b.branch),
    locationId: b.locationId === undefined ? undefined : String(b.locationId || '').trim(),
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
    lookbackDays: normalizeDaysInput(b.lookbackDays),
    lookaheadDays: normalizeDaysInput(b.lookaheadDays),
  };
}

async function assertLocationInTenant(tenantId, locationId) {
  const loc = await prisma.location.findFirst({
    where: { id: locationId, tenantId },
    select: { id: true },
  });
  return !!loc;
}

/**
 * Live connection health for the panel's header pill + health card.
 *
 * Derived from the credential's last probe AND the last scheduled run — a green
 * pill driven only by a stale manual "Test connection" while the 15-minute cron
 * is failing is exactly the drift the Flexways GD review flagged. Pure. Exported
 * for tests.
 *
 * @returns {{state:'unconfigured'|'failing'|'healthy', reason:string|null,
 *            reasonKind:string|null, lastSuccessAt:Date|string|null}}
 */
export function computeHealth({ credential, lastRun }) {
  if (!credential) {
    return { state: 'unconfigured', reason: null, reasonKind: null, lastSuccessAt: null };
  }
  const testUp = String(credential.lastTestStatus || '').toUpperCase();
  const runUp = String(lastRun?.status || '').toUpperCase();
  const lastSuccessAt = (runUp === 'OK' || runUp === 'SUCCESS' || runUp === 'PARTIAL')
    ? (lastRun?.finishedAt || lastRun?.startedAt || null)
    : (testUp === 'OK' ? (credential.lastTestedAt || null) : null);

  // AUTH_EXPIRED is the self-healing case: the worker re-logs in on its own next
  // sweep. It is still "failing" (the pill must not read green), but the panel
  // labels it as auto-retrying rather than as credentials being wrong.
  if (runUp === 'AUTH_EXPIRED' || testUp === 'EXPIRED') {
    return {
      state: 'failing',
      reasonKind: 'session expired',
      reason: 'the portal session expired — the worker re-logs in automatically on the next run',
      lastSuccessAt,
    };
  }
  if (runUp === 'ATTENTION') {
    return {
      state: 'failing',
      reasonKind: 'report layout drift',
      reason: 'the TSD report grid changed shape — import paused on purpose until the column map is fixed',
      lastSuccessAt,
    };
  }
  if (testUp === 'ERROR' || runUp === 'FAILED' || runUp === 'ERROR') {
    return {
      state: 'failing',
      reasonKind: 'credentials rejected',
      reason: 'the portal rejected the last login — check the connection user and password above',
      lastSuccessAt,
    };
  }
  if (!testUp) {
    // Credentials stored but never probed: not healthy, not failing.
    return { state: 'untested', reason: null, reasonKind: null, lastSuccessAt };
  }
  return { state: 'healthy', reason: null, reasonKind: null, lastSuccessAt };
}

// ---------------------------------------------------------------------------
// GET /status — health summary for the Mex panel (mockup AD-1 / AD-3)
// ---------------------------------------------------------------------------

mexRouter.get('/status', asyncHandler(async (req, res) => {
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
        id: true, status: true, startedAt: true, finishedAt: true, durationMs: true,
        pickupsFound: true, newlyInserted: true, autoPromoted: true, needsReview: true,
      },
    }),
    prisma.mexLocationConfig.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, tsdNumber: true, branch: true, locationId: true, enabled: true,
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
    // Live health — the panel's header pill derives from THIS, never from the
    // stale manual-test status alone (Flexways GD must-change, kept).
    health: computeHealth({ credential, lastRun }),
    locations: configs,
    lastRun: lastRun || null,
    nextRunAt: estimateNextRunAt(lastRun),
  });
}));

// ---------------------------------------------------------------------------
// PUT /enabled — master enable/disable for this tenant
// ---------------------------------------------------------------------------

mexRouter.put('/enabled', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return send400(res, 'enabled (boolean) is required');
  const next = await writeMasterEnabled(tenantId, enabled);
  logger.info('[mex-routes] master enable toggled', { tenantId, enabled: next, userId: req.user?.id });
  res.json({ ok: true, masterEnabled: next });
}));

// ---------------------------------------------------------------------------
// POST /credentials — set/rotate {username, password} (encrypted at rest)
// The password is NEVER logged or returned.
//
// OPS NOTE (surfaced in the panel, mockup AD-2): TSD RezCentral is SINGLE-WINDOW
// STRICT — one live session per user. These must be the DEDICATED connection
// user's credentials; a personal login here means the worker and the human fight
// over the same session.
// ---------------------------------------------------------------------------

mexRouter.post('/credentials', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password ?? '');
  if (!username) return send400(res, 'username is required');
  if (!password) return send400(res, 'password is required');

  const row = await setCredentials(tenantId, { username, password }, req.user?.id || null);
  logger.info('[mex-routes] credentials set', { tenantId, credentialId: row.id, userId: req.user?.id });
  res.json({ ok: true, credentialId: row.id, rotatedAt: row.rotatedAt });
}));

// ---------------------------------------------------------------------------
// POST /test-auth — live login probe (real TSD login + a menu postback, which is
// the piece that actually matters under the single-window rule). No report is
// submitted: the probe stays cheap and side-effect-free.
// ---------------------------------------------------------------------------

mexRouter.post('/test-auth', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const result = await testAuth(tenantId);
  res.json(result);
}));

// ---------------------------------------------------------------------------
// POST /force-relogin — emergency: discard the session jar + re-login now.
// The worker re-authenticates on its own; this is the manual fallback.
// ---------------------------------------------------------------------------

mexRouter.post('/force-relogin', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  try {
    const result = await forceRelogin(tenantId);
    logger.info('[mex-routes] force re-login', { tenantId, userId: req.user?.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ ok: false, status: 'ERROR', message: err.message });
  }
}));

// ---------------------------------------------------------------------------
// POST /run-now — enqueue a one-off sync (409 when master switch off, 503 when
// queue disabled)
// ---------------------------------------------------------------------------

mexRouter.post('/run-now', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!(await readMasterEnabled(tenantId))) {
    return res.status(409).json({ error: 'Integration is disabled for this tenant. Enable it before running a sync.' });
  }
  const jobId = await enqueueOneOffSync(tenantId, `manual:${req.user?.id || 'unknown'}`);
  if (!jobId) {
    return res.status(503).json({ error: 'Queue disabled (REDIS_URL unset)' });
  }
  logger.info('[mex-routes] manual sync enqueued', { tenantId, jobId, userId: req.user?.id });
  res.json({ ok: true, jobId, tenantId });
}));

// ---------------------------------------------------------------------------
// GET /runs?limit= — recent sync runs
// ---------------------------------------------------------------------------

mexRouter.get('/runs', asyncHandler(async (req, res) => {
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
// MexLocationConfig CRUD — the per-(TSD account, branch) mapping.
// Identity is the PAIR (tsdNumber, branch) — the portal's `Loc` cell, "61302.MCO".
// N rows per tenant, NO 1:1 invariant.
// ---------------------------------------------------------------------------

// GET /locations — list configs joined with the Ride location name.
mexRouter.get('/locations', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  if (!tenantId) return res.json({ rows: [] });
  const rows = await prisma.mexLocationConfig.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, tsdNumber: true, branch: true, locationId: true, enabled: true,
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
      // The portal's own identity string, so the panel can show exactly what the
      // `Loc` column shows.
      loc: `${r.tsdNumber}.${r.branch}`,
      location: locById.get(r.locationId) || null,
      effectiveWindow: effectiveWindowDays(r),
    })),
  });
}));

// POST /locations — add a (tsdNumber, branch) → Ride location mapping.
mexRouter.post('/locations', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const body = readLocationBody(req.body);

  if (!body.tsdNumber) return send400(res, 'tsdNumber is required');
  if (!body.branch) return send400(res, 'branch is required');
  if (!body.locationId) return send400(res, 'locationId is required');
  if (!(await assertLocationInTenant(tenantId, body.locationId))) {
    return send400(res, 'locationId does not belong to this tenant');
  }
  if (Number.isNaN(body.lookbackDays)) return send400(res, 'lookbackDays must be 0-3650 or null');
  if (Number.isNaN(body.lookaheadDays)) return send400(res, 'lookaheadDays must be 0-3650 or null');

  // Guard the unique (tenantId, tsdNumber, branch) collision with a clean 409.
  const existing = await prisma.mexLocationConfig.findUnique({
    where: {
      tenantId_tsdNumber_branch: { tenantId, tsdNumber: body.tsdNumber, branch: body.branch },
    },
    select: { id: true },
  });
  if (existing) {
    return res.status(409).json({
      error: `This TSD account / branch (${body.tsdNumber}.${body.branch}) is already mapped`,
      id: existing.id,
    });
  }

  const row = await prisma.mexLocationConfig.create({
    data: {
      tenantId,
      tsdNumber: body.tsdNumber,
      branch: body.branch,
      locationId: body.locationId,
      enabled: body.enabled === undefined ? true : body.enabled,
      lookbackDays: body.lookbackDays === undefined ? null : body.lookbackDays,
      lookaheadDays: body.lookaheadDays === undefined ? null : body.lookaheadDays,
    },
  });
  logger.info('[mex-routes] location mapping created', {
    tenantId, tsdNumber: body.tsdNumber, branch: body.branch, locationId: body.locationId, id: row.id,
  });
  res.json({ ok: true, row });
}));

// PUT /locations/:id — update account / branch / location / window / enabled.
mexRouter.put('/locations/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;

  const owned = await prisma.mexLocationConfig.findFirst({
    where: { id, tenantId },
    select: { id: true, tsdNumber: true, branch: true },
  });
  if (!owned) return res.status(404).json({ error: 'Location mapping not found' });

  const body = readLocationBody(req.body);
  const data = {};

  // The identity pair moves together: changing either half must re-check the
  // unique against the OTHER half's current value.
  if (body.tsdNumber !== undefined || body.branch !== undefined) {
    if (body.tsdNumber !== undefined && !body.tsdNumber) return send400(res, 'tsdNumber cannot be empty');
    if (body.branch !== undefined && !body.branch) return send400(res, 'branch cannot be empty');
    const nextTsd = body.tsdNumber === undefined ? owned.tsdNumber : body.tsdNumber;
    const nextBranch = body.branch === undefined ? owned.branch : body.branch;
    const clash = await prisma.mexLocationConfig.findUnique({
      where: { tenantId_tsdNumber_branch: { tenantId, tsdNumber: nextTsd, branch: nextBranch } },
      select: { id: true },
    });
    if (clash && clash.id !== id) {
      return res.status(409).json({
        error: `This TSD account / branch (${nextTsd}.${nextBranch}) is already mapped`,
        id: clash.id,
      });
    }
    if (body.tsdNumber !== undefined) data.tsdNumber = nextTsd;
    if (body.branch !== undefined) data.branch = nextBranch;
  }

  if (body.locationId !== undefined) {
    if (!body.locationId) return send400(res, 'locationId cannot be empty');
    if (!(await assertLocationInTenant(tenantId, body.locationId))) {
      return send400(res, 'locationId does not belong to this tenant');
    }
    data.locationId = body.locationId;
  }

  if (body.enabled !== undefined) data.enabled = body.enabled;

  if (Number.isNaN(body.lookbackDays)) return send400(res, 'lookbackDays must be 0-3650 or null');
  if (Number.isNaN(body.lookaheadDays)) return send400(res, 'lookaheadDays must be 0-3650 or null');
  if (body.lookbackDays !== undefined) data.lookbackDays = body.lookbackDays;
  if (body.lookaheadDays !== undefined) data.lookaheadDays = body.lookaheadDays;

  const row = await prisma.mexLocationConfig.update({ where: { id }, data });
  res.json({ ok: true, row });
}));

// POST /locations/:id/toggle — flip enabled on the mapping.
mexRouter.post('/locations/:id/toggle', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  if (typeof req.body?.enabled !== 'boolean') return send400(res, 'enabled (boolean) is required');
  const nextEnabled = !!req.body.enabled;

  const updated = await prisma.mexLocationConfig.updateMany({
    where: { id, tenantId },
    data: { enabled: nextEnabled },
  });
  if (!updated.count) return res.status(404).json({ error: 'Location mapping not found' });
  res.json({ ok: true, enabled: nextEnabled });
}));

// DELETE /locations/:id
mexRouter.delete('/locations/:id', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  const deleted = await prisma.mexLocationConfig.deleteMany({ where: { id, tenantId } });
  if (!deleted.count) return res.status(404).json({ error: 'Location mapping not found' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// GET /pending-imports — MANUAL_REVIEW + PENDING tray (source MEX).
//
// Cancelled / no-show rows are staged as REJECTED by the worker, so they never
// appear here — the tray only ever shows real work.
// ---------------------------------------------------------------------------

mexRouter.get('/pending-imports', asyncHandler(async (req, res) => {
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
// POST /pending-imports/:id/promote — manual promotion (source MEX).
//
// Multi-config: the operator supplies the target Ride location
// (locationIdOverride) — the panel knows the (tsdNumber, branch) → location
// mapping. If omitted we let the shared matcher resolve; a missing location is a
// 400, same guard as NU/Flexways. MEX TZ (America/New_York).
// ---------------------------------------------------------------------------

mexRouter.post('/pending-imports/:id/promote', asyncHandler(async (req, res) => {
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

mexRouter.post('/pending-imports/:id/reject', asyncHandler(async (req, res) => {
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

export default mexRouter;
