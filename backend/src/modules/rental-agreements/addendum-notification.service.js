import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import logger from '../../lib/logger.js';

/**
 * Fire customer- and admin-facing emails on rental agreement addendum
 * creation.
 *
 * NEVER throws. The two notifications are independent — a customer-side
 * failure (missing email, SMTP error) does not block the admin notification
 * and vice versa. All failures are logged and swallowed.
 *
 * Called from the addendum-create route immediately after the row is written.
 *
 * @param {string} rentalAgreementId
 * @param {string} addendumId
 * @param {string|null} tenantId  - tenant scope; when present, lookups are filtered.
 * @returns {Promise<{
 *   customer: { sent?: true, skipped?: string, error?: string },
 *   admin:    { sent?: true, recipientCount?: number, skipped?: string, error?: string }
 * }>}
 */
export async function scheduleAddendumNotification(rentalAgreementId, addendumId, tenantId = null) {
  if (!rentalAgreementId || !addendumId) {
    return {
      customer: { skipped: 'missing-ids' },
      admin: { skipped: 'missing-ids' }
    };
  }

  // One DB round-trip up front; the customer + admin paths share the same data.
  let agreement = null;
  let addendum = null;
  try {
    [agreement, addendum] = await Promise.all([
      prisma.rentalAgreement.findFirst({
        where: { id: rentalAgreementId, ...(tenantId ? { tenantId } : {}) },
        select: {
          id: true,
          agreementNumber: true,
          reservationId: true,
          customerEmail: true,
          customerFirstName: true,
          customerLastName: true,
          tenant: { select: { id: true, name: true } }
        }
      }),
      prisma.rentalAgreementAddendum.findFirst({
        where: { id: addendumId, ...(tenantId ? { tenantId } : {}) },
        select: {
          id: true,
          pickupAt: true,
          returnAt: true,
          reason: true,
          reasonCategory: true,
          status: true,
          initiatedBy: true,
          initiatedByRole: true
        }
      })
    ]);
  } catch (err) {
    logger?.warn?.('addendum-notification lookup failed', {
      rentalAgreementId,
      addendumId,
      tenantId,
      err: err?.message || String(err)
    });
    return {
      customer: { error: err?.message || String(err) },
      admin: { error: err?.message || String(err) }
    };
  }

  if (!agreement || !addendum) {
    return {
      customer: { skipped: 'no-record' },
      admin: { skipped: 'no-record' }
    };
  }

  // Fire both notifications in parallel. Each helper has its own try/catch
  // and never throws — Promise.allSettled is belt-and-suspenders so an
  // unexpected throw in one path doesn't take down the other.
  const [customerResult, adminResult] = await Promise.allSettled([
    _notifyAddendumCustomer({ agreement, addendum }),
    _notifyAddendumAdmins({ agreement, addendum, tenantId })
  ]);

  return {
    customer: customerResult.status === 'fulfilled'
      ? customerResult.value
      : { error: String(customerResult.reason?.message || customerResult.reason) },
    admin: adminResult.status === 'fulfilled'
      ? adminResult.value
      : { error: String(adminResult.reason?.message || adminResult.reason) }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: customer-facing email — link to the (token-based) portal signing
// flow when that ships. For now the link points at the path the frontend
// /customer/sign-agreement?type=addendum will eventually handle; until then
// the customer email serves as a heads-up and the admin signs on their behalf.
// ─────────────────────────────────────────────────────────────────────────────
async function _notifyAddendumCustomer({ agreement, addendum }) {
  try {
    if (!agreement.customerEmail) return { skipped: 'no-customer-email' };

    const fmt = (d) => d ? new Date(d).toLocaleString('en-US') : '-';
    const customerName =
      `${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim() || 'Customer';

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

    logger?.info?.('addendum-notification customer sent', {
      rentalAgreementId: agreement.id,
      addendumId: addendum.id,
      tenantId: agreement.tenant?.id ?? null
    });
    return { sent: true };
  } catch (err) {
    logger?.warn?.('addendum-notification customer send failed', {
      rentalAgreementId: agreement.id,
      addendumId: addendum.id,
      err: err?.message || String(err)
    });
    return { error: err?.message || String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: admin-facing email — tenant-scoped ADMIN/OPS users + platform
// SUPER_ADMIN, deduped by email. Mirrors the recipient-resolution pattern in
// public-booking.service.js → notifyTenantAdminsNewSubmission so the routing
// rules stay consistent across the codebase.
// ─────────────────────────────────────────────────────────────────────────────
async function _notifyAddendumAdmins({ agreement, addendum, tenantId }) {
  try {
    if (!tenantId) return { skipped: 'no-tenant-id' };

    const [tenantAdmins, superAdmins] = await Promise.all([
      prisma.user.findMany({
        where: { tenantId, role: { in: ['ADMIN', 'OPS'] }, isActive: true },
        select: { email: true }
      }),
      prisma.user.findMany({
        where: { role: 'SUPER_ADMIN', isActive: true },
        select: { email: true }
      })
    ]);

    const adminEmails = [
      ...new Set(
        [...tenantAdmins, ...superAdmins]
          .map((a) => a.email)
          .filter(Boolean)
      )
    ];
    if (!adminEmails.length) return { skipped: 'no-admin-recipients' };

    const fmt = (d) => d ? new Date(d).toLocaleString('en-US') : '-';
    const customerName =
      `${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim() || 'Customer';
    const tenantName = agreement.tenant?.name || 'Ride Fleet';

    const subject = `[${tenantName}] New addendum on agreement ${agreement.agreementNumber || agreement.id}`;
    const text = [
      `A new rental agreement addendum has been created and is awaiting customer signature.`,
      ``,
      `Tenant: ${tenantName}`,
      `Agreement: ${agreement.agreementNumber || agreement.id}`,
      `Customer: ${customerName} (${agreement.customerEmail || 'no email on file'})`,
      `Reservation ID: ${agreement.reservationId || '-'}`,
      ``,
      `Reason: ${addendum.reason}`,
      `Category: ${addendum.reasonCategory || '-'}`,
      `Initiated by: ${addendum.initiatedBy || '-'} (${addendum.initiatedByRole || '-'})`,
      ``,
      `New pickup: ${fmt(addendum.pickupAt)}`,
      `New return: ${fmt(addendum.returnAt)}`,
      ``,
      `Status: ${addendum.status}`,
      ``,
      `Open the reservation in the admin dashboard to view, sign on behalf of`,
      `the customer, or void the addendum.`
    ].join('\n');

    await sendEmail({ to: adminEmails.join(','), subject, text });

    logger?.info?.('addendum-notification admins sent', {
      rentalAgreementId: agreement.id,
      addendumId: addendum.id,
      tenantId,
      recipientCount: adminEmails.length
    });
    return { sent: true, recipientCount: adminEmails.length };
  } catch (err) {
    logger?.warn?.('addendum-notification admins send failed', {
      rentalAgreementId: agreement.id,
      addendumId: addendum.id,
      tenantId,
      err: err?.message || String(err)
    });
    return { error: err?.message || String(err) };
  }
}
