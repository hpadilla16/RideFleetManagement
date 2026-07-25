/**
 * Ride Kiosk — Fase B5 Phase 1: live-payment GUARDS (2026-07-24).
 * Design: doc/kiosk-b5-payment-design-2026-07-16.md §10A (QA §19).
 *
 * ⚠️ NO GATEWAY CODE LIVES HERE and none may be added. This module decides
 * WHETHER a kiosk payment call is allowed to happen; it never makes one.
 *
 * ── THE SEAM (structurally unbypassable by design) ──────────────────────────
 * The future gateway layer must NOT call `assertKioskPaymentAllowed` and then
 * separately call iPOS — that pattern is trivially forgotten in a later
 * refactor. It must call:
 *
 *     await withKioskPaymentGuard(ctx, async () => iposHpp.createPaymentLink(…))
 *
 * The gateway call only exists INSIDE the callback, so it is unreachable
 * unless the guards passed. Reviewers: a `payment-gateway`/`ipos`/`spin`
 * import inside the kiosk module that is not wrapped by this helper is a
 * defect, not a style nit.
 *
 * Guards (ALL must pass, fail-closed at every step):
 *   1. KIOSK_PAYMENT_LIVE === 'true'                      (kill switch, default OFF)
 *   2. in production, ALSO KIOSK_PAYMENT_LIVE_ALLOW_PROD  (double key — B3a pattern)
 *   3. amount <= KIOSK_PAYMENT_MAX_AMOUNT (default $5)    (hard server-side ceiling)
 *   4. reservationId ∈ KIOSK_PAYMENT_RESERVATION_ALLOWLIST
 *   5. deviceId ∈ KIOSK_PAYMENT_DEVICE_ALLOWLIST and locationId ∈ KIOSK_PAYMENT_LOCATION_ALLOWLIST
 *   6. now <= KIOSK_PAYMENT_LIVE_UNTIL                    (auto-expiring flag)
 *
 * Why the ceiling is not optional (QA §19): reservation-wins precedence means
 * lowering `kioskDepositConfig` by hand does NOT lower the hold — the manual
 * step is not a control. The ceiling is enforced here, at the call boundary,
 * on the amount actually about to be sent.
 *
 * DRY RUN: KIOSK_PAYMENT_DRY_RUN (or the shared SPIN_DRY_RUN /
 * IPOS_TRANSACT_DRY_RUN) lets CI exercise the whole state machine — including
 * the rollback and sweep arms — with the gateway callback never invoked.
 */

import logger from '../../lib/logger.js';
import { KioskError } from './kiosk-device.service.js';

export const DEFAULT_MAX_AMOUNT = 5;

function envFlag(name) {
  return String(process.env[name] || '').toLowerCase() === 'true';
}

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Shared dry-run switch — mirrors SPIN_DRY_RUN / IPOS_TRANSACT_DRY_RUN. */
export function isKioskPaymentDryRun() {
  return envFlag('KIOSK_PAYMENT_DRY_RUN')
    || envFlag('SPIN_DRY_RUN')
    || envFlag('IPOS_TRANSACT_DRY_RUN');
}

export function kioskPaymentMaxAmount() {
  const raw = Number(process.env.KIOSK_PAYMENT_MAX_AMOUNT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AMOUNT;
}

/**
 * Fail-closed evaluation of every guard. Returns { allowed, dryRun } or throws
 * KioskError(403 KIOSK_PAYMENT_BLOCKED) with a `reason` naming the first gate
 * that refused (audit trail; never leaked to the guest screen verbatim).
 */
export function assertKioskPaymentAllowed({ amount, reservationId, deviceId, locationId } = {}) {
  const block = (reason, message) => {
    logger.warn('[kiosk-payment-guard] BLOCKED', { reason, reservationId, deviceId, locationId });
    throw new KioskError(message || 'Kiosk live payment is not enabled', 403, 'KIOSK_PAYMENT_BLOCKED', { reason });
  };

  // 1 + 2 — kill switch, with a production double key.
  if (!envFlag('KIOSK_PAYMENT_LIVE')) block('FLAG_OFF');
  if (process.env.NODE_ENV === 'production' && !envFlag('KIOSK_PAYMENT_LIVE_ALLOW_PROD')) {
    block('PROD_DOUBLE_KEY_MISSING');
  }

  // 6 — auto-expiring flag: an ISO timestamp past which the switch self-disables.
  const until = String(process.env.KIOSK_PAYMENT_LIVE_UNTIL || '').trim();
  if (!until) block('NO_EXPIRY_SET', 'Kiosk live payment requires an expiry window');
  const untilTs = new Date(until).getTime();
  if (!Number.isFinite(untilTs)) block('BAD_EXPIRY');
  if (Date.now() > untilTs) block('WINDOW_EXPIRED');

  // 3 — hard server-side amount ceiling on the amount actually being sent.
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) block('BAD_AMOUNT');
  const ceiling = kioskPaymentMaxAmount();
  if (amt > ceiling) {
    block('AMOUNT_OVER_CEILING', `Amount ${amt} exceeds the live-test ceiling of ${ceiling}`);
  }

  // 4 — reservation allowlist (never a real customer's booking by accident).
  const reservations = envList('KIOSK_PAYMENT_RESERVATION_ALLOWLIST');
  if (!reservations.length) block('NO_RESERVATION_ALLOWLIST');
  if (!reservations.includes(String(reservationId || ''))) block('RESERVATION_NOT_ALLOWLISTED');

  // 5 — device + location pin.
  const devices = envList('KIOSK_PAYMENT_DEVICE_ALLOWLIST');
  if (!devices.length) block('NO_DEVICE_ALLOWLIST');
  if (!devices.includes(String(deviceId || ''))) block('DEVICE_NOT_ALLOWLISTED');

  const locations = envList('KIOSK_PAYMENT_LOCATION_ALLOWLIST');
  if (!locations.length) block('NO_LOCATION_ALLOWLIST');
  if (!locations.includes(String(locationId || ''))) block('LOCATION_NOT_ALLOWLISTED');

  // The VALIDATED amount is returned so the caller never has to re-derive it —
  // see withKioskPaymentGuard, which hands exactly this number to the gateway
  // callback (review R1). The ceiling therefore binds the amount actually sent.
  return { allowed: true, dryRun: isKioskPaymentDryRun(), amount: amt };
}

/**
 * THE seam every future kiosk gateway call must route through. `fn` is only
 * ever invoked when all guards passed AND dry-run is off.
 *
 * The callback receives `{ amount }` — the VALIDATED, ceiling-checked number
 * (review R1). Gateway code must send THAT amount and never re-read it from
 * anywhere else; doing so would route around the ceiling.
 *
 * ── DRY-RUN RECIPE (review R6) ─────────────────────────────────────────────
 * dryRun is evaluated AFTER every guard, so setting only KIOSK_PAYMENT_DRY_RUN
 * does nothing — the call is blocked before it reaches the branch. CI must set
 * the FULL arming env as well:
 *     KIOSK_PAYMENT_LIVE=true
 *     KIOSK_PAYMENT_LIVE_UNTIL=<future ISO timestamp>
 *     KIOSK_PAYMENT_RESERVATION_ALLOWLIST=<reservationId>
 *     KIOSK_PAYMENT_DEVICE_ALLOWLIST=<deviceId>
 *     KIOSK_PAYMENT_LOCATION_ALLOWLIST=<locationId>
 *     KIOSK_PAYMENT_DRY_RUN=true       (or SPIN_DRY_RUN / IPOS_TRANSACT_DRY_RUN)
 *     # in production only: KIOSK_PAYMENT_LIVE_ALLOW_PROD=true
 * That ordering is deliberate: dry-run is a way to exercise an ARMED flow
 * without money, not a way to bypass the arming rules.
 */
export async function withKioskPaymentGuard(ctx = {}, fn, { dryRunResult = null } = {}) {
  const { dryRun, amount } = assertKioskPaymentAllowed(ctx);
  if (dryRun) {
    logger.warn('[kiosk-payment-guard] DRY RUN — gateway call skipped', {
      reservationId: ctx.reservationId, deviceId: ctx.deviceId, amount: ctx.amount,
    });
    return dryRunResult ?? { dryRun: true, skipped: true };
  }
  logger.warn('[kiosk-payment-guard] LIVE payment call authorized', {
    reservationId: ctx.reservationId, deviceId: ctx.deviceId,
    locationId: ctx.locationId, amount,
  });
  return fn({ amount });
}
