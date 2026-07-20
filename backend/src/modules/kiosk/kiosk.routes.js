/**
 * Ride Kiosk — device-facing routes (Fase B1+B2, 2026-07-05). Mounted at
 * /api/kiosk in main.js BEFORE the authed admin router: no route here shares
 * a path with the admin ones (/devices*, GET /sessions exact), so admin
 * requests fall through to the authed router below this mount.
 *
 * NO user auth. /pair is the single tokenless route (hashed single-use code
 * + TTL + lockout); everything else requires X-Kiosk-Token via
 * requireKioskDevice. tenant-rate-limit runs after requireAuth and does NOT
 * cover these routes — the per-IP public guards below are the defense.
 */

import { Router } from 'express';
import logger from '../../lib/logger.js';
import { attachPublicRequestMeta, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';
import { requireKioskDevice } from './kiosk-auth.middleware.js';
import { kioskDeviceService, KioskError } from './kiosk-device.service.js';
import { kioskSessionService } from './kiosk-session.service.js';
import { kioskOffersService } from './kiosk-offers.service.js';
import { kioskCheckoutService } from './kiosk-checkout.service.js';
import { kioskStaffAssistService } from './kiosk-staff-assist.service.js';
import { kioskNameUpdateService } from './kiosk-name-update.service.js';

export const kioskRouter = Router();

function handleError(res, err) {
  if (err instanceof KioskError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.details && typeof err.details === 'object' ? err.details : {}),
    });
  }
  logger.error('[kiosk] unexpected', { message: err?.message });
  return res.status(500).json({ error: 'Internal error' });
}

const ok = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    handleError(res, err);
  }
};

// POST /api/kiosk/pair — the ONLY unauthenticated route. Tight per-IP guard;
// the code itself is single-use, 10-min TTL, 5-attempt lockout.
kioskRouter.post(
  '/pair',
  attachPublicRequestMeta('kiosk-pair'),
  createPublicRateLimitGuard({ name: 'kiosk-pair', maxRequests: 10, windowMs: 60 * 1000 }),
  ok((req) => kioskDeviceService.pairDevice({
    pairingCode: req.body?.pairingCode,
    ip: req.publicRequestMeta?.ip || req.ip,
  })),
);

// Shared middleware stack for every device-token route. Applied per-route
// (NOT router.use) so unmatched paths — the admin GETs — fall through to the
// authed router without hitting requireKioskDevice.
const deviceGuards = [
  attachPublicRequestMeta('kiosk-device'),
  createPublicRateLimitGuard({ name: 'kiosk-device', maxRequests: 120, windowMs: 60 * 1000 }),
  requireKioskDevice,
];

// GET /api/kiosk/device — a paired kiosk refreshes its own display info
// (name, walk-up toggle, location label) without re-pairing. Exact path
// '/device' never collides with the admin '/devices*' routes.
kioskRouter.get('/device', deviceGuards, ok(
  (req) => kioskDeviceService.getOwnDevice(req.kioskDevice),
));

// POST /api/kiosk/sessions — { kind: 'PICKUP' | 'WALKUP' }
kioskRouter.post('/sessions', deviceGuards, ok(
  (req) => kioskSessionService.createSession(req.body || {}, req.kioskDevice),
));

// POST /api/kiosk/sessions/:id/events — { events: [{step, event, data}] } (batch ok)
kioskRouter.post('/sessions/:id/events', deviceGuards, ok(
  (req) => kioskSessionService.appendEvents(req.params.id, req.kioskDevice, req.body?.events ?? req.body),
));

// POST /api/kiosk/sessions/:id/lookup — B3g smart lookup. Body:
//   { confirmationNumber }              exact → variant (dark until S30 lib)
//   { lastName, phone }                 name + phone disambiguator
//   { lastName, pickupDate: 'YYYY-MM-DD' }  name + pickup-date disambiguator
// Single match → masked stub; multiple → { status:'NEEDS_MORE_INFO', needs }.
kioskRouter.post('/sessions/:id/lookup', deviceGuards, ok(
  (req) => kioskSessionService.lookupReservation(req.params.id, req.kioskDevice, req.body || {}),
));

// POST /api/kiosk/sessions/:id/attach-reservation — { reservationId }
kioskRouter.post('/sessions/:id/attach-reservation', deviceGuards, ok(
  (req) => kioskSessionService.attachReservation(req.params.id, req.kioskDevice, req.body || {}),
));

// POST /api/kiosk/sessions/:id/assign-vehicle — atomic server-side auto-pick,
// then creates the checkout-session (car secured BEFORE any payment step).
kioskRouter.post('/sessions/:id/assign-vehicle', deviceGuards, ok(
  (req) => kioskSessionService.assignVehicle(req.params.id, req.kioskDevice),
));

// GET /api/kiosk/sessions/:id/offers — B2 upsell engine. Prices ALWAYS come
// from the server (UpsellRule × AdditionalService catalog × rental days).
kioskRouter.get('/sessions/:id/offers', deviceGuards, ok(
  (req) => kioskOffersService.computeOffers(req.params.id, req.kioskDevice),
));

// POST /api/kiosk/sessions/:id/offers — { acceptedServiceIds: [] } ([] = declined).
// Idempotent: replaces the reservation's prior KIOSK_UPSELL charges.
kioskRouter.post('/sessions/:id/offers', deviceGuards, ok(
  (req) => kioskOffersService.acceptOffers(req.params.id, req.kioskDevice, req.body || {}),
));

// POST /api/kiosk/sessions/:id/id-photo-extract — { photo } → ADVISORY OCR
// of the license FRONT (B3d primary path). Returns fields for the customer
// confirm screen; stamps NOTHING (verify-id stays the only stamper).
kioskRouter.post('/sessions/:id/id-photo-extract', deviceGuards, ok(
  (req) => kioskCheckoutService.idPhotoExtract(req.params.id, req.kioskDevice, req.body || {}),
));

// POST /api/kiosk/sessions/:id/verify-id — { aamvaFields, licensePhoto?,
// selfiePhoto? } → booleans + failure reason codes ONLY (never echoes the
// stored DOB/license to the lobby screen).
kioskRouter.post('/sessions/:id/verify-id', deviceGuards, ok(
  (req) => kioskCheckoutService.verifyId(req.params.id, req.kioskDevice, req.body || {}),
));

// GET /api/kiosk/sessions/:id/agreement — T&C sections + key-terms summary (K7).
kioskRouter.get('/sessions/:id/agreement', deviceGuards, ok(
  (req) => kioskCheckoutService.getAgreement(req.params.id, req.kioskDevice),
));

// POST /api/kiosk/sessions/:id/sign — { sectionInitials: [{sectionKey,
// initialDataUrl}], signature, signerName? } → drives the real checkout
// state machine to CLOSED (per-section initials, NO pre-stamp). Requires the
// server-recorded verify-id stamp (409 ID_VERIFY_REQUIRED otherwise).
kioskRouter.post('/sessions/:id/sign', deviceGuards, ok(
  (req) => kioskCheckoutService.sign(req.params.id, req.kioskDevice, {
    ...(req.body || {}),
    customerIp: req.publicRequestMeta?.ip || req.ip,
  }),
));

// POST /api/kiosk/sessions/:id/sandbox-payment — B3 DEMO ONLY (403 unless
// KIOSK_PAYMENT_SANDBOX=true). Replaced by the B5 payment-link flow.
kioskRouter.post('/sessions/:id/sandbox-payment', deviceGuards, ok(
  (req) => kioskCheckoutService.sandboxPayment(req.params.id, req.kioskDevice),
));

// POST /api/kiosk/sessions/:id/complete — keys screen (K10). Lockbox code is
// only released once the checkout session is CLOSED.
kioskRouter.post('/sessions/:id/complete', deviceGuards, ok(
  (req) => kioskCheckoutService.complete(req.params.id, req.kioskDevice),
));

// ── B3c Staff Assist (K-S1..S3) — device-authed, session-bound like every
// /sessions/:id/* route; PIN misses feed the shared per-device lockout. ─────

// GET /api/kiosk/sessions/:id/staff-assist/staff — names-only picker.
kioskRouter.get('/sessions/:id/staff-assist/staff', deviceGuards, ok(
  (req) => kioskStaffAssistService.listAssistStaff(req.params.id, req.kioskDevice),
));

// POST /api/kiosk/sessions/:id/staff-assist/unlock — { userId, pin } →
// verifies the EXISTING lock-PIN and mints a 10-min session-bound grant.
kioskRouter.post('/sessions/:id/staff-assist/unlock', deviceGuards, ok(
  (req) => kioskStaffAssistService.unlock(req.params.id, req.kioskDevice, req.body || {}),
));

// POST /api/kiosk/sessions/:id/staff-assist/verify-id — { fields,
// licenseFrontPhoto, licenseBackPhoto } → audited scan bypass (age/expiry
// rules still enforced server-side; underage stays a hard stop).
kioskRouter.post('/sessions/:id/staff-assist/verify-id', deviceGuards, ok(
  (req) => kioskStaffAssistService.staffVerifyId(req.params.id, req.kioskDevice, req.body || {}),
));

// POST /api/kiosk/sessions/:id/staff-assist/confirm-name — B3e L3: staff
// vouches ONLY for the name (live grant required); rules stay hard stops;
// the reservation name is NOT changed.
kioskRouter.post('/sessions/:id/staff-assist/confirm-name', deviceGuards, ok(
  (req) => kioskStaffAssistService.confirmName(req.params.id, req.kioskDevice, req.body || {}),
));

// ── B3e L2: self-service verified-name update (possession code) ─────────────

// GET /api/kiosk/sessions/:id/name-update/destinations — READ-ONLY masked
// preview of where the code would go (shown before the guest burns a send).
kioskRouter.get('/sessions/:id/name-update/destinations', deviceGuards, ok(
  (req) => kioskNameUpdateService.destinations(req.params.id, req.kioskDevice),
));

// POST /api/kiosk/sessions/:id/name-update/send-code — 6-digit code to the
// RESERVATION's email (+ SMS best-effort); masked destinations only.
kioskRouter.post('/sessions/:id/name-update/send-code', deviceGuards, ok(
  (req) => kioskNameUpdateService.sendCode(req.params.id, req.kioskDevice),
));

// POST /api/kiosk/sessions/:id/name-update/confirm — { code, fields,
// licensePhoto? } → renames the driver to the LICENSE-VERIFIED name and
// stamps idVerifiedAt (method SCAN_NAME_UPDATED). Rules stay hard stops.
kioskRouter.post('/sessions/:id/name-update/confirm', deviceGuards, ok(
  (req) => kioskNameUpdateService.confirm(req.params.id, req.kioskDevice, req.body || {}),
));

// POST /api/kiosk/sessions/:id/escalate — { reason: ESCALATE_REASONS enum }
kioskRouter.post('/sessions/:id/escalate', deviceGuards, ok(
  (req) => kioskSessionService.escalate(req.params.id, req.kioskDevice, req.body || {}),
));
