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
import { shuttleDriverService } from './shuttle-driver.service.js';
import { auditFromReq, AUDIT_ACTIONS } from '../audit/audit.service.js';

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

// ─── Driver shifts (Phase 3 driver surface, Screens 12–15) ──────────────────
// Same staff gate as the monitor itself (requireAuth + module access via
// main.js; scope narrows by User.locationIds). Minting hands out a PUBLIC
// token — a real credential — so issue and revoke are audited like the
// service-token pair they mirror.

/** Active shifts for the monitor panel. Tokens are NOT re-listed — the mint
 *  response is the one time a link is shown (lost link = revoke + re-mint). */
shuttleMonitorRouter.get('/driver-shifts', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await shuttleDriverService.listShifts(staffScope(req)));
  } catch (e) { next(e); }
});

/** Mint a per-shift driver link: { vehicleId, driverName, hours?, locationId? }. */
shuttleMonitorRouter.post('/driver-shifts', async (req, res, next) => {
  try {
    const shift = await shuttleDriverService.mintShift({
      vehicleId: req.body?.vehicleId,
      driverName: req.body?.driverName,
      hours: req.body?.hours,
      locationId: req.body?.locationId,
    }, staffScope(req), req.user?.sub || null);
    auditFromReq(req, {
      action: AUDIT_ACTIONS.DRIVER_SHIFT_ISSUE,
      targetType: 'SHUTTLE_DRIVER_SHIFT',
      targetId: shift.id,
      // ids + expiry only — NEVER the token (an audit row must not be a
      // credential store), and the driver's name is free-text staff input.
      metadata: { vehicleId: shift.vehicleId, locationId: shift.locationId, expiresAt: shift.expiresAt },
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      id: shift.id,
      driverName: shift.driverName,
      vehicleId: shift.vehicleId,
      locationId: shift.locationId,
      expiresAt: shift.expiresAt,
      token: shift.token,
      // The SPA route the frontend serves the driver page on.
      linkPath: `/driver/${shift.token}`,
    });
  } catch (e) {
    if (e?.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

/** Revoke — the link dies now. Idempotent; audited. */
shuttleMonitorRouter.delete('/driver-shifts/:id', async (req, res, next) => {
  try {
    const row = await shuttleDriverService.revokeShift(String(req.params.id), staffScope(req));
    auditFromReq(req, {
      action: AUDIT_ACTIONS.DRIVER_SHIFT_REVOKE,
      targetType: 'SHUTTLE_DRIVER_SHIFT',
      targetId: row.id,
      metadata: { vehicleId: row.vehicleId, locationId: row.locationId },
    });
    res.json({ ok: true, id: row.id, revokedAt: row.revokedAt });
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: e.message });
    next(e);
  }
});

/** Store→driver message ("Notificar al conductor"): { message }. */
shuttleMonitorRouter.post('/driver-shifts/:id/notify', async (req, res, next) => {
  try {
    res.json(await shuttleDriverService.notifyShift(
      String(req.params.id),
      req.body?.message,
      staffScope(req),
      req.user?.sub || null
    ));
  } catch (e) {
    if (e?.status === 400 || e?.status === 404 || e?.status === 409) {
      return res.status(e.status).json({ error: e.message });
    }
    next(e);
  }
});
