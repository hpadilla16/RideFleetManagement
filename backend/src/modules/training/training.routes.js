/**
 * Ride University — progress endpoints.
 *
 * Mounted at /api/training behind requireAuth. Everyone reads and advances
 * their OWN progress: training is not an admin feature, and a person must be
 * able to see where they stand. The team view is the exception and is gated.
 *
 * The userId is ALWAYS taken from the token, never from the body — otherwise
 * anyone could arm or complete a module on somebody else's record.
 */
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { trainingService } from './training.service.js';

export const trainingRouter = Router();

const actorOf = (req) => ({
  tenantId: req.user?.tenantId || null,
  userId: req.user?.id || req.user?.sub || null,
});

/** My progress, after settling anything the records now prove. */
trainingRouter.get('/progress', async (req, res, next) => {
  try {
    const who = actorOf(req);
    if (!who.tenantId || !who.userId) return res.json({ progress: [], justCompleted: [] });
    const justCompleted = await trainingService.settle(who);
    const progress = await trainingService.progressFor(who);
    res.json({ progress, justCompleted });
  } catch (e) { next(e); }
});

/** Start a module. Idempotent — re-arming keeps the original armedAt. */
trainingRouter.post('/progress/:moduleKey/arm', async (req, res, next) => {
  try {
    const who = actorOf(req);
    if (!who.tenantId || !who.userId) return res.status(400).json({ error: 'A tenant and a user are required' });
    const row = await trainingService.arm({
      ...who,
      moduleKey: String(req.params.moduleKey),
      verifyType: req.body?.verifyType || null,
      points: req.body?.points || 0,
    });
    res.status(201).json(row);
  } catch (e) {
    if (/required|Unknown verification/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

/**
 * Who on the team is trained.
 *
 * pointsAvailableByUser is supplied by the caller because it depends on each
 * person's role and the tenant's enabled modules — that lives in the
 * curriculum, on the client. The response is percentages.
 */
trainingRouter.get('/team', requireRole('SUPER_ADMIN', 'ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const { tenantId } = actorOf(req);
    if (!tenantId) return res.json({ team: [] });
    let available = {};
    try {
      available = req.query?.available ? JSON.parse(String(req.query.available)) : {};
    } catch { available = {}; }
    const team = await trainingService.teamStanding({ tenantId, pointsAvailableByUser: available });
    res.json({ team });
  } catch (e) { next(e); }
});
