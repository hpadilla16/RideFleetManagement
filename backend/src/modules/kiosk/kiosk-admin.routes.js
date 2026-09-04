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
import { kioskStaffAssistService } from './kiosk-staff-assist.service.js';
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

// GET /api/kiosk/admin/sessions/:kioskSessionId/assist-view?conversationId=
// F1 remote assist (2026-09-03) — the Valet agent's read-only, enum-only,
// PII-free view of ONE kiosk session: outcome/step + server-truth columns
// (idVerifiedAt, checkoutSession.currentStep, paymentIntentState, vehicle
// assigned, license photos stored) + a projection of eventsJson (names,
// counts, timestamps, enum codes — never `data`). 404 unless the session is
// in the caller's tenant AND bound to exactly that conversationId (the
// tenant token alone never reaches a session — plan MUST-CHANGE 3).
// Path keeps the `/admin/` segment the Valet contract was issued with; it
// cannot collide with the device router (no /admin/* there). Service
// accounts reach it via service-account-allowlist.js; the mount's
// requireAuth + tenantRateLimit + requireModuleAccess('kiosk') apply.
kioskAdminRouter.get('/admin/sessions/:kioskSessionId/assist-view', ok(
  (req) => kioskSessionService.assistView(scopeFor(req), req.params.kioskSessionId, {
    conversationId: req.query?.conversationId ? String(req.query.conversationId) : undefined,
  }),
));

// ── F3: the same assist a staff member gives at the kiosk, given from Valet ──
//
// These WRITE, which is why the binding grew a TTL and stopped accepting
// finished sessions: with F1 a stale binding showed an agent a departed guest's
// enum codes; here the same stale binding would verify the wrong person's
// identity. Every hard stop lives in the shared staff-assist implementation, so
// the counter and the console cannot drift: underage stays a hard stop, an
// expired licence stays a hard stop, both licence photos stay required, and the
// grant is still 10 minutes, one session, single use.
//
// The AUDITED ACTOR is req.user — whoever actually authenticated. These routes
// are reachable by more than the Valet service account: `kiosk` is ON by default
// for ADMIN and OPS, so a tenant's own admin can call them, and recording that as
// the robot would have erased the only identity RFM can actually vouch for.
//
// agentRef/agentName are asserted by Valet and audited AS asserted — RFM cannot
// see which human is behind the shared service account, and the audit row says
// so rather than implying a check that did not happen.

// POST /api/kiosk/admin/sessions/:id/remote-assist/unlock
// { conversationId, agentRef, agentName, reason } → mints the grant.
kioskAdminRouter.post('/admin/sessions/:kioskSessionId/remote-assist/unlock', ok(
  (req) => kioskStaffAssistService.remoteUnlock(scopeFor(req), req.params.kioskSessionId, req.body || {}, req.user),
));

// POST /api/kiosk/admin/sessions/:id/remote-assist/verify-id
// { conversationId, agentRef, agentName, fields, licenseFrontPhoto, licenseBackPhoto }
// The manual entry itself: the agent types what the scanner could not read.
kioskAdminRouter.post('/admin/sessions/:kioskSessionId/remote-assist/verify-id', ok(
  (req) => kioskStaffAssistService.remoteVerifyId(scopeFor(req), req.params.kioskSessionId, req.body || {}, req.user),
));

// POST /api/kiosk/admin/sessions/:id/remote-assist/confirm-name
// { conversationId, agentRef, agentName } — vouches for the NAME only; the
// reservation is not rewritten and the other rules stay hard stops.
kioskAdminRouter.post('/admin/sessions/:kioskSessionId/remote-assist/confirm-name', ok(
  (req) => kioskStaffAssistService.remoteConfirmName(scopeFor(req), req.params.kioskSessionId, req.body || {}, req.user),
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
