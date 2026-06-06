/**
 * Admin routes for the TL International franchise integration.
 *
 * Mounted at `/api/admin/integrations/tl-international`.
 * Every route requires `requireAuth + requireRole('SUPER_ADMIN', 'ADMIN')`.
 * ADMIN access is scoped to their own tenant via resolveTenantId (non-super
 * branch returns req.user.tenantId — cannot cross-tenant query).
 *
 * Endpoint inventory:
 *   POST  /cookie                                 → rotate the session cookie
 *   POST  /test-auth                              → live auth probe
 *   POST  /run-now                                → enqueue a one-off sync
 *   GET   /runs?limit=                            → recent ExternalSyncRun rows
 *   GET   /pending-imports                        → MANUAL_REVIEW / PENDING tray
 *   POST  /pending-imports/:id/promote            → manually promote a row
 *   POST  /pending-imports/:id/reject             → reject a row
 *   GET   /payout-periods?year=&month=            → monthly payout ledger
 *   GET   /payout-periods/:year/:month/reservations → ledger detail view
 *   PUT   /payout-periods/:year/:month            → record manual payment
 *
 * Billable rule for `expectedAmount`:
 *   An ExternalReservation contributes ONLY IF the promoted Reservation
 *   has a RentalAgreement with status IN ('FINALIZED', 'CLOSED').
 */

import { Router } from 'express';
import { requireAuth, requireRole, isSuperAdmin } from '../../../middleware/auth.js';
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import {
  setCookie,
  testAuth,
  SOURCE_SYSTEM,
} from './tl-international.service.js';
import {
  enqueueOneOffSync,
  promoteWithMappings,
} from './tl-international.worker.js';

export const tlInternationalRouter = Router();

// 2026-05-26: opened to ADMIN in addition to SUPER_ADMIN. ADMIN is hard-scoped
// to their own tenant via resolveTenantId; only SUPER_ADMIN can cross-tenant.
tlInternationalRouter.use(requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTenantId(req) {
  // SUPER_ADMIN can target any tenant via ?tenantId= or body.tenantId
  if (isSuperAdmin(req.user)) {
    const t = req.query?.tenantId || req.body?.tenantId || req.user?.tenantId;
    if (!t) throw new Error('tenantId is required (SUPER_ADMIN must pick one)');
    return String(t);
  }
  return req.user?.tenantId;
}

// Read-endpoint tolerant variant. SUPER_ADMIN can hit /runs and /pending-imports
// without picking a tenant (e.g. the runs/page.js in beta.56 fails to populate
// a tenant dropdown because /api/admin/tenants 404s) — in that case we just
// return data across all tenants instead of 500'ing. Write endpoints keep the
// strict version that throws.
function resolveTenantIdOrNull(req) {
  try { return resolveTenantId(req); } catch { return null; }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function send400(res, message) {
  return res.status(400).json({ error: message });
}

// ---------------------------------------------------------------------------
// GET /status — integration health summary for the settings panel
// (beta.116: TLIntegrationPanel.jsx has called this since the panel shipped,
// but the route never existed — every settings visit logged a 404 that the
// droplet log monitor kept flagging. Read-only; never returns the cookie.)
// ---------------------------------------------------------------------------

tlInternationalRouter.get('/status', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  if (!tenantId) {
    // SUPER_ADMIN without a tenant selected — nothing meaningful to report.
    return res.json({ configured: false, tenantId: null });
  }

  const [credential, lastRun] = await Promise.all([
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
      select: { id: true, status: true, startedAt: true, finishedAt: true },
    }),
  ]);

  res.json({
    configured: !!credential,
    tenantId,
    rotatedAt: credential?.rotatedAt || null,
    lastTestedAt: credential?.lastTestedAt || null,
    lastTestStatus: credential?.lastTestStatus || null,
    lastRun: lastRun || null,
    // Cron cadence is BullMQ every-15-min with jitter + quiet hours; we don't
    // inspect the queue here, so the panel renders '-' for nextRunAt.
    nextRunAt: null,
  });
}));

// ---------------------------------------------------------------------------
// POST /cookie — rotate the session cookie
// ---------------------------------------------------------------------------

tlInternationalRouter.post('/cookie', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const cookie = String(req.body?.cookie || '').trim();
  if (!cookie || cookie.length < 20) {
    return send400(res, 'cookie is required and must be at least 20 characters');
  }
  const row = await setCookie(tenantId, cookie, req.user?.id || null);
  res.json({
    ok: true,
    credentialId: row.id,
    rotatedAt: row.rotatedAt,
  });
}));

// ---------------------------------------------------------------------------
// POST /test-auth — ping the TL session_check endpoint
// ---------------------------------------------------------------------------

tlInternationalRouter.post('/test-auth', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const result = await testAuth(tenantId);
  res.json(result);
}));

// ---------------------------------------------------------------------------
// POST /run-now — enqueue a one-off sync job
// ---------------------------------------------------------------------------

tlInternationalRouter.post('/run-now', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const jobId = await enqueueOneOffSync(tenantId, `manual:${req.user?.id || 'unknown'}`);
  if (!jobId) {
    return res.status(503).json({ error: 'Queue disabled (REDIS_URL unset)' });
  }
  logger.info('[tl-routes] manual sync enqueued', { tenantId, jobId, userId: req.user?.id });
  res.json({ ok: true, jobId, tenantId });
}));

// ---------------------------------------------------------------------------
// GET /runs?limit= — recent sync runs
// ---------------------------------------------------------------------------

tlInternationalRouter.get('/runs', asyncHandler(async (req, res) => {
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
// GET /pending-imports — MANUAL_REVIEW + PENDING tray
// ---------------------------------------------------------------------------

tlInternationalRouter.get('/pending-imports', asyncHandler(async (req, res) => {
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
// POST /pending-imports/:id/promote — manual promotion
// ---------------------------------------------------------------------------

tlInternationalRouter.post('/pending-imports/:id/promote', asyncHandler(async (req, res) => {
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

  // Resolve customer + location: caller overrides, then fall back to evaluator output.
  let resolvedCustomerId = customerId || null;
  let resolvedLocationId = locationIdOverride || null;
  let resolvedCategory = vehicleCategoryOverride || null;

  if (!resolvedCustomerId || !resolvedLocationId) {
    const { evaluatePromotion } = await import('./promotion-matcher.service.js');
    const decision = await evaluatePromotion(extRes, { prisma });
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
    promotedByUserId: req.user?.id || null,
    isAuto: false,
  });
  res.json({ ok: true, ...result });
}));

// ---------------------------------------------------------------------------
// POST /pending-imports/:id/reject
// ---------------------------------------------------------------------------

tlInternationalRouter.post('/pending-imports/:id/reject', asyncHandler(async (req, res) => {
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

// ---------------------------------------------------------------------------
// GET /payout-periods?year=&month= — monthly ledger
// ---------------------------------------------------------------------------

tlInternationalRouter.get('/payout-periods', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const year = req.query?.year ? parseInt(String(req.query.year), 10) : null;
  const month = req.query?.month ? parseInt(String(req.query.month), 10) : null;

  const where = { tenantId, sourceSystem: SOURCE_SYSTEM };
  if (year != null) where.year = year;
  if (month != null) where.month = month;

  const stored = await prisma.franchisePayoutPeriod.findMany({
    where,
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    take: 36,
  });

  // Compute LIVE expectedAmount for each period (do NOT trust stored unless
  // the period is closed). The rule: sum totalAmount of ExternalReservation
  // rows in the month whose promoted Reservation has a RentalAgreement
  // with status IN ('FINALIZED','CLOSED').
  const rows = await Promise.all(stored.map(async (p) => {
    const expected = await computeExpectedAmount(tenantId, p.year, p.month);
    return {
      ...p,
      expectedAmount: p.closedAt ? p.expectedAmount : expected,
      computedExpectedAmount: expected,
    };
  }));

  res.json({ rows });
}));

// ---------------------------------------------------------------------------
// GET /payout-periods/:year/:month/reservations — ledger detail
// ---------------------------------------------------------------------------

tlInternationalRouter.get('/payout-periods/:year/:month/reservations', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const year = parseInt(req.params.year, 10);
  const month = parseInt(req.params.month, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return send400(res, 'Invalid year/month');
  }

  const { start, end } = monthBounds(year, month);
  const externalRes = await prisma.externalReservation.findMany({
    where: {
      tenantId,
      sourceSystem: SOURCE_SYSTEM,
      pickupAt: { gte: start, lt: end },
    },
    orderBy: { pickupAt: 'asc' },
    include: {
      promotedToReservation: {
        select: {
          id: true,
          reservationNumber: true,
          status: true,
          rentalAgreement: { select: { id: true, status: true, agreementNumber: true } },
        },
      },
    },
  });

  // Categorize into buckets:
  //   - billable: has RentalAgreement IN ('FINALIZED','CLOSED')
  //   - pending: promoted but no/draft agreement
  //   - not_billable: never promoted or rejected
  const buckets = { billable: [], pending: [], not_billable: [] };
  let billableTotal = 0;
  for (const r of externalRes) {
    const agreement = r.promotedToReservation?.rentalAgreement;
    const isBillable = agreement && (agreement.status === 'FINALIZED' || agreement.status === 'CLOSED');
    if (isBillable) {
      buckets.billable.push(r);
      billableTotal += Number(r.totalAmount || 0);
    } else if (r.promotedToReservation) {
      buckets.pending.push(r);
    } else {
      buckets.not_billable.push(r);
    }
  }

  res.json({
    year, month,
    counts: {
      billable: buckets.billable.length,
      pending: buckets.pending.length,
      not_billable: buckets.not_billable.length,
    },
    expectedAmount: billableTotal,
    rows: externalRes,
  });
}));

// ---------------------------------------------------------------------------
// PUT /payout-periods/:year/:month — record manual payment
// ---------------------------------------------------------------------------

tlInternationalRouter.put('/payout-periods/:year/:month', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const year = parseInt(req.params.year, 10);
  const month = parseInt(req.params.month, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return send400(res, 'Invalid year/month');
  }

  const body = req.body || {};
  const data = {};
  if (body.receivedAmount !== undefined) data.receivedAmount = body.receivedAmount;
  if (body.receivedAt !== undefined) data.receivedAt = body.receivedAt ? new Date(body.receivedAt) : null;
  if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).slice(0, 1000) : null;
  if (body.closedAt !== undefined) {
    data.closedAt = body.closedAt ? new Date(body.closedAt) : null;
    data.closedByUserId = body.closedAt ? (req.user?.id || null) : null;
  }

  // Always refresh expectedAmount from the live computation at write time.
  const expected = await computeExpectedAmount(tenantId, year, month);
  data.expectedAmount = expected;

  const row = await prisma.franchisePayoutPeriod.upsert({
    where: {
      tenantId_sourceSystem_year_month: {
        tenantId,
        sourceSystem: SOURCE_SYSTEM,
        year,
        month,
      },
    },
    create: {
      tenantId,
      sourceSystem: SOURCE_SYSTEM,
      year,
      month,
      ...data,
    },
    update: data,
  });

  res.json({ row });
}));

// ---------------------------------------------------------------------------
// Compute live expected billable amount for a (tenant, year, month)
// ---------------------------------------------------------------------------

export async function computeExpectedAmount(tenantId, year, month) {
  const { start, end } = monthBounds(year, month);
  const rows = await prisma.externalReservation.findMany({
    where: {
      tenantId,
      sourceSystem: SOURCE_SYSTEM,
      pickupAt: { gte: start, lt: end },
      promotedToReservation: {
        rentalAgreement: {
          status: { in: ['FINALIZED', 'CLOSED'] },
        },
      },
    },
    select: { totalAmount: true },
  });
  let total = 0;
  for (const r of rows) total += Number(r.totalAmount || 0);
  return total;
}

function monthBounds(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}
