import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { reservationExtendService } from './reservation-extend.service.js';
import { crossTenantScopeFor as scopeFor } from '../../lib/tenant-scope.js';

export const reservationExtendRouter = Router();

reservationExtendRouter.post('/reservations/:id/extend', requireAuth, requireRole('ADMIN', 'OPS', 'AGENT'), async (req, res, next) => {
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
