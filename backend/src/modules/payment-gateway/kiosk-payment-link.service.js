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
import { maybeCreateAgreementPayment } from '../reservations/reservation-pricing.service.js';
import { checkoutSessionService } from '../checkout-session/checkout-session.service.js';

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
  let intent = await kioskPaymentIntentService.ensureIntent(sessionId, device);

  // THE LINK IS REUSED, NOT JUST THE REFERENCE. The first version reused the
  // reference and then minted a fresh hosted-page session on every press — so a
  // second live link went into the world each time, and a guest who paid both
  // produced a second charge the reference-based dedupe could not see. The
  // commit even claimed the opposite. Now: same amount → the stored link comes
  // back and NOTHING is minted. `session` was read before ensureIntent, and a
  // reused intent leaves the row untouched, so its stored link is current.
  const storedUrl = intent.reused ? (session.paymentIntentUrl || null) : null;
  const storedAmount = intent.reused && session.paymentIntentAmount != null
    ? Number(session.paymentIntentAmount)
    : null;
  if (storedUrl && storedAmount === amount) {
    await recordSessionTelemetry(session, { step: 'PAYMENT', event: 'PAYMENT_LINK_REUSED', data: null });
    return { ok: true, url: storedUrl, reference: intent.paymentIntentRef, amount, reused: true, minted: false };
  }
  // A stored link for a DIFFERENT amount would undercharge — the guest went back
  // and accepted or dropped an upsell. The old link stays payable at the gateway
  // (there is no documented cancel), so the intent is SUPERSEDED: new reference,
  // new link, old reference retained so a late payment on it still resolves.
  if (storedUrl && storedAmount !== amount) {
    logger.warn('[kiosk-checkout] balance moved since the link was minted — superseding', {
      sessionId: session.id, was: storedAmount, now: amount,
    });
    intent = await kioskPaymentIntentService.supersedeIntent(sessionId, device);
  }

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
  // Persist the link WITH the amount it was minted for, so the next press can
  // tell "same link" from "stale link". Only a real URL is stored: a dry run
  // hands back null, and null must never be remembered as "the link".
  if (url) {
    await prisma.kioskSession.update({
      where: { id: session.id },
      data: { paymentIntentUrl: url, paymentIntentAmount: amount },
    }).catch((err) => logger.warn('[kiosk-checkout] could not persist payment link', { err: err?.message }));
  }

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
  return { ok: true, url: url || null, reference: referenceId, amount, reused: !!intent.reused, minted: !!url };
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
async function handlePaymentReturn(rawRef, deps = {}) {
  const db = deps.prisma || prisma;
  const verifyAndRecord = deps.verifyAndRecord || verifyAndRecordHppReturn;
  const mirrorToAgreement = deps.mirrorToAgreement || maybeCreateAgreementPayment;
  const flagOrphan = deps.flagOrphan || kioskPaymentIntentService.flagOrphanPayment;
  const stampCheckout = deps.stampCheckout || ((args) => checkoutSessionService.stampSideEffect(args));
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

  const reservation = await db.reservation.findUnique({
    where: { id: resolved.reservationId },
    select: {
      id: true, tenantId: true, reservationNumber: true,
      // The agreement is what the kiosk quoted against, and what the counter reads.
      rentalAgreement: { select: { id: true, status: true } },
    },
  });
  if (!reservation) throw new KioskError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');

  const verdict = await verifyAndRecord({
    reservation, iposRef: ref,
    // This is a KIOSK payment, but ReservationPaymentOrigin has no KIOSK member
    // (OTC | PORTAL | IMPORTED | MIGRATED_NOTE) — passing one would make Prisma
    // reject EVERY kiosk payment insert, and the unit tests would not have caught
    // it because they inject the verifier. PORTAL is the honest existing bucket
    // ("the guest paid on their own device"); the note is what tells them apart.
    // Adding a KIOSK origin is a migration plus a reporting change — its own PR.
    origin: 'PORTAL', notes: 'Paid via iPOSpays hosted payment page (kiosk check-in)',
  }, deps);

  // THE MONEY MUST REACH THE AGREEMENT. The kiosk quoted RentalAgreement.balance,
  // but the shared verifier only writes a ReservationPayment — and that balance is
  // computed ONLY from RentalAgreementPayment. Without this mirror the counter kept
  // seeing the full balance after the guest had paid, and charged them again.
  //
  // Gated on the LEDGER, not on the verdict. The first version skipped the mirror
  // whenever the verifier said `duplicate` — so if the mirror threw once (the guest
  // saw a 500 after paying), every retry was a "duplicate" and the agreement stayed
  // unpaid forever, with no flag. Now: a reservation row exists for this reference
  // and no agreement row does → mirror, whatever the verdict says. That makes the
  // retry the cure instead of the trap. (QA re-review, MAJOR A.)
  if (reservation.rentalAgreement?.id) {
    const payment = await db.reservationPayment.findFirst({
      where: { reservationId: reservation.id, reference: verdict.reference },
    });
    const already = payment
      ? await db.rentalAgreementPayment.findFirst({
        where: { rentalAgreementId: reservation.rentalAgreement.id, reference: verdict.reference },
        select: { id: true },
      })
      : null;
    if (payment && !already) {
      try {
        await mirrorToAgreement({ reservation, payment });
      } catch (err) {
        // Loud AND flagged. A payment on the reservation but not the agreement is
        // exactly the overcharge this block exists to end; staff must see it even
        // if the guest's next refresh happens to heal it.
        logger.error('[kiosk-payment] payment recorded on reservation but NOT mirrored to agreement — counter will overcharge', {
          reservationId: reservation.id, reference: verdict.reference, err: err?.message,
        });
        await flagOrphan({
          reference: ref, amount: verdict.amount ?? null, tenantId: reservation.tenantId,
          note: `Payment recorded on the reservation but the agreement ledger write failed (${err?.message || 'unknown'}). Balance is stale until it is mirrored — refresh the return URL or post it manually.`,
        }).catch(() => {});
        throw err;
      }
    }
  }

  // A payment on a SUPERSEDED link, or on a session that already ended, is
  // recorded (the money is real) but it is staff-queue material: the guest paid
  // an old QR that iPOS cannot cancel, so if they also paid the new one this is
  // an overpayment that only shows up as paidAmount > total. The intent service
  // promised this would be flagged; the first version dropped it. (QA MAJOR C.)
  if (resolved.superseded || !resolved.sessionLive) {
    await flagOrphan({
      reference: ref, amount: verdict.amount ?? null, tenantId: reservation.tenantId,
    }).catch(() => {});
  }

  // LET THE GUEST FINISH. The signature step refuses until the checkout carries
  // paymentCompletedAt, and the tablet polls nothing — so after a real payment
  // the kiosk was simply dead until staff intervened. Stamp it only when the
  // agreement is actually settled: a partial payment must not unlock signing.
  // (QA MAJOR B.)
  if (reservation.rentalAgreement?.id && resolved.kioskSessionId) {
    const [agreementNow, kioskSession] = await Promise.all([
      db.rentalAgreement.findUnique({ where: { id: reservation.rentalAgreement.id }, select: { balance: true } }),
      db.kioskSession.findUnique({ where: { id: resolved.kioskSessionId }, select: { checkoutSessionId: true } }),
    ]);
    const settled = agreementNow && Number(agreementNow.balance || 0) <= 0;
    if (settled && kioskSession?.checkoutSessionId) {
      await stampCheckout({ id: kioskSession.checkoutSessionId, field: 'paymentCompletedAt' })
        .catch((err) => logger.warn('[kiosk-payment] could not stamp paymentCompletedAt — guest may need staff to proceed', {
          checkoutSessionId: kioskSession.checkoutSessionId, err: err?.message,
        }));
    }
  }

  if (resolved.kioskSessionId) {
    await db.kioskSession.update({
      where: { id: resolved.kioskSessionId },
      data: { paymentIntentState: 'PAID', lastActivityAt: new Date() },
    }).catch((err) => logger.warn('[kiosk-payment] could not stamp session PAID', { err: err?.message }));
  }
  logger.info('[kiosk-payment] hosted page return recorded', {
    reservationId: reservation.id, duplicate: !!verdict?.duplicate,
  });
  return { ok: true, paid: true, duplicate: !!verdict?.duplicate };
}
