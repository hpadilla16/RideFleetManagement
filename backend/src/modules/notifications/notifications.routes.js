// Notification Center routes (2026-09-01).
//
// Mounted in main.js with requireAuth + tenantRateLimit and NO
// requireModuleAccess — same precedent as /api/settings/payment-capabilities:
// the bell is read by EVERY authenticated staff role (an AGENT without the
// 'settings' or 'tolls' module still needs to see a guest waiting at the
// kiosk). Role-gated CATEGORIES (billing → ADMIN) are filtered inside the
// service via visibilityWhere, never by a mount-level gate.

import { Router } from 'express';
import { scopeFor } from '../../lib/tenant-scope.js';
import { notificationsService } from './notifications.service.js';

function callerFor(req) {
  const u = req.user || {};
  const name = u.displayName || u.name || u.email || null;
  return { id: u.id || u.sub || null, role: u.role || null, name };
}

export const notificationsRouter = Router();

// GET /api/notifications — the feed (severity/sourceType/tab/before/limit).
notificationsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await notificationsService.list(req.query || {}, scopeFor(req), callerFor(req)));
  } catch (e) {
    next(e);
  }
});

// GET /api/notifications/unread-count — the bell badge (poll ~30s).
notificationsRouter.get('/unread-count', async (req, res, next) => {
  try {
    res.json({ count: await notificationsService.unreadCount(req.query || {}, scopeFor(req), callerFor(req)) });
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/read-all — clears the PERSONAL badge only.
notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    res.json(await notificationsService.markAllRead(req.query || {}, scopeFor(req), callerFor(req)));
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/:id/read — per-user read mark.
notificationsRouter.post('/:id/read', async (req, res, next) => {
  try {
    res.json(await notificationsService.markRead(req.params.id, req.query || {}, scopeFor(req), callerFor(req)));
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/:id/acknowledge — team-visible; delegates to the
// source endpoint where one exists (geofence dismiss, toll staff-ack).
notificationsRouter.post('/:id/acknowledge', async (req, res, next) => {
  try {
    res.json(await notificationsService.acknowledge(req.params.id, req.query || {}, scopeFor(req), callerFor(req)));
  } catch (e) {
    next(e);
  }
});
