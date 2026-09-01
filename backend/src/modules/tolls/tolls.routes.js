import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireRole, isSuperAdmin } from '../../middleware/auth.js';
import { scopeFor, userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { tollsService } from './tolls.service.js';
import { providerForIngest, parseDisabledIngestProviders } from './tolls-ingest-provider.js';

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
    const wantProvider = providerForIngest({ provider, sourceType: st });

    // Kill-switch: drop pushes for providers explicitly disabled at /ingest
    // (cuts off a misbehaving external scraper without rotating the shared
    // token). 202 + skipped so the pusher sees "accepted, not stored" and does
    // not treat it as an error to retry.
    const disabledProviders = parseDisabledIngestProviders(process.env.TOLLS_INGEST_DISABLED_PROVIDERS);
    if (wantProvider && disabledProviders.has(wantProvider)) {
      console.log(`[tolls] /ingest skipped ${wantProvider} batch of ${Array.isArray(rows) ? rows.length : 0} row(s) — provider disabled (kill-switch)`);
      return res.status(202).json({ skipped: true, provider: wantProvider, reason: `${wantProvider} ingest disabled`, importedCount: 0 });
    }

    // Pin the provider account so the batch lands on ITS OWN provider, not
    // whatever resolveActiveProvider happens to pick. No matching account ->
    // leave unpinned (legacy resolution) rather than drop the push.
    let pinnedAccountId = providerAccountId || null;
    if (!pinnedAccountId && wantProvider) {
      const acct = await prisma.tollProviderAccount.findFirst({
        where: { tenantId, provider: wantProvider },
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
        select: { id: true }
      });
      pinnedAccountId = acct?.id || null;
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

// CSV export of the CURRENT filtered queue view (Tolls redesign A,
// 2026-08-28). Same open read posture as /dashboard — the export must show
// exactly what the caller's screen shows: identical tenant scope, location
// scope, filters (q / status / needsReview) AND the active queue view. The
// where is built by the same pure builder the dashboard list uses
// (tolls-export.js), so the spreadsheet cannot drift from the screen.
tollsRouter.get('/transactions/export.csv', async (req, res, next) => {
  try {
    const out = await tollsService.exportTransactionsCsv(scopeFor(req), {
      q: req.query?.q ? String(req.query.q) : '',
      status: req.query?.status ? String(req.query.status) : '',
      reservationId: req.query?.reservationId ? String(req.query.reservationId) : '',
      needsReview: String(req.query?.needsReview || '').toLowerCase() === 'true',
      view: req.query?.view ? String(req.query.view) : 'ALL'
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.csv);
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

/**
 * Recovery re-match. The scheduled sweep only reaches back each sede's
 * rematchWindowDays (default 14), which by design can never catch a toll whose
 * reservation was created after the toll had already aged out — for
 * International Rental Corp that was 3,478 of 3,532 unmatched tolls. This runs
 * the same matcher with the window lifted.
 *
 * Defaults to a DRY RUN: it reports what it would confirm and writes nothing.
 * Pass `apply: true` to commit. Manual holds are still respected, so a toll a
 * human parked stays parked.
 *
 * BOUNDED PER CALL. Measured in production at ~70ms per toll, so the full
 * 3,532-row backlog is ~4 minutes — far past any sane proxy timeout. One call
 * therefore processes `maxRows` (default 250, ~18s) and returns
 * `truncated: true` when rows remain. Call again until it comes back false.
 * A bounded run must never be mistaken for a finished one, which is exactly
 * what the old silent `take: 500` got wrong.
 */
tollsRouter.post('/rematch-backfill', requireRole('ADMIN', 'SUPER_ADMIN'), rejectLocationScopedUsers, async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    if (!scope?.tenantId) return res.status(400).json({ error: 'tenantId is required for toll re-match' });
    const body = req.body || {};
    const result = await tollsService.rematchTenant(scope.tenantId, {
      ignoreWindow: true,
      since: body.since || null,
      maxRows: Number.isFinite(Number(body.maxRows)) ? Math.min(2000, Math.max(1, Number(body.maxRows))) : 250,
      dryRun: body.apply !== true,
    });
    res.json(result);
  } catch (error) {
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
