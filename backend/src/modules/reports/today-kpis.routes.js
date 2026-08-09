/**
 * GET /api/reports/today-kpis — the dashboard's "Collected today" +
 * "Tolls to review" tile.
 *
 * WHY THIS LIVES IN ITS OWN ROUTER, mounted BEFORE the reports module gate:
 *
 * Hector, 2026-08-06: "que todo usuario lo pueda ver" — every user, AGENT
 * included. The route was given `requireRole(... 'AGENT' ...)` and everyone
 * assumed that settled it. It did not. reports-v2.routes.js is mounted behind
 * `requireModuleAccess('reports')` (main.js), and an AGENT's default module
 * access is `reports: false` / `maintenance: true`. The module gate sits ABOVE
 * the role check, so agents were 403'd before the route ever ran — the tile
 * they were promised has never once rendered for them, and the dashboard fired
 * a guaranteed-403 request on every single load (found in the 2026-08-08
 * incident review).
 *
 * Moving the route rather than copying it is deliberate. Two definitions of
 * one endpoint drift, and this file exists precisely because a guard in one
 * place disagreed with an intention in another.
 *
 * The tile is still guarded: authentication, the tenant rate limit, a role
 * check, program-scope rejection, and location scoping that FILTERS to the
 * user's own locations rather than failing closed.
 */
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { userProgramScope, userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { scopeFor as tenantScopeFor } from '../../lib/tenant-scope.js';
import { computeTodayKpis } from './today-kpis.js';

export const todayKpisRouter = Router();

todayKpisRouter.get(
  '/today-kpis',
  requireRole('ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      // Program-restricted accounts stay rejected — their world is a program,
      // not a set of locations, and this breakdown has no meaning for them.
      if (userProgramScope(req.user)) {
        return res.status(403).json({
          error: 'This report set is not yet available for program-restricted accounts',
        });
      }
      // SUPER_ADMIN without a tenant gets nulls (the reports-custom Sentry
      // lesson: never pass a null tenantId to Prisma).
      const tenantId = tenantScopeFor(req)?.tenantId || null;
      if (!tenantId) return res.json({ collectedToday: null, byLocation: [], pendingTolls: null });
      // Scoping FILTERS here rather than failing closed: computeTodayKpis
      // carries the allowed location ids into the Prisma where and keeps no
      // whole-tenant cache, so a location-scoped user sees their own numbers.
      const locationIds = userAllowedLocationIds(req.user);
      res.json(await computeTodayKpis(tenantId, { locationIds }));
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Failed to compute today KPIs' });
    }
  }
);

export default todayKpisRouter;
