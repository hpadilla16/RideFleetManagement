import { Router } from 'express';
import { longTermService } from './long-term.service.js';

/**
 * Long-Term (Monthly) Reservations — P1 routes (2026-06-03).
 * Mounted at /api/long-term (auth + tenantRateLimit in main.js).
 */
export const longTermRouter = Router();

function send(res, fn) {
  return fn().then((out) => res.json(out)).catch((err) => {
    const code = err?.statusCode || 500;
    if (code >= 500) console.error('[long-term]', err);
    res.status(code).json({ error: err?.message || 'Internal server error' });
  });
}

longTermRouter.get('/plans', (req, res) =>
  send(res, () => longTermService.listPlans(req.user, req.query || {})));

longTermRouter.post('/reservations/:reservationId/plan', (req, res) =>
  send(res, () => longTermService.attachPlan(req.user, req.params.reservationId, req.body || {})));

longTermRouter.get('/reservations/:reservationId/plan', (req, res) =>
  send(res, async () => (await longTermService.getPlanByReservation(req.user, req.params.reservationId)) || {}));

longTermRouter.patch('/plans/:planId', (req, res) =>
  send(res, () => longTermService.updatePlan(req.user, req.params.planId, req.body || {})));

longTermRouter.post('/plans/:planId/close-cycle', (req, res) =>
  send(res, () => longTermService.closeNextCycle(req.user, req.params.planId, req.body || {})));

longTermRouter.post('/cycles/:cycleId/mark-paid', (req, res) =>
  send(res, () => longTermService.markCyclePaid(req.user, req.params.cycleId, req.body || {})));
