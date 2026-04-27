import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import logger from '../../lib/logger.js';

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
          status: true
        }
      })
    ]);

    if (!agreement || !addendum) return { skipped: 'no-record' };
    if (!agreement.customerEmail) return { skipped: 'no-customer-email' };

    const fmt = (d) => d ? new Date(d).toLocaleString('en-US') : '-';
    const customerName =
      `${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim() || 'Customer';

    // Customer-portal link for the signature flow. The frontend route
    // /customer/sign-agreement is parameterized by `type=addendum` (Commit 5)
    // and reads agreement + addendum IDs from the query string.
    const portalLink = `/customer/sign-agreement?type=addendum` +
      `&agreement=${encodeURIComponent(agreement.id)}` +
      `&addendum=${encodeURIComponent(addendum.id)}`;

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
