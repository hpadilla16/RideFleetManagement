import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { reservationExtendService } from './reservation-extend.service.js';
import { crossTenantScopeFor as scopeFor } from '../../lib/tenant-scope.js';
import { idempotency } from '../../middleware/idempotency.js';

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
  // S27 W-D: extend creates charge rows — replayed VozIA retries must not
  // double-extend. The middleware only bites service accounts (humans keyless).
  idempotency({ kind: 'vozia-extend' }),
  async (req, res) => {
    try {
      let { newReturnAt, extensionDailyRate, note } = req.body || {};
      // S27 W-D: service accounts must attribute the extension; the author +
      // ticket ride the note so they land on the charge row / addendum trail.
      if (req.user?.isServiceAccount) {
        const author = typeof req.body?.author === 'string' ? req.body.author.trim() : '';
        const ticketId = typeof req.body?.ticketId === 'string' ? req.body.ticketId.trim() : '';
        if (!author || !ticketId || !/^[A-Za-z0-9._-]{1,64}$/.test(ticketId)) {
          return res.status(400).json({
            error: 'author and ticketId are required for service accounts'
          });
        }
        note = [`[VozIA ${ticketId}] by ${author}`, note].filter(Boolean).join(' — ');
      }
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
