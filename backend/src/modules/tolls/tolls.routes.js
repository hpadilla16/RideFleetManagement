import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { isSuperAdmin, requireRole } from '../../middleware/auth.js';
import { tollsService } from './tolls.service.js';

export const tollsRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) {
    return req.query?.tenantId ? { tenantId: String(req.query.tenantId) } : {};
  }
  return { tenantId: req.user?.tenantId || null };
}

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

tollsRouter.put('/provider-account', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(await tollsService.saveProviderAccount(req.body || {}, scopeFor(req)));
  } catch (error) {
    if (/required|enabled/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/provider-account/health-check', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(await tollsService.runProviderHealthCheck(scopeFor(req)));
  } catch (error) {
    if (/required|enabled|configured/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/provider-account/mock-sync', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(await tollsService.runMockSync(scopeFor(req), req.user?.id || req.user?.sub || null));
  } catch (error) {
    if (/required|enabled|configured|ready/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/provider-account/live-sync', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(await tollsService.runLiveSync(scopeFor(req), req.user?.id || req.user?.sub || null));
  } catch (error) {
    if (/required|enabled|configured|ready|playwright|sync/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

tollsRouter.post('/transactions/manual-import', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
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
