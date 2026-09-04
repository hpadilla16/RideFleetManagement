/**
 * The kiosk's payment link — deliberately NOT inside src/modules/kiosk.
 *
 * A structural guard (payment-references.test.mjs R2) forbids any kiosk module
 * file from importing a gateway client, so that the live-payment guards cannot
 * be bypassed by someone reaching past them. That rule is right, and it is why
 * this lives here instead: the dependency points INWARD (payment-gateway may
 * know about the kiosk; the kiosk may not know about a gateway), and every
 * gateway call goes through withKioskPaymentGuard.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { KioskError } from '../kiosk/kiosk-device.service.js';
import { getSessionForDevice, requireInProgress, recordSessionTelemetry } from '../kiosk/kiosk-session.service.js';
import { loadCheckoutSessionFor, isTerminal } from '../kiosk/kiosk-checkout.service.js';
import { withKioskPaymentGuard } from '../kiosk/kiosk-payment-guards.js';
import { kioskPaymentIntentService } from '../kiosk/kiosk-payment-intent.service.js';
import { mintHppSession, verifyAndRecordHppReturn } from './ipos-hpp-payment.service.js';

async function createPaymentLink(sessionId, device) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  const cs = await loadCheckoutSessionFor(session, device);
  if (isTerminal(cs.currentStep)) {
    throw new KioskError(`Checkout is already ${cs.currentStep.toLowerCase()}`, 409, 'CHECKOUT_TERMINAL');
  }
  if (!cs.agreementId) throw new KioskError('No agreement linked to this checkout', 409, 'NO_AGREEMENT');

  const [agreement, reservation] = await Promise.all([
    prisma.rentalAgreement.findUnique({
      where: { id: cs.agreementId },
      select: { id: true, balance: true },
    }),
    prisma.reservation.findFirst({
      where: { id: session.reservationId, tenantId: device.tenantId },
      select: { id: true, tenantId: true, reservationNumber: true },
    }),
  ]);
  if (!agreement || !reservation) throw new KioskError('No agreement linked to this checkout', 409, 'NO_AGREEMENT');

  // RentalAgreement.balance is the unpaid source of truth for this system —
  // ReservationCharge and estimatedTotal are the rent only. Asking the guest for
  // anything else would charge a number the counter does not recognise.
  const amount = Number(agreement.balance || 0);
  if (!(amount > 0)) {
    throw new KioskError('Nothing is due on this reservation', 409, 'NOTHING_DUE');
  }

  // The gateway call is WRAPPED, not merely preceded by an assertion. The guard
  // owns the kill switch, the production double key, the ceiling, the expiring
  // window AND the dry-run short-circuit — so nothing can reach iPOS except
  // through it. This is the shape payment-references.test.mjs R2 exists to force.
  const intent = await kioskPaymentIntentService.ensureIntent(sessionId, device);
  const base = (process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');

  const minted = await withKioskPaymentGuard(
    {
      amount,
      reservationId: reservation.id,
      deviceId: device.id,
      locationId: device.locationId || null,
    },
    () => mintHppSession({
      reservation,
      amount,
      origin: 'KIOSK',
      // paymentIntentRef, NOT intent.reference. `reference` is the INTERNAL
      // form `IPOS:<ref>` — the colon and the extra length both fail the
      // gateway's own `^[A-Za-z0-9]{1,20}$` check, so every live mint would have
      // thrown before reaching iPOS. It survived review because the test passed a
      // hand-written reference the real caller never produces, against a fake
      // mint that does not validate. (QA B2.)
      reuseReferenceId: intent.paymentIntentRef,
      description: `Kiosk check-in ${reservation.reservationNumber || reservation.id}`,
      buildReturnUrl: (ref) => `${base}/api/kiosk/payment-return?ref=${encodeURIComponent(ref)}`,
    }),
    // Dry run must never hand back something a screen would render as payable.
    { dryRunResult: { url: null, referenceId: intent.paymentIntentRef, dryRun: true } },
  );
  const { url, referenceId } = minted || {};

  await recordSessionTelemetry(session, {
    step: 'PAYMENT',
    event: intent.reused ? 'PAYMENT_LINK_REUSED' : 'PAYMENT_LINK_CREATED',
    data: null,
  });
  logger.info('[kiosk-checkout] payment link minted', {
    sessionId: session.id, tenantId: device.tenantId, reused: !!intent.reused, amount,
  });

  // The URL is what the QR encodes. The kiosk renders it client-side; no image
  // is generated or stored server-side, so nothing card-adjacent is persisted.
  return { ok: true, url: url || null, reference: referenceId, amount, reused: !!intent.reused };
}



export const kioskPaymentLinkService = { createPaymentLink, handlePaymentReturn };

/**
 * The guest's phone comes back here after paying (QA B3 — this route did not
 * exist, so a real payment would have landed on a 404 and only surfaced later as
 * an orphan).
 *
 * NEVER trusts the redirect. The browser carries only our own reference; the
 * amount and the approval are re-read from the gateway before anything is
 * recorded. The reference resolves back to its kiosk session even after the
 * session was wiped, which is the whole reason the binding lives on the row.
 */
async function handlePaymentReturn(rawRef) {
  const ref = String(rawRef || '').trim();
  if (!ref) throw new KioskError('Missing payment reference', 400, 'MISSING_REFERENCE');

  const resolved = await kioskPaymentIntentService.resolveByReference(ref);
  if (!resolved?.reservationId) {
    // Cannot be tied to a reservation → the staff queue, never a silent drop.
    await kioskPaymentIntentService.flagOrphanPayment({
      reference: ref, tenantId: resolved?.tenantId || null,
      note: 'HPP return could not be resolved to a kiosk session',
    }).catch(() => {});
    throw new KioskError('This payment could not be matched — staff have been notified', 404, 'ORPHAN_PAYMENT');
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id: resolved.reservationId },
    select: { id: true, tenantId: true, reservationNumber: true },
  });
  if (!reservation) throw new KioskError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');

  const verdict = await verifyAndRecordHppReturn({ reservation, iposRef: ref });
  if (resolved.kioskSessionId) {
    await prisma.kioskSession.update({
      where: { id: resolved.kioskSessionId },
      data: { paymentIntentState: 'PAID', lastActivityAt: new Date() },
    }).catch((err) => logger.warn('[kiosk-payment] could not stamp session PAID', { err: err?.message }));
  }
  logger.info('[kiosk-payment] hosted page return recorded', {
    reservationId: reservation.id, duplicate: !!verdict?.duplicate,
  });
  return { ok: true, paid: true, duplicate: !!verdict?.duplicate };
}

