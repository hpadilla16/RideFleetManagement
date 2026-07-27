import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireRole, isSuperAdmin } from '../../middleware/auth.js';
import { scopeFor, userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { tollsService } from './tolls.service.js';
import { providerForIngest } from './tolls-ingest-provider.js';

export const tollsRouter = Router();
export const tollsInternalRouter = Router();

// Internal ingest (droplet scraper push, shared secret). Decouples heavy headless
// scraping (SunPass/E-PASS, etc.) from the in-worker AutoExpreso sweep: the droplet
// logs in + scrapes + normalizes, then PUSHES raw rows here. Reuses the SAME import
// pipeline as the staff manual-import (dedup by externalId + plate/tag/sello+timestamp
// match + assignment + reservation charge sync). One connector never blocks another.
function requireInternalToken(req, res, next) {
  const expected = process.env.BACKEND_INTERNAL_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Internal endpoints disabled (no BACKEND_INTERNAL_TOKEN)' });
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== expected) return res.status(401).json({ error: 'Invalid internal token' });
  next();
}

// Body: { tenantId, rows:[{transactionAt, plate?, tag?, sello?, amount, location?,
//   lane?, direction?, externalId, transactionTimeRaw?}], sourceType?, importMeta?,
//   provider?, providerAccountId? }
// provider/providerAccountId pin the batch to its own account (see above); when
// omitted, provider is inferred from sourceType.
// tenant must have tollsEnabled (enforced inside createManualTransactions).
tollsInternalRouter.post('/ingest', requireInternalToken, async (req, res, next) => {
  try {
    const { tenantId, rows, sourceType, importMeta, provider, providerAccountId } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    const st = sourceType || 'SUNPASS_SYNC';

    // Pin the provider account so the batch lands on ITS OWN provider, not
    // whatever resolveActiveProvider happens to pick. No matching account ->
    // leave unpinned (legacy resolution) rather than drop the push.
    let pinnedAccountId = providerAccountId || null;
    if (!pinnedAccountId) {
      const wantProvider = providerForIngest({ provider, sourceType: st });
      if (wantProvider) {
        const acct = await prisma.tollProviderAccount.findFirst({
          where: { tenantId, provider: wantProvider },
          orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
          select: { id: true }
        });
        pinnedAccountId = acct?.id || null;
      }
    }

    const out = await tollsService.createManualTransactions(
      Array.isArray(rows) ? rows : [],
      { tenantId },
      null,
      {
        sourceType: st,
        importMeta: importMeta || null,
        ...(pinnedAccountId ? { providerAccountId: pinnedAccountId } : {})
      }
    );
    res.status(201).json(out);
  } catch (error) {
    if (/required|invalid|amount|enabled|rows/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

async function ensureTollsEnabled(req, res, next) {
  try {
    if (isSuperAdmin(req.user)) return next();
    const tenantId = req.user?.tenantId || null;
    if (!tenantId) return res.status(403).json({ error: 'Tolls is not enabled for this tenant' });
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { tollsEnabled: true }
    });
    if (!tenant?.tollsEnabled) return res.status(403).json({ error: 'Tolls is not enabled for this tenant' });
    next();
  } catch (error) {
    next(error);
  }
}

tollsRouter.use(ensureTollsEnabled);

/**
 * Location scoping (2026-07-24). Some toll operations are inherently TENANT-WIDE
 * and cannot be meaningfully narrowed to a branch:
 *
 *  - bulk-auto-match rewrites vehicleId/reservationId/status across every
 *    pending row. Its whole purpose is to attribute rows that have NO vehicle
 *    yet, so filtering its candidates by vehicle home location would make it a
 *    silent no-op for a scoped caller while still reading tenant-wide.
 *  - the provider-account routes are one credential + one sync per TENANT, not
 *    per branch; a live/mock sync imports the whole account's activity.
 *
 * Leaving these open while the reads beside them are scoped is the worse of the
 * two failures: a branch user would rewrite the entire tenant's toll matching
 * and then not be able to see what they changed. Refuse explicitly instead —
 * same shape as `rejectScopedUsers` in reports-v2.routes.js. `requireRole` does
 * NOT cover this: a location ADMIN passes it (see userAllowedLocationIds).
 */
export function rejectLocationScopedUsers(req, res, next) {
  if (userAllowedLocationIds(req.user)) {
    return res.status(403).json({
      error: 'This is a tenant-wide toll operation and is not available for location-restricted accounts',
    });
  }
  next();
}

tollsRouter.get('/dashboard', async (req, res, next) => {
  try {
    res.json(await tollsService.getDashboard(scopeFor(req), {
      q: req.query?.q ? String(req.query.q) : '',
      status: req.query?.status ? String(req.query.status) : '',
      reservationId: req.query?.reservationId ? String(req.query.reservationId) : '',
      needsReview: String(req.query?.needsReview || '').toLowerCase() === 'true'
    }));
  } catch (error) {
    next(error);
  }
});

// Bandeja "peajes por cobrar" (TollBridge point 9): unacknowledged tolls on
// contracts, closed ones first. Same open posture as /dashboard — front-desk
// staff (AGENT) are exactly who must see and work these.
tollsRouter.get('/alerts', async (req, res, next) => {
  try {
    res.json(await tollsService.listStaffTollAlerts(scopeFor(req), {
      reservationId: req.query?.reservationId ? String(req.query.reservationId) : null
    }));
  } catch (error) {
    next(error);
  }
});

// Ack = workflow mark ("seen/collected"), not a money mutation, so no
// ADMIN/OPS gate — the location scope inside getTransactionOrThrow is the
// boundary that matters.
tollsRouter.post('/transactions/:id/acknowledge', async (req, res, next) => {
  try {
    res.json(await tollsService.acknowledgeTollAlert(req.params.id, scopeFor(req), req.user?.id || req.user?.sub || null));
  } catch (error) {
    if (/not found|required|enabled/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.get('/provider-account', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(await tollsService.getProviderAccount(scopeFor(req)));
  } catch (error) {
    if (/required|enabled/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.put('/provider-account', requireRole('ADMIN', 'OPS'), rejectLocationScopedUsers, async (req, res, next) => {
  try {
    res.json(await tollsService.saveProviderAccount(req.body || {}, scopeFor(req)));
  } catch (error) {
    if (/required|enabled/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/provider-account/health-check', requireRole('ADMIN', 'OPS'), rejectLocationScopedUsers, async (req, res, next) => {
  try {
    res.json(await tollsService.runProviderHealthCheck(scopeFor(req)));
  } catch (error) {
    if (/required|enabled|configured/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/provider-account/mock-sync', requireRole('ADMIN', 'OPS'), rejectLocationScopedUsers, async (req, res, next) => {
  try {
    res.json(await tollsService.runMockSync(scopeFor(req), req.user?.id || req.user?.sub || null));
  } catch (error) {
    if (/required|enabled|configured|ready/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/provider-account/live-sync', requireRole('ADMIN', 'OPS'), rejectLocationScopedUsers, async (req, res, next) => {
  try {
    res.json(await tollsService.runLiveSync(scopeFor(req), req.user?.id || req.user?.sub || null));
  } catch (error) {
    if (/required|enabled|configured|ready|playwright|sync/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

// Gated for the same reason as live-sync/mock-sync, which reach the IDENTICAL
// service method (createManualTransactions). Matching is deliberately
// actor-independent — `listTenantVehiclesForMatch` / `listReservationCandidates`
// ignore the CALLER's location scope so an import produces the same result
// whoever runs it (the 2026-07-26 sede filter keys off the TOLL's own
// locationId stamp, data not actor, so this still holds) — so an import by a
// branch user creates TOLL_MODULE charges on reservations at every branch,
// which they then cannot see. Gating live-sync but not this door would read as
// covered while leaving the money-touching half open.
tollsRouter.post('/transactions/manual-import', requireRole('ADMIN', 'OPS'), rejectLocationScopedUsers, async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const out = await tollsService.createManualTransactions(rows, scopeFor(req), req.user?.id || req.user?.sub || null);
    res.status(201).json(out);
  } catch (error) {
    if (/required|invalid|amount|enabled/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/transactions/:id/confirm-match', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(await tollsService.confirmMatch(req.params.id, req.body || {}, scopeFor(req), req.user?.id || req.user?.sub || null));
  } catch (error) {
    if (/not found|required|enabled/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/transactions/:id/post-to-reservation', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(await tollsService.postToReservation(req.params.id, req.body || {}, scopeFor(req), req.user?.id || req.user?.sub || null));
  } catch (error) {
    if (/not found|required|enabled|match/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/transactions/:id/review-action', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(await tollsService.applyReviewAction(req.params.id, req.body || {}, scopeFor(req), req.user?.id || req.user?.sub || null));
  } catch (error) {
    if (/not found|required|enabled|unsupported/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/transactions/bulk-confirm', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const result = await tollsService.bulkConfirmMatches(ids, scopeFor(req), req.user?.id || req.user?.sub || null, {
      note: req.body?.note || 'Bulk confirm'
    });
    res.json(result);
  } catch (error) {
    if (/not found|required|enabled/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/transactions/bulk-auto-match', requireRole('ADMIN', 'OPS'), rejectLocationScopedUsers, async (req, res, next) => {
  try {
    const result = await tollsService.autoMatchPendingTransactions(scopeFor(req), req.user?.id || req.user?.sub || null, {
      limit: Number(req.body?.limit || 500)
    });
    res.json(result);
  } catch (error) {
    if (/not found|required|enabled/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.get('/reservations/:reservationId', async (req, res, next) => {
  try {
    res.json(await tollsService.listReservationTolls(req.params.reservationId, scopeFor(req)));
  } catch (error) {
    if (/not found/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});
