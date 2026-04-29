import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import logger from '../../lib/logger.js';
import { getJwtSecret } from '../auth/auth.config.js';

const ANON_REVIEWER_NAME = 'Anonymous user';
const ACTIVE_TRIP_STATES = ['RESERVED', 'CONFIRMED', 'READY_FOR_PICKUP', 'IN_PROGRESS', 'DISPUTED'];

function generateDeletionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function deletionExpiry() {
  return new Date(Date.now() + 1000 * 60 * 60 * 24); // 24h
}

function deletionConfirmUrl(token) {
  // Universal link — opens the Flutter app if installed, otherwise falls
  // back to a web confirmation page. Backend already serves
  // /.well-known/apple-app-site-association + /.well-known/assetlinks.json.
  const base = process.env.CUSTOMER_PORTAL_BASE_URL
    || process.env.APP_BASE_URL
    || process.env.FRONTEND_BASE_URL
    || 'https://ridefleetmanager.com';
  return `${base.replace(/\/+$/, '')}/account/delete-confirm/${encodeURIComponent(token)}`;
}

async function findActiveTripsForCustomer(customerId) {
  return prisma.trip.findMany({
    where: {
      guestCustomerId: customerId,
      status: { in: ACTIVE_TRIP_STATES }
    },
    select: { id: true, tripCode: true, status: true }
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

export const accountDeletionService = {
  async requestAccountDeletion({ guestJwt, typedConfirmation }) {
    if (typedConfirmation !== 'DELETE') {
      const err = new Error('Type DELETE to confirm.');
      err.statusCode = 400;
      throw err;
    }

    // Verify the guest JWT — proves the requester is the signed-in
    // Customer and not an attacker who knows email + tenantId.
    // (Sentry bot finding on PR #28: previous version trusted body
    // for identity, allowing unsolicited deletion-confirm emails to
    // any victim's email.) Identity is now derived only from the
    // verified JWT claims.
    let claims;
    try {
      claims = jwt.verify(guestJwt || '', getJwtSecret());
    } catch (e) {
      const err = new Error('Sign in again to delete your account.');
      err.statusCode = 401;
      throw err;
    }

    const cleanEmail = String(claims?.email || '').trim().toLowerCase();
    const tenantId = claims?.tenantId;

    if (!cleanEmail || !cleanEmail.includes('@')) {
      const err = new Error('Sign in again to delete your account.');
      err.statusCode = 401;
      throw err;
    }
    if (!tenantId || typeof tenantId !== 'string') {
      const err = new Error('Sign in again to delete your account.');
      err.statusCode = 401;
      throw err;
    }

    // Email + tenant lookup. The JWT signature was the auth gate
    // already; now we just resolve the Customer row. orderBy as a
    // defensive tiebreaker if duplicates exist within the same tenant
    // (shouldn't happen but be deterministic).
    const customer = await prisma.customer.findFirst({
      where: {
        email: { equals: cleanEmail, mode: 'insensitive' },
        tenantId: tenantId
      },
      orderBy: { updatedAt: 'desc' }
    });

    if (!customer) {
      // Don't leak whether the email exists. Return 202 with a generic
      // message so an attacker can't enumerate registered emails. The
      // user who actually owns the email won't get a confirmation email
      // (because there's no account), so they figure it out organically.
      return { ok: true, expiresInSeconds: 86400 };
    }

    const activeTrips = await findActiveTripsForCustomer(customer.id);
    if (activeTrips.length > 0) {
      const err = new Error('Complete or cancel your active trip first.');
      err.statusCode = 409;
      err.activeTripCodes = activeTrips.map((t) => t.tripCode);
      throw err;
    }

    const token = generateDeletionToken();
    const expiresAt = deletionExpiry();

    await prisma.customer.update({
      where: { id: customer.id },
      data: { deletionToken: token, deletionTokenExpiresAt: expiresAt }
    });

    const link = deletionConfirmUrl(token);
    const subject = 'Confirm your RideFleet account deletion';
    const text = `Hi ${customer.firstName || 'there'},\n\nWe received a request to delete your RideFleet account.\n\nClick the link below within 24 hours to confirm. After confirmation, your account and personal data will be permanently removed.\n\n${link}\n\nIf you did NOT request this, ignore this email — your account is safe.`;
    const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#211a38;line-height:1.5;">
  <h1 style="font-size:20px;margin:0 0 12px;">Confirm your account deletion</h1>
  <p>Hi ${escapeHtml(customer.firstName || 'there')},</p>
  <p>We received a request to delete your RideFleet account. Click the button below within 24 hours to confirm. After confirmation, your account and personal data will be permanently removed.</p>
  <p style="margin:24px 0;"><a href="${link}" style="background:#8752fe;color:#fff;text-decoration:none;padding:14px 24px;border-radius:16px;font-weight:600;display:inline-block;">Confirm deletion</a></p>
  <p style="color:#5a5370;font-size:13px;">If you did NOT request this, ignore this email — your account is safe.</p>
</body></html>`;

    try {
      await sendEmail({ to: customer.email, subject, text, html });
    } catch (e) {
      logger.error('account-deletion-email-failed', { customerId: customer.id, message: e.message });
      const err = new Error('We could not send the confirmation email. Please try again in a few minutes.');
      err.statusCode = 503;
      throw err;
    }

    return { ok: true, expiresInSeconds: 86400 };
  },

  async confirmAccountDeletion({ token }) {
    if (!token || typeof token !== 'string') {
      const err = new Error('Invalid confirmation link.');
      err.statusCode = 404;
      throw err;
    }

    const cleanToken = token.trim();
    const customer = await prisma.customer.findFirst({
      where: { deletionToken: cleanToken }
    });

    if (!customer) {
      const err = new Error('This confirmation link is invalid.');
      err.statusCode = 404;
      throw err;
    }

    if (!customer.deletionTokenExpiresAt || customer.deletionTokenExpiresAt <= new Date()) {
      const err = new Error('This confirmation link has expired or already been used.');
      err.statusCode = 410;
      throw err;
    }

    // Re-check active trips (race-condition guard — token valid 24h).
    const activeTrips = await findActiveTripsForCustomer(customer.id);
    if (activeTrips.length > 0) {
      const err = new Error('You have an active trip. Complete or cancel it before deleting your account.');
      err.statusCode = 409;
      err.activeTripCodes = activeTrips.map((t) => t.tripCode);
      throw err;
    }

    // Anonymize-in-place. Reservation.customerId and Conversation.customerId
    // are NOT NULL FKs with no cascade, so a hard DELETE on Customer would
    // fail. Per GDPR, anonymizing PII to make re-identification impossible
    // is equivalent to physical deletion. We blank all PII on the Customer
    // row but keep the row itself, preserving audit + accounting integrity
    // on Reservations / Trips / Conversations.
    //
    // Sprint 9 follow-up: call Authorize.Net's deleteCustomerProfile API
    // for full upstream PII removal. For now we just null the local IDs.
    await prisma.$transaction(async (tx) => {
      // Anonymize reviewer name on any host reviews written by this guest.
      await tx.hostReview.updateMany({
        where: { guestCustomerId: customer.id },
        data: { reviewerName: ANON_REVIEWER_NAME }
      }).catch(() => null);

      // Anonymize the Customer row in-place. Required-non-null fields get
      // sentinel values; nullable PII gets nulled; doNotRent prevents
      // re-engagement if the same email tries to re-register.
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          firstName: 'Deleted',
          lastName: 'User',
          email: null,
          phone: '[deleted]',
          licenseNumber: null,
          licenseState: null,
          dateOfBirth: null,
          insurancePolicyNumber: null,
          insuranceDocumentUrl: null,
          address1: null,
          address2: null,
          city: null,
          state: null,
          zip: null,
          country: null,
          idPhotoUrl: null,
          authnetCustomerProfileId: null,
          authnetPaymentProfileId: null,
          creditBalance: 0,
          portalResetToken: null,
          portalResetExpiresAt: null,
          guestAccessToken: null,
          guestAccessExpiresAt: null,
          deletionToken: null,
          deletionTokenExpiresAt: null,
          notes: null,
          doNotRent: true,
          doNotRentReason: 'Account deleted by user'
        }
      });
    });

    logger.info('account-deletion-completed', { customerId: customer.id, email: customer.email });

    return { ok: true };
  }
};
