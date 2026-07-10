/**
 * Report Damage routes (Feature 3, 2026-07-10). Mounted at /api/report-damage.
 *
 * ACCESS CONTROL:
 *  - POST /:reservationId/report-damage — AGENT / OPS / ADMIN / SUPER_ADMIN
 *    (matches the incident-report roster). This route calls addManualCharge
 *    INTERNALLY, so an agent can put the damage charge on the contract ONLY here —
 *    the general Admin Corrections charge gate (ADMIN/SUPER_ADMIN) is untouched.
 *  - PATCH/DELETE /reports/:reportId — ADMIN / SUPER_ADMIN failsafe (edit/delete a
 *    damage record; delete also voids the linked charge).
 *
 * Damage + estimate photos arrive as base64 data URLs, so bump this router's body
 * limit (like the customer-inspection / incident routers).
 */
import { Router } from 'express';
import express from 'express';
import { requireRole } from '../../middleware/auth.js';
import { idempotency } from '../../middleware/idempotency.js';
import { crossTenantScopeFor as scopeFor } from '../../lib/tenant-scope.js';
import { reportDamageService } from './report-damage.service.js';

export const reportDamageRouter = Router();

reportDamageRouter.use(express.json({ limit: '25mb' }));

// FIX E — transport-layer idempotency. When the client sends an Idempotency-Key,
// a retried POST replays the first response instead of billing a SECOND damage +
// charge ('charge' kind is NON-recyclable, mirroring the Admin Corrections charge
// route). Humans without the header pass through untouched — the service's own
// 60s same-amount guard is the belt-and-suspenders for that path.
const damageChargeIdempotency = idempotency({ kind: 'charge' });

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (e && Number.isInteger(e.status)) {
        return res.status(e.status).json({ error: e.message, code: e.code || undefined });
      }
      next(e);
    }
  };
}

// POST /api/report-damage/:reservationId/report-damage
reportDamageRouter.post(
  '/:reservationId/report-damage',
  requireRole('AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'),
  damageChargeIdempotency,
  wrap(async (req, res) => {
    const out = await reportDamageService.reportDamage(req.params.reservationId, req.body || {}, {
      user: req.user,
      scope: scopeFor(req),
    });
    res.status(201).json(out);
  })
);

// FAILSAFE — ADMIN / SUPER_ADMIN only. Edit a damage record.
reportDamageRouter.patch(
  '/reports/:reportId',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  wrap(async (req, res) => {
    const out = await reportDamageService.editDamageReport(req.params.reportId, req.body || {}, {
      user: req.user,
      scope: scopeFor(req),
    });
    res.json(out);
  })
);

// FAILSAFE — ADMIN / SUPER_ADMIN only. Delete a damage record + void its charge.
reportDamageRouter.delete(
  '/reports/:reportId',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  wrap(async (req, res) => {
    const out = await reportDamageService.deleteDamageReport(
      req.params.reportId,
      { reason: (req.body || {}).reason },
      { user: req.user, scope: scopeFor(req) }
    );
    res.json(out);
  })
);
