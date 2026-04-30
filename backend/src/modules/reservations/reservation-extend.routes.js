import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { reservationExtendService } from './reservation-extend.service.js';
import { crossTenantScopeFor as scopeFor } from '../../lib/tenant-scope.js';

export const reservationExtendRouter = Router();

// Mounted in main.js as `app.use('/api/reservations', reservationExtendRouter)`,
// so these paths resolve to:
//   POST   /api/reservations/:id/extend
//   DELETE /api/reservations/:id/extension/:extensionChargeId
//
// Do NOT re-prefix `/reservations` here — Sentry/Codex caught that bug
// on PR #30 (would have 404'd in production).

reservationExtendRouter.post(
  '/:id/extend',
  requireAuth,
  requireRole('ADMIN', 'OPS', 'AGENT'),
  async (req, res) => {
    try {
      const { newReturnAt, extensionDailyRate, note } = req.body || {};
      const result = await reservationExtendService.extendReservation({
        reservationId: req.params.id,
        newReturnAt,
        extensionDailyRate,
        note,
        actorUserId: req.user?.sub || req.user?.id,
        actorRole: req.user?.role,
        tenantScope: scopeFor(req)
      });
      res.json(result);
    } catch (e) {
      const status = e.message?.includes('not found') ? 404 : 400;
      res.status(status).json({ error: e.message });
    }
  }
);

// Delete (revert) an extension. LIFO — only the most recent extension
// can be removed. Refuses if the auto-created addendum has been signed
// (agent must voidAddendum first via the rental-agreements service).
reservationExtendRouter.delete(
  '/:id/extension/:extensionChargeId',
  requireAuth,
  requireRole('ADMIN', 'OPS'),
  async (req, res) => {
    try {
      const result = await reservationExtendService.deleteExtension({
        reservationId: req.params.id,
        extensionChargeId: req.params.extensionChargeId,
        actorUserId: req.user?.sub || req.user?.id,
        tenantScope: scopeFor(req)
      });
      res.json(result);
    } catch (e) {
      const msg = e.message || '';
      const status = msg.includes('not found')
        ? 404
        : msg.includes('signed')
          ? 409
          : 400;
      res.status(status).json({ error: msg });
    }
  }
);
