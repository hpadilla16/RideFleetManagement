/**
 * Staff Shuttle Monitor routes (2026-08-24, approved mockup Screen 1).
 *
 * Mounted in main.js at /api/shuttle-monitor with requireAuth +
 * tenantRateLimit + requireModuleAccess('reservations') — the SAME gate as
 * /api/shuttle-requests and /api/shuttle-tracker, because the monitor is a
 * staff view over exactly those two datasets. NOT a public surface: the
 * public tracker keeps its own token-gated router untouched.
 */
import { Router } from 'express';
import { scopeFor, userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { shuttleMonitorService } from './shuttle-monitor.service.js';

export const shuttleMonitorRouter = Router();

function staffScope(req) {
  return {
    ...scopeFor(req),
    allowedLocationIds: userAllowedLocationIds(req.user),
  };
}

/** Nav visibility: does this caller's scope have any tracker turned ON? */
shuttleMonitorRouter.get('/enabled', async (req, res, next) => {
  try {
    res.json(await shuttleMonitorService.enabled(staffScope(req)));
  } catch (e) { next(e); }
});

/** The monitor payload: shuttles + freshness + open-queue summaries. */
shuttleMonitorRouter.get('/positions', async (req, res, next) => {
  try {
    // Positions go stale in seconds — same no-store rule as the public read.
    res.setHeader('Cache-Control', 'no-store');
    res.json(await shuttleMonitorService.positions(staffScope(req)));
  } catch (e) { next(e); }
});

/** Phase-2 alert feed (mockup Screen 5): geofence enter/exit alerts, newest
 *  first, same staff gate + tenant/location scoping as the positions read. */
shuttleMonitorRouter.get('/alerts', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await shuttleMonitorService.alerts(staffScope(req), { limit: req.query?.limit }));
  } catch (e) { next(e); }
});
