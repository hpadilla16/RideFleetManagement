import { prisma } from '../../lib/prisma.js';
import { sendEmail as defaultSendEmail } from '../../lib/mailer.js';
import { renderBrandedEmail, resolveEmailBrand } from '../../lib/email-template.js';
import { settingsService } from '../settings/settings.service.js';
import { money } from '../../lib/money.js';
import logger from '../../lib/logger.js';

/**
 * Shared customer-facing reservation CONFIRMATION email.
 *
 * This is the exact builder that the public booking flow has always used
 * (extracted from booking-engine.service.js so the staff- and quote-convert
 * create paths can send the SAME branded confirmation instead of reinventing
 * one). It re-fetches the reservation, resolves the tenant's email templates +
 * brand, and renders reservation number, pickup/return dates, pickup + return
 * locations, vehicle, daily rate and estimated total.
 *
 * Mailer is overridable via the __test seam below so tests can capture the
 * outbound message without touching real SMTP/providers.
 */
let _sendEmail = defaultSendEmail;

// In-flight fire-and-forget confirmation sends (see fireConfirmationEmailOnCreate
// below). Tracked ONLY so tests have a seam to await the background send —
// production never awaits this; create() returns immediately.
const _pending = new Set();

export const __test = {
  setSender(fn) { _sendEmail = typeof fn === 'function' ? fn : defaultSendEmail; },
  reset() { _sendEmail = defaultSendEmail; },
  // Await every background confirmation send kicked off by
  // fireConfirmationEmailOnCreate. Test-only — lets a test observe that create()
  // returned BEFORE the send finished, then drain the send to assert its effect.
  async flushPending() { await Promise.allSettled(Array.from(_pending)); }
};

function customerName(customer) {
  return `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() || 'Customer';
}

function displayDateTime(value) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleString();
}

function renderTemplateString(value = '', replacements = {}) {
  return Object.entries(replacements).reduce(
    (out, [key, replacement]) => out.replaceAll(`{{${key}}}`, String(replacement ?? '')),
    String(value || '')
  );
}

/**
 * Build + send the branded confirmation email for a reservation.
 * Returns { emailSent, sentTo, warning } and NEVER throws on a mail failure
 * (the send is wrapped in try/catch; a bad SMTP config or provider outage
 * returns emailSent:false with a warning rather than propagating).
 *
 * @param {object}  reservation      - reservation row (needs id; customer/dates optional)
 * @param {object}  customer         - customer with an `email` (the address to send to)
 * @param {object}  tenant           - tenant row (for companyName); optional
 * @param {object}  pricingBreakdown - optional dueNow/total overrides
 * @param {object}  nextActions      - optional portal links (customerInfo/signature/payment)
 * @param {string}  bookingType      - RENTAL | CAR_SHARING | ...
 * @param {object}  trip             - optional car-sharing trip
 * @param {string}  vehicleLabel     - optional pre-resolved vehicle label
 * @param {string}  noteLabel        - label used in the audit note appended to reservation.notes
 */
export async function sendReservationConfirmationEmail({
  reservation,
  customer,
  tenant,
  pricingBreakdown = {},
  nextActions = {},
  bookingType = 'RENTAL',
  trip = null,
  vehicleLabel = '',
  noteLabel = 'PUBLIC BOOKING CONFIRMATION EMAIL'
} = {}) {
  if (!reservation?.id || !customer?.email) {
    return {
      emailSent: false,
      sentTo: [],
      warning: 'No customer email found for booking confirmation'
    };
  }

  const fullReservation = await prisma.reservation.findUnique({
    where: { id: reservation.id },
    include: {
      customer: true,
      pickupLocation: true,
      returnLocation: true,
      vehicle: true,
      vehicleType: true
    }
  });

  if (!fullReservation) {
    return {
      emailSent: false,
      sentTo: [],
      warning: 'Reservation not found for booking confirmation email'
    };
  }

  const guestName = customerName(fullReservation.customer || customer);
  const reference = trip?.tripCode || fullReservation.reservationNumber || reservation.reservationNumber || '-';
  const resolvedVehicleLabel = vehicleLabel
    || [
      fullReservation.vehicle?.year || '',
      fullReservation.vehicle?.make || '',
      fullReservation.vehicle?.model || ''
    ].filter(Boolean).join(' ')
    || fullReservation.vehicleType?.name
    || 'Vehicle';
  const dueNow = money(
    pricingBreakdown?.dueNow
    ?? pricingBreakdown?.depositDueNow
    ?? pricingBreakdown?.depositDue
    ?? pricingBreakdown?.amountDueNow
    ?? reservation?.amountDueNow
    ?? trip?.amountDueNow
    ?? 0
  );
  const estimatedTotal = money(
    pricingBreakdown?.guestTotal
    ?? pricingBreakdown?.reservationEstimate
    ?? pricingBreakdown?.estimatedTotal
    ?? reservation?.estimatedTotal
    ?? trip?.quotedTotal
    ?? 0
  );

  const replacements = {
    customerName: guestName,
    reservationNumber: String(fullReservation.reservationNumber || reservation?.reservationNumber || ''),
    tripCode: String(trip?.tripCode || ''),
    reference,
    bookingType: String(bookingType || 'RENTAL'),
    status: String(trip?.status || fullReservation.status || reservation?.status || '-'),
    pickupAt: displayDateTime(fullReservation.pickupAt || reservation?.pickupAt),
    returnAt: displayDateTime(fullReservation.returnAt || reservation?.returnAt),
    pickupLocation: fullReservation.pickupLocation?.name || '-',
    returnLocation: fullReservation.returnLocation?.name || '-',
    vehicle: resolvedVehicleLabel,
    dailyRate: reservation?.dailyRate != null ? `$${Number(reservation.dailyRate).toFixed(2)}` : '-',
    estimatedTotal: `$${estimatedTotal.toFixed(2)}`,
    dueNow: `$${dueNow.toFixed(2)}`,
    companyName: tenant?.name || fullReservation.pickupLocation?.name || 'Ride Fleet',
    customerInfoLink: nextActions?.customerInfo?.link || '',
    signatureLink: nextActions?.signature?.link || '',
    paymentLink: nextActions?.payment?.link || ''
  };

  const tpl = await settingsService.getEmailTemplates({ tenantId: fullReservation.tenantId || null });
  const subject = renderTemplateString(
    tpl.reservationDetailSubject || 'Reservation Details - {{reservationNumber}}',
    replacements
  );
  const baseText = renderTemplateString(
    tpl.reservationDetailBody || 'Hello {{customerName}},\n\nReservation #: {{reservationNumber}}',
    replacements
  );
  const baseHtml = renderTemplateString(
    tpl.reservationDetailHtml || String(baseText).replaceAll('\n', '<br/>'),
    replacements
  );

  const nextStepLines = [
    '',
    'Next steps:',
    nextActions?.customerInfo?.link ? `Complete customer info: ${nextActions.customerInfo.link}` : null,
    nextActions?.signature?.link ? `Open agreement signature: ${nextActions.signature.link}` : null,
    nextActions?.payment?.link ? `Pay now: ${nextActions.payment.link}` : null,
    '',
    dueNow > 0 ? `Amount due now: $${dueNow.toFixed(2)}` : 'No payment is due right now.'
  ].filter(Boolean);

  const nextStepHtml = `
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid #e5e7eb">
      <div style="font-weight:700;margin-bottom:8px">Next steps</div>
      ${nextActions?.customerInfo?.link ? `<div style="margin-bottom:6px">Complete customer info: <a href="${nextActions.customerInfo.link}">${nextActions.customerInfo.link}</a></div>` : ''}
      ${nextActions?.signature?.link ? `<div style="margin-bottom:6px">Open agreement signature: <a href="${nextActions.signature.link}">${nextActions.signature.link}</a></div>` : ''}
      ${nextActions?.payment?.link ? `<div style="margin-bottom:6px">Pay now: <a href="${nextActions.payment.link}">${nextActions.payment.link}</a></div>` : ''}
      <div style="margin-top:10px">${dueNow > 0 ? `Amount due now: <strong>$${dueNow.toFixed(2)}</strong>` : 'No payment is due right now.'}</div>
    </div>
  `;

  try {
    let confirmBrand;
    try { confirmBrand = await resolveEmailBrand({ tenantId: fullReservation.tenantId || null }); } catch { confirmBrand = undefined; }
    const confirmInnerText = [baseText, ...nextStepLines].join('\n');
    const { html: confirmHtml, text: confirmText } = renderBrandedEmail({
      brand: confirmBrand,
      heading: 'Your reservation is confirmed',
      bodyHtml: `${baseHtml}${nextStepHtml}`,
      bodyText: confirmInnerText,
      cta: nextActions?.payment?.link
        ? { label: 'Pay now', url: nextActions.payment.link }
        : nextActions?.signature?.link
          ? { label: 'Open agreement signature', url: nextActions.signature.link }
          : nextActions?.customerInfo?.link
            ? { label: 'Complete customer info', url: nextActions.customerInfo.link }
            : undefined,
      preheader: subject,
    });
    await _sendEmail({ fromName: confirmBrand?.companyName, fromEmail: confirmBrand?.fromEmail || undefined,
      to: customer.email,
      subject,
      text: confirmText,
      html: confirmHtml
    });
    const note = `[${noteLabel} ${new Date().toISOString()}] emailed to ${customer.email}`;
    await prisma.reservation.update({
      where: { id: fullReservation.id },
      data: {
        notes: fullReservation.notes ? `${fullReservation.notes}\n${note}` : note
      }
    });
    return {
      emailSent: true,
      sentTo: [customer.email],
      warning: null
    };
  } catch (mailError) {
    const warning = `Unable to send reservation confirmation email: ${String(mailError?.message || mailError)}`;
    return {
      emailSent: false,
      sentTo: [customer.email],
      warning
    };
  }
}

/**
 * Consume the (historically DEAD) `sendConfirmationEmail` flag at reservation
 * create time: fire an immediate customer confirmation email for staff- and
 * quote-convert-created reservations.
 *
 * Rules (this comment is the canonical source of truth — there is no external doc):
 *  - Opt-out: if the flag is explicitly FALSE, send NOTHING. Every automated /
 *    public / integration create path sets it false, so this NEVER double-emails
 *    them (the public booking flow sends its own confirmation).
 *  - ON-FILE email only: the address comes from the persisted customer, NEVER
 *    from a request payload (VozIA can't change a customer's email). ~50% of
 *    VozIA reservations have no email → skip silently, no error.
 *  - Idempotent: guarded by the `confirmationEmailSentAt` stamp so a re-entry
 *    for the same reservation never re-sends. Stamp is set after a successful
 *    send (also serves as observability).
 *  - Best-effort: this function NEVER throws. A mail failure logs a warn and the
 *    reservation stands.
 *
 * @param {object} reservation - the just-created reservation row. Must include
 *   `customer` (id/email/firstName/lastName) — reservationsService.create's
 *   create() already selects it.
 * @param {boolean|undefined} sendConfirmationEmail - the flag as passed to create
 *   (undefined defaults to true — staff + quote-convert paths).
 */
export async function maybeSendConfirmationEmailOnCreate({ reservation, sendConfirmationEmail } = {}) {
  try {
    if (!reservation?.id) return { skipped: 'no-reservation' };
    // Opt-out path — integration/public/automation creates set this false.
    if (sendConfirmationEmail === false) return { skipped: 'flag-false' };
    // Idempotency: never re-send if already stamped.
    if (reservation.confirmationEmailSentAt) return { skipped: 'already-sent' };

    // ON-FILE email only — never a payload-supplied address.
    const customer = reservation.customer || null;
    const onFileEmail = String(customer?.email || '').trim();
    if (!onFileEmail) return { skipped: 'no-email' };

    let tenant = null;
    if (reservation.tenantId) {
      try {
        tenant = await prisma.tenant.findUnique({
          where: { id: reservation.tenantId },
          select: { name: true }
        });
      } catch { tenant = null; }
    }

    const result = await sendReservationConfirmationEmail({
      reservation,
      customer: { ...customer, email: onFileEmail },
      tenant,
      bookingType: reservation.workflowMode || 'RENTAL',
      noteLabel: 'RESERVATION CONFIRMATION EMAIL'
    });

    if (result?.emailSent) {
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { confirmationEmailSentAt: new Date() }
      });
      return { sent: true, to: onFileEmail };
    }

    logger.warn(
      { reservationId: reservation.id, warning: result?.warning || null },
      '[reservation-confirmation] confirmation email not sent'
    );
    return { sent: false, warning: result?.warning || null };
  } catch (err) {
    // Best-effort: an email failure must never fail or roll back the reservation.
    logger.warn(
      { reservationId: reservation?.id || null, err: String(err?.message || err) },
      '[reservation-confirmation] confirmation email threw (swallowed)'
    );
    return { sent: false, error: String(err?.message || err) };
  }
}

/**
 * Shared fire-and-forget MECHANICS for the two wrappers below. Deliberately holds
 * no email POLICY — which email gets sent, and under what guards, stays in the
 * wrappers, because the create path and the public-booking path answer that
 * differently (opt-out flag + idempotency stamp vs. neither).
 *
 * Registers the promise in `_pending` so shutdown/tests can drain it, swallows
 * rejections, and — importantly — escalates a resolved-but-FAILED send to
 * logger.error. Before these paths went async the outcome travelled back to the
 * caller in the response; now this log line is the ONLY trace that a customer
 * never received their confirmation, so it must not hide at warn level.
 *
 * A `{ skipped: ... }` result is NOT a failure (opt-out flag, no e-mail on file,
 * already sent) and stays silent — roughly half of VozIA reservations have no
 * e-mail address, and those must not generate error noise.
 */
function fireAndForget(run, { reservationId = null, label = 'email', onReject } = {}) {
  const p = Promise.resolve()
    .then(run)
    .then((result) => {
      const failed = result?.emailSent === false || result?.sent === false;
      if (failed) {
        // winston takes (message, meta) — an object first makes `message` an
        // object and drops the text, which would make this line ungreppable.
        logger.error(
          `[reservation-confirmation] ${label} did NOT send (background)`,
          { reservationId, warning: result?.warning || result?.error || null }
        );
      }
      return result;
    })
    .catch((err) => {
      // best-effort — a background send can never break (or delay) its caller
      logger.error(
        `[reservation-confirmation] ${label} rejected in background (swallowed)`,
        { reservationId, err: String(err?.message || err) }
      );
      return typeof onReject === 'function' ? onReject(err) : undefined;
    })
    .finally(() => { _pending.delete(p); });
  _pending.add(p);
  return p;
}

/**
 * FIRE-AND-FORGET wrapper around maybeSendConfirmationEmailOnCreate for the
 * reservationsService.create() hook.
 *
 * WHY: the SMTP send takes seconds. Awaiting it inside create() blocked the
 * create response (and thus VozIA's quote-convert), and that latency made VozIA
 * re-reserve → DUPLICATE reservations. So create() must NOT await the send: it
 * kicks it off here and returns immediately; the email + confirmationEmailSentAt
 * stamp land asynchronously in the background (the email was always best-effort).
 *
 * The underlying helper never throws (internal try/catch); the `.catch()` here is
 * belt-and-suspenders so a floating rejection can never surface. The promise is
 * registered in `_pending` purely so tests can await it via __test.flushPending()
 * — production code never awaits the returned promise.
 */
export function fireConfirmationEmailOnCreate({ reservation, sendConfirmationEmail } = {}) {
  return fireAndForget(
    () => maybeSendConfirmationEmailOnCreate({ reservation, sendConfirmationEmail }),
    {
      reservationId: reservation?.id || null,
      label: 'confirmation email',
      onReject: (err) => ({ sent: false, error: String(err?.message || err) })
    }
  );
}

/**
 * FIRE-AND-FORGET wrapper around sendReservationConfirmationEmail for the two
 * PUBLIC BOOKING create paths in booking-engine.service.js (RENTAL + CAR_SHARING).
 *
 * WHY: both paths awaited the SMTP send inside the create request, adding ~4-5s
 * to every booking made from the website. Unlike the VozIA quote-convert incident
 * that motivated fireConfirmationEmailOnCreate, this never caused DUPLICATES —
 * the website does not auto-retry — it was pure latency. The email is best-effort
 * either way, so we kick the send off and let the request return immediately.
 *
 * DIFFERENCE vs fireConfirmationEmailOnCreate: that one wraps
 * maybeSendConfirmationEmailOnCreate, which adds the sendConfirmationEmail opt-out
 * flag and the confirmationEmailSentAt idempotency stamp (staff + quote-convert
 * path). This one wraps the RAW sender, which is what the public paths have always
 * called — no flag, no stamp. Kept deliberately separate: giving the public paths
 * the stamp would change WHICH emails they send, and that is a behavior change,
 * not a latency fix.
 *
 * sendReservationConfirmationEmail swallows MAIL errors internally, but its
 * reservation re-fetch (~line 89) and its getEmailTemplates call (~line 157) both
 * sit OUTSIDE that try/catch, so a DB blip in either can still reject despite the
 * function's JSDoc. fireAndForget's `.catch()` makes the floating promise safe
 * either way.
 */
export function firePublicBookingConfirmationEmail(input = {}) {
  return fireAndForget(() => sendReservationConfirmationEmail(input), {
    reservationId: input?.reservation?.id || null,
    label: 'public booking confirmation email',
    onReject: (err) => ({ emailSent: false, sentTo: [], warning: String(err?.message || err) })
  });
}
