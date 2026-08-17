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
import { requireRole, isSuperAdmin } from '../../middleware/auth.js';
import { trainingService } from './training.service.js';

export const trainingRouter = Router();

/**
 * Who this progress belongs to — and where to look for the work.
 *
 * In PRACTICE mode the two split apart: the trainee's record lives on their
 * real account and tenant (`pracFor` / `pracTenant` from the token), while the
 * reservation they just created lives in the demo tenant under their practice
 * user. Practice is the learning environment, so it counts (Hector,
 * 2026-08-17) — this is what makes the points land on the right person.
 */
const actorOf = (req) => {
  const self = { tenantId: req.user?.tenantId || null, userId: req.user?.id || req.user?.sub || null };
  if (req.user?.prac && req.user?.pracFor) {
    return {
      tenantId: req.user.pracTenant || null,
      userId: req.user.pracFor,
      proofTenantId: self.tenantId,
      proofUserId: self.userId,
    };
  }
  return self;
};

/**
 * Which tenant's team to report on.
 *
 * A SUPER_ADMIN usually carries no tenantId of their own, so without this they
 * would see an empty team on every tenant — the same trap the command palette
 * fell into. They pick a tenant; everyone else is pinned to theirs and the
 * query parameter is ignored.
 */
const teamTenantOf = (req) => (isSuperAdmin(req.user)
  ? (req.query?.tenantId ? String(req.query.tenantId) : req.user?.tenantId || null)
  : req.user?.tenantId || null);

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
 * Reached the end of a module's steps.
 *
 * Completes it ONLY if the module has nothing to prove — the service checks
 * that against what was stamped at arming, so walking a guide can never
 * complete a module whose point is doing the real work.
 */
trainingRouter.post('/progress/:moduleKey/walkthrough-complete', async (req, res, next) => {
  try {
    const who = actorOf(req);
    if (!who.tenantId || !who.userId) return res.status(400).json({ error: 'A tenant and a user are required' });
    const row = await trainingService.completeWalkthrough({ ...who, moduleKey: String(req.params.moduleKey) });
    res.json(row);
  } catch (e) {
    if (/required|not started/i.test(String(e?.message || ''))) {
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
/**
 * Practice mode: swap into the demo tenant to rehearse. Any authenticated
 * HUMAN may practice — but never a service account (a VozIA token has no
 * business minting sessions), and the response is a token the CLIENT swaps
 * in; nothing about the caller's own session changes server-side.
 */
trainingRouter.post('/practice-session', async (req, res, next) => {
  try {
    if (req.user?.isServiceAccount || req.user?.svc) {
      return res.status(403).json({ error: 'Service accounts cannot practice' });
    }
    // A practice session minting further practice sessions would let one
    // leaked 4h token become a perpetual chain (QA #1/#7).
    if (req.user?.prac) {
      return res.status(403).json({ error: 'Already in a practice session' });
    }
    res.json(await trainingService.practiceSession({
      userId: req.user?.id || req.user?.sub || null,
      email: req.user?.email || null,
      tenantId: req.user?.tenantId || null,
    }));
  } catch (e) { next(e); }
});

trainingRouter.get('/team', requireRole('SUPER_ADMIN', 'ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const tenantId = teamTenantOf(req);
    if (!tenantId) return res.json({ team: [] });
    let available = {};
    try {
      available = req.query?.available ? JSON.parse(String(req.query.available)) : {};
    } catch { available = {}; }
    const team = await trainingService.teamStanding({ tenantId, pointsAvailableByUser: available });
    res.json({ team });
  } catch (e) { next(e); }
});
