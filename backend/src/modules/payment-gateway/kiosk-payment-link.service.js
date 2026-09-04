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
import { mintHppSession } from './ipos-hpp-payment.service.js';

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
      reuseReferenceId: intent.reference,
      description: `Kiosk check-in ${reservation.reservationNumber || reservation.id}`,
      buildReturnUrl: (ref) => `${base}/api/kiosk/payment-return?ref=${encodeURIComponent(ref)}`,
    }),
    // Dry run must never hand back something a screen would render as payable.
    { dryRunResult: { url: null, referenceId: intent.reference, dryRun: true } },
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



export const kioskPaymentLinkService = { createPaymentLink };
