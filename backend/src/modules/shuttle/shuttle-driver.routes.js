/**
 * Public driver-mode endpoints (Phase 3 driver surface, 2026-08-25; approved
 * mockup Screens 12–15 + 17a).
 *
 * Mounted at /api/public/driver — NO auth: the per-shift TOKEN is the whole
 * identity, exactly like /api/public/shuttle. Everything unusable (unknown
 * token, expired, revoked, tracker off, vehicle rotated out, re-tenanted
 * location) is the same bare 404 — an unauthenticated caller learns nothing
 * from WHY, and an enumerator gets no oracle.
 *
 * The staff half (mint/list/revoke/notify) lives on the shuttle-monitor
 * router behind requireAuth — see shuttle-monitor.routes.js.
 */
import { Router } from 'express';
import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard,
} from '../../middleware/public-endpoint-guards.js';
import { shuttleDriverService } from './shuttle-driver.service.js';

export const shuttleDriverPublicRouter = Router();

// The driver page polls context + notifications every ~10s while driving —
// a real driver is ~12/min across both. Same envelope as the tracker poll.
const readGuards = [
  attachPublicRequestMeta('public-driver'),
  createPublicRateLimitGuard({ name: 'public-driver', maxRequests: 60, windowMs: 60 * 1000 }),
];

// Position pushes ride the same ~10s cadence as the customer's location share.
const positionGuards = [
  attachPublicRequestMeta('public-driver-position'),
  createPublicRateLimitGuard({ name: 'public-driver-position', maxRequests: 60, windowMs: 60 * 1000 }),
];

// Roster actions: a driver picks up / no-shows a handful of customers per
// trip, not per second.
const actionGuards = [
  attachPublicRequestMeta('public-driver-action'),
  createPublicRateLimitGuard({ name: 'public-driver-action', maxRequests: 30, windowMs: 60 * 1000 }),
];

// Issues are rare by nature; 5/min matches the public request button.
const issueGuards = [
  attachPublicRequestMeta('public-driver-issue'),
  createPublicRateLimitGuard({ name: 'public-driver-issue', maxRequests: 5, windowMs: 60 * 1000 }),
];

/** Shift context: vehicle, location, zones/pickup spots, roster. */
shuttleDriverPublicRouter.get('/:token', readGuards, async (req, res, next) => {
  try {
    const state = await shuttleDriverService.shiftContext(req.params.token);
    if (!state) return res.status(404).json({ error: 'Not found' });
    // Positions and queues go stale in seconds — never let a proxy cache one.
    res.setHeader('Cache-Control', 'no-store');
    res.json(state);
  } catch (e) { next(e); }
});

/**
 * Driver-phone position fallback. Stored ONLY when the vehicle has no active
 * telematics device (accepted:false otherwise — the device is the truth).
 * The response echoes NOTHING back; coordinates never reach a log line.
 */
shuttleDriverPublicRouter.post('/:token/position', positionGuards, async (req, res, next) => {
  try {
    const out = await shuttleDriverService.pushPosition(req.params.token, req.body || {});
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) {
    if (e?.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

/** "✓ Recogido" — the existing markPickedUp service, shift-scoped. */
shuttleDriverPublicRouter.post('/:token/requests/:id/picked-up', actionGuards, async (req, res, next) => {
  try {
    const out = await shuttleDriverService.markPickedUp(req.params.token, req.params.id);
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) {
    // A request outside the shift's tenant+location fails closed as the SAME
    // bare 404 — the roster is the only oracle a driver gets.
    if (e?.status === 404) return res.status(404).json({ error: 'Not found' });
    next(e);
  }
});

/**
 * No-show — the existing markNoShow fan-out (customer SMS, alert row, staff
 * email). The mockup's confirm dialog is a contract: `{confirmed:true}` or a
 * 400 before anything is touched.
 */
shuttleDriverPublicRouter.post('/:token/requests/:id/no-show', actionGuards, async (req, res, next) => {
  try {
    const out = await shuttleDriverService.markNoShow(req.params.token, req.params.id, req.body || {});
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) {
    if (e?.status === 400) return res.status(400).json({ error: e.message, code: e.code || null });
    if (e?.status === 404) return res.status(404).json({ error: 'Not found' });
    next(e);
  }
});

/** Store→driver messages, newest first, last 20. */
shuttleDriverPublicRouter.get('/:token/notifications', readGuards, async (req, res, next) => {
  try {
    const out = await shuttleDriverService.listNotifications(req.params.token);
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) { next(e); }
});

/** Issue report (MECANICO | ACCIDENTE | TRAFICO | CLIENTE_NO_APARECE | OTRO). */
shuttleDriverPublicRouter.post('/:token/issues', issueGuards, async (req, res, next) => {
  try {
    const out = await shuttleDriverService.reportIssue(req.params.token, req.body || {});
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.json(out);
  } catch (e) {
    if (e?.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});
