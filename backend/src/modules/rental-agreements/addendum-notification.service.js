import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import logger from '../../lib/logger.js';

// Mirrors the helper used by public-booking.service.js so the addendum
// magic-link URL resolves to the same customer-portal origin in every
// environment. Falls back to localhost:3000 for local dev.
function baseUrl() {
  const raw =
    process.env.CUSTOMER_PORTAL_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    'http://localhost:3000';
  return String(raw).replace(/\/$/, '');
}

/**
 * Fire a customer-facing email notifying that a new rental agreement addendum
 * has been created and is awaiting their signature.
 *
 * The function NEVER throws: a missing customer email, SMTP failure, or any
 * other error must not roll back the addendum write that triggered it. All
 * failures are logged and swallowed.
 *
 * Called from the addendum-create route immediately after the row is written.
 *
 * @param {string} rentalAgreementId
 * @param {string} addendumId
 * @param {string|null} tenantId  - tenant scope; when present, lookups are filtered.
 * @returns {Promise<{ sent?: true, skipped?: string, error?: string }>}
 */
export async function scheduleAddendumNotification(rentalAgreementId, addendumId, tenantId = null) {
  try {
    if (!rentalAgreementId || !addendumId) {
      return { skipped: 'missing-ids' };
    }

    const [agreement, addendum] = await Promise.all([
      prisma.rentalAgreement.findFirst({
        where: { id: rentalAgreementId, ...(tenantId ? { tenantId } : {}) },
        select: {
          id: true,
          agreementNumber: true,
          customerEmail: true,
          customerFirstName: true,
          customerLastName: true
        }
      }),
      prisma.rentalAgreementAddendum.findFirst({
        where: { id: addendumId, ...(tenantId ? { tenantId } : {}) },
        select: {
          id: true,
          pickupAt: true,
          returnAt: true,
          reason: true,
          status: true,
          signatureToken: true
        }
      })
    ]);

    if (!agreement || !addendum) return { skipped: 'no-record' };
    if (!agreement.customerEmail) return { skipped: 'no-customer-email' };

    const fmt = (d) => d ? new Date(d).toLocaleString('en-US') : '-';
    const customerName =
      `${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim() || 'Customer';

    // Customer-portal magic link. Token-based — the URL token is the auth
    // (no JWT). The new /customer/sign-addendum page calls
    // /api/public/addendum-signature/:token to load the addendum and submit
    // the signature. Token is consumed server-side after a successful sign.
    //
    // If the addendum was created without a signature token (legacy data,
    // or token explicitly cleared), skip the email rather than send an
    // unsignable link — the admin still has out-of-band sign-on-behalf.
    if (!addendum.signatureToken) {
      logger?.info?.('addendum-notification skipped — no signature token on addendum', {
        rentalAgreementId,
        addendumId,
        tenantId
      });
      return { skipped: 'no-signature-token' };
    }
    const portalLink = `${baseUrl()}/customer/sign-addendum?token=${encodeURIComponent(addendum.signatureToken)}`;

    const subject = `Action required: please sign addendum to agreement ${agreement.agreementNumber || agreement.id}`;
    const text = [
      `Hi ${customerName},`,
      ``,
      `An addendum has been added to your rental agreement ${agreement.agreementNumber || agreement.id}.`,
      `Reason: ${addendum.reason}`,
      ``,
      `Updated pickup: ${fmt(addendum.pickupAt)}`,
      `Updated return: ${fmt(addendum.returnAt)}`,
      ``,
      `Please review and sign the addendum:`,
      portalLink,
      ``,
      `Thank you.`
    ].join('\n');

    await sendEmail({ to: agreement.customerEmail, subject, text });

    logger?.info?.('addendum-notification sent', {
      rentalAgreementId,
      addendumId,
      tenantId
    });
    return { sent: true };
  } catch (err) {
    logger?.warn?.('addendum-notification send failed', {
      rentalAgreementId,
      addendumId,
      tenantId,
      err: err?.message || String(err)
    });
    return { error: err?.message || String(err) };
  }
}
