import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { reservationExtendService } from './reservation-extend.service.js';
import { crossTenantScopeFor as scopeFor } from '../../lib/tenant-scope.js';

export const reservationExtendRouter = Router();

// Mounted in main.js as `app.use('/api/reservations', reservationExtendRouter)`,
// so this path resolves to POST /api/reservations/:id/extend. Do NOT
// re-prefix `/reservations` here — Sentry/Codex caught that bug on
// PR #30 (would have 404'd in production).
reservationExtendRouter.post('/:id/extend', requireAuth, requireRole('ADMIN', 'OPS', 'AGENT'), async (req, res, next) => {
  try {
    const { newReturnAt, extensionDailyRate, note } = req.body || {};
    const result = await reservationExtendService.extendReservation({
      reservationId: req.params.id,
      newReturnAt,
      extensionDailyRate,
      note,
      actorUserId: req.user?.sub || req.user?.id,
      tenantScope: scopeFor(req)
    });
    res.json(result);
  } catch (e) {
    const status = e.message?.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});
