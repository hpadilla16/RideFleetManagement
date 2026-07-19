/**
 * Ride Kiosk — admin routes (Fase B1+B2, 2026-07-05). Mounted at /api/kiosk in
 * main.js AFTER the device router, behind requireAuth + tenantRateLimit +
 * requireModuleAccess('kiosk'). Device management + session list/KPIs +
 * upsell rules & packages config (B2).
 * Pairing codes and rotated tokens are returned ONCE here and never again.
 */

import { Router } from 'express';
import logger from '../../lib/logger.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { requireRole } from '../../middleware/auth.js';
import { kioskDeviceService, KioskError } from './kiosk-device.service.js';
import { kioskSessionService } from './kiosk-session.service.js';
import { kioskOffersService } from './kiosk-offers.service.js';
import { kioskCheckoutService } from './kiosk-checkout.service.js';

export const kioskAdminRouter = Router();

function handleError(res, err) {
  if (err instanceof KioskError) {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  logger.error('[kiosk-admin] unexpected', { message: err?.message });
  return res.status(500).json({ error: 'Internal error' });
}

const ok = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    handleError(res, err);
  }
};

// GET /api/kiosk/devices?locationId=
kioskAdminRouter.get('/devices', ok(
  (req) => kioskDeviceService.listDevices(scopeFor(req), { locationId: req.query?.locationId ? String(req.query.locationId) : undefined }),
));

// POST /api/kiosk/devices — { name, locationId, walkupEnabled? } → device + one-time pairing code
kioskAdminRouter.post('/devices', ok(
  (req) => kioskDeviceService.createDevice(req.body || {}, scopeFor(req)),
));

// PATCH /api/kiosk/devices/:id — { walkupEnabled?: boolean, name?: 1-80 chars }
// (A1 "Manage" walk-up toggle, B3b). 404 on cross-tenant, 422 on bad body.
kioskAdminRouter.patch('/devices/:id', ok(
  (req) => kioskDeviceService.updateDevice(req.params.id, req.body || {}, scopeFor(req)),
));

// POST /api/kiosk/devices/:id/pairing-code — mint a fresh one-time code (resets lockout)
kioskAdminRouter.post('/devices/:id/pairing-code', ok(
  (req) => kioskDeviceService.issuePairingCode(req.params.id, scopeFor(req)),
));

// POST /api/kiosk/devices/:id/rotate — new device token (old one dies immediately)
kioskAdminRouter.post('/devices/:id/rotate', ok(
  (req) => kioskDeviceService.rotateToken(req.params.id, scopeFor(req)),
));

// POST /api/kiosk/devices/:id/revoke
kioskAdminRouter.post('/devices/:id/revoke', ok(
  (req) => kioskDeviceService.revokeDevice(req.params.id, scopeFor(req)),
));

// GET /api/kiosk/sessions?outcome=&deviceId=&locationId=&take= — list + per-outcome counts
kioskAdminRouter.get('/sessions', ok(
  (req) => kioskSessionService.listSessions(scopeFor(req), {
    outcome: req.query?.outcome ? String(req.query.outcome) : undefined,
    deviceId: req.query?.deviceId ? String(req.query.deviceId) : undefined,
    locationId: req.query?.locationId ? String(req.query.locationId) : undefined,
    take: req.query?.take,
  }),
));

// ── B2: upsell rules & packages ─────────────────────────────────────────────

// GET /api/kiosk/upsell-rules — every channel rule for the tenant
kioskAdminRouter.get('/upsell-rules', ok(
  (req) => kioskOffersService.listUpsellRules(scopeFor(req)),
));

// PUT /api/kiosk/upsell-rules — upsert one rule per channel ('*' = default).
// serviceIds (prepaid + offer) are validated against the ACTIVE catalog.
kioskAdminRouter.put('/upsell-rules', ok(
  (req) => kioskOffersService.upsertUpsellRule(req.body || {}, scopeFor(req)),
));

// GET /api/kiosk/packages — kioskPackagesConfig (BASIC/RECOMMENDED/PREMIUM)
kioskAdminRouter.get('/packages', ok(
  (req) => kioskOffersService.getPackagesConfig(scopeFor(req)),
));

// PUT /api/kiosk/packages — { packages: [{key, name, serviceIds[]}] } with
// the same serviceIds validation as upsell rules (ids, never codes).
kioskAdminRouter.put('/packages', ok(
  (req) => kioskOffersService.updatePackagesConfig(req.body || {}, scopeFor(req)),
));

// ── B3a: key handoff config (lockbox / staff per location) ──────────────────

// GET /api/kiosk/key-handoff — { config: { "<locationId>": {mode, lockboxNote}, "default": {...} } }
kioskAdminRouter.get('/key-handoff', ok(
  (req) => kioskCheckoutService.getKeyHandoffSettings(scopeFor(req)),
));

// PUT /api/kiosk/key-handoff — validates mode enum + that every non-"default"
// key is one of the tenant's locations.
kioskAdminRouter.put('/key-handoff', ok(
  (req) => kioskCheckoutService.updateKeyHandoffSettings(req.body || {}, scopeFor(req)),
));

// ── B3f: VozIA "Get Help" embed config ──────────────────────────────────────

// GET /api/kiosk/vozia-config — { config: { host, widgetKey } | null }
kioskAdminRouter.get('/vozia-config', ok(
  (req) => kioskDeviceService.getVoziaSettings(scopeFor(req)),
));

// PUT /api/kiosk/vozia-config — { host, widgetKey? } (https, ORIGIN only —
// no path) or { host: null } to clear. Full values returned — config, not
// credentials. R3: ADMIN/SUPER_ADMIN only — the configured host receives a
// camera/mic-enabled fullscreen iframe in the lobby plus the reservation
// number; that's ADMIN-tier config. (New route from this phase — tightening
// is the conservative call; Hector informed.) GET above stays module-gated.
kioskAdminRouter.put('/vozia-config', requireRole('ADMIN', 'SUPER_ADMIN'), ok(
  (req) => kioskDeviceService.updateVoziaSettings(req.body || {}, scopeFor(req)),
));
