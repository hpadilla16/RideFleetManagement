import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { settingsService } from '../settings/settings.service.js';
import logger from '../../lib/logger.js';
import { renderTemplate } from './review-email-template.js';

/**
 * Fire a "review us" email to the reservation customer IF:
 *   - Tenant has enabled review-email sending (reviewEmail.enabled = true)
 *   - The tenant-configured trigger matches the just-completed transition
 *     (CHECKED_OUT | CHECKED_IN)
 *   - The status actually changed (previousStatus != currentStatus)
 *   - The customer has an email on file
 *
 * The function NEVER throws: a missing template, misconfigured SMTP, or a
 * missing customer should not roll back or error out the reservation update
 * that fired it. Failures are logged and swallowed.
 *
 * @param {object} reservation - post-update reservation row (must include id,
 *                               tenantId, status, customerId, reservationNumber).
 * @param {string} previousStatus - reservation.status BEFORE the update.
 */
export async function maybeSendReviewRequestEmail({ reservation, previousStatus } = {}) {
  try {
    if (!reservation?.id || !reservation?.tenantId) return { skipped: 'no-reservation' };
    const currentStatus = String(reservation.status || '').toUpperCase();
    const prior = String(previousStatus || '').toUpperCase();
    if (currentStatus === prior) return { skipped: 'no-transition' };
    if (currentStatus !== 'CHECKED_OUT' && currentStatus !== 'CHECKED_IN') {
      return { skipped: 'wrong-status' };
    }

    const tenantScope = { tenantId: reservation.tenantId };
    const config = await settingsService.getReviewEmailConfig(tenantScope);
    if (!config.enabled) return { skipped: 'not-enabled' };
    if (String(config.trigger || '').toUpperCase() !== currentStatus) {
      return { skipped: 'trigger-mismatch' };
    }

    const [customerRow, templates, agreementCfg] = await Promise.all([
      reservation.customerId
        ? prisma.customer.findFirst({
            where: { id: reservation.customerId },
            select: { email: true, firstName: true, lastName: true }
          })
        : null,
      settingsService.getEmailTemplates(tenantScope),
      settingsService.getRentalAgreementConfig(tenantScope).catch(() => ({}))
    ]);
    if (!customerRow?.email) return { skipped: 'no-customer-email' };

    const companyName = agreementCfg?.companyName || 'Our Team';
    const customerName = `${customerRow.firstName || ''} ${customerRow.lastName || ''}`.trim() || 'Customer';
    const vars = {
      customerName,
      reservationNumber: reservation.reservationNumber || '',
      companyName,
      reviewLink: config.reviewLinkUrl || ''
    };

    const subject = renderTemplate(templates.rentalReviewRequestSubject, vars);
    const text = renderTemplate(templates.rentalReviewRequestBody, vars);
    const html = renderTemplate(templates.rentalReviewRequestHtml, vars);

    await sendEmail({ to: customerRow.email, subject, text, html });
    logger?.info?.('review-email sent', {
      reservationId: reservation.id,
      tenantId: reservation.tenantId,
      trigger: currentStatus
    });
    return { sent: true, trigger: currentStatus };
  } catch (err) {
    logger?.warn?.('review-email send failed', { err: err?.message || String(err) });
    return { error: err?.message || String(err) };
  }
}

// Re-export for call sites that still reach for the pure helper here.
export { renderTemplate };
