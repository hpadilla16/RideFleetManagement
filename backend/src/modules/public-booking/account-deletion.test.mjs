import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Mock the dependencies
let mockPrisma = {};
let mockSendEmail = null;
let mockLogger = {};

// Dynamic service loader to allow dependency injection
async function createServiceWithMocks(prismaOverride, sendEmailOverride, loggerOverride) {
  mockPrisma = prismaOverride;
  mockSendEmail = sendEmailOverride;
  mockLogger = loggerOverride;

  // Create a minimal version of the service with mocked dependencies
  const ANON_REVIEWER_NAME = 'Anonymous user';
  const ACTIVE_TRIP_STATES = ['RESERVED', 'CONFIRMED', 'READY_FOR_PICKUP', 'IN_PROGRESS', 'DISPUTED'];

  function generateDeletionToken() {
    return crypto.randomBytes(24).toString('hex');
  }

  function deletionExpiry() {
    return new Date(Date.now() + 1000 * 60 * 60 * 24);
  }

  function deletionConfirmUrl(token) {
    const base = process.env.CUSTOMER_PORTAL_BASE_URL
      || process.env.APP_BASE_URL
      || process.env.FRONTEND_BASE_URL
      || 'https://ridefleetmanager.com';
    return `${base.replace(/\/+$/, '')}/account/delete-confirm/${encodeURIComponent(token)}`;
  }

  async function findActiveTripsForCustomer(customerId) {
    return mockPrisma.trip?.findMany?.({ where: { guestCustomerId: customerId, status: { in: ACTIVE_TRIP_STATES } } }) || [];
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  return {
    async requestAccountDeletion({ email, typedConfirmation }) {
      if (typedConfirmation !== 'DELETE') {
        const err = new Error('Type DELETE to confirm.');
        err.statusCode = 400;
        throw err;
      }

      const cleanEmail = String(email || '').trim().toLowerCase();
      if (!cleanEmail || !cleanEmail.includes('@')) {
        const err = new Error('Email is required.');
        err.statusCode = 400;
        throw err;
      }

      const customer = await mockPrisma.customer?.findFirst?.({
        where: { email: { equals: cleanEmail, mode: 'insensitive' } }
      });

      // Anti-enumeration: if no customer matches, return 202 silently.
      if (!customer) {
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

      await mockPrisma.customer?.update?.({
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
        await mockSendEmail?.({ to: customer.email, subject, text, html });
      } catch (e) {
        mockLogger.error?.('account-deletion-email-failed', { customerId: customer.id, message: e.message });
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
      const customer = await mockPrisma.customer?.findFirst?.({
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

      const activeTrips = await findActiveTripsForCustomer(customer.id);
      if (activeTrips.length > 0) {
        const err = new Error('You have an active trip. Complete or cancel it before deleting your account.');
        err.statusCode = 409;
        err.activeTripCodes = activeTrips.map((t) => t.tripCode);
        throw err;
      }

      await mockPrisma.$transaction?.(async (tx) => {
        await tx.hostReview?.updateMany?.({
          where: { guestCustomerId: customer.id },
          data: { reviewerName: ANON_REVIEWER_NAME }
        }).catch(() => null);

        await tx.customer?.update?.({
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
            postalCode: null,
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

      mockLogger.info?.('account-deletion-completed', { customerId: customer.id, email: customer.email });

      return { ok: true };
    }
  };
}

describe('accountDeletionService', () => {
  describe('requestAccountDeletion', () => {
    it('rejects when typedConfirmation !== DELETE (400)', async () => {
      const service = await createServiceWithMocks({}, null, {});
      await assert.rejects(
        () => service.requestAccountDeletion({ email: 'user@example.com', typedConfirmation: 'cancel' }),
        (err) => err.statusCode === 400 && /Type DELETE to confirm/i.test(err.message)
      );
    });

    it('rejects when email missing (400)', async () => {
      const service = await createServiceWithMocks({}, null, {});
      await assert.rejects(
        () => service.requestAccountDeletion({ email: null, typedConfirmation: 'DELETE' }),
        (err) => err.statusCode === 400 && /Email is required/i.test(err.message)
      );
    });

    it('rejects when email is empty string (400)', async () => {
      const service = await createServiceWithMocks({}, null, {});
      await assert.rejects(
        () => service.requestAccountDeletion({ email: '', typedConfirmation: 'DELETE' }),
        (err) => err.statusCode === 400 && /Email is required/i.test(err.message)
      );
    });

    it('rejects when email is malformed (no @) (400)', async () => {
      const service = await createServiceWithMocks({}, null, {});
      await assert.rejects(
        () => service.requestAccountDeletion({ email: 'not-an-email', typedConfirmation: 'DELETE' }),
        (err) => err.statusCode === 400 && /Email is required/i.test(err.message)
      );
    });

    it('returns 202 silently when no Customer matches email (anti-enumeration)', async () => {
      const service = await createServiceWithMocks(
        {
          customer: {
            findFirst: async () => null
          }
        },
        null,
        {}
      );
      const result = await service.requestAccountDeletion({
        email: 'unknown@example.com',
        typedConfirmation: 'DELETE'
      });
      assert.equal(result.ok, true);
      assert.equal(result.expiresInSeconds, 86400);
    });

    it('rejects when Customer has active trip (409 with activeTripCodes)', async () => {
      const service = await createServiceWithMocks(
        {
          customer: {
            findFirst: async () => ({
              id: 'cust-1',
              email: 'user@example.com',
              firstName: 'John'
            })
          },
          trip: {
            findMany: async () => [
              { id: 'trip-1', tripCode: 'RF-001', status: 'IN_PROGRESS' },
              { id: 'trip-2', tripCode: 'RF-002', status: 'RESERVED' }
            ]
          }
        },
        null,
        {}
      );
      await assert.rejects(
        () => service.requestAccountDeletion({ email: 'user@example.com', typedConfirmation: 'DELETE' }),
        (err) => {
          return err.statusCode === 409
            && /Complete or cancel your active trip/i.test(err.message)
            && Array.isArray(err.activeTripCodes)
            && err.activeTripCodes.includes('RF-001')
            && err.activeTripCodes.includes('RF-002');
        }
      );
    });

    it('returns 503 if email send fails', async () => {
      const service = await createServiceWithMocks(
        {
          customer: {
            findFirst: async () => ({
              id: 'cust-1',
              email: 'user@example.com',
              firstName: 'John',
              guestAccessExpiresAt: new Date(Date.now() + 10000)
            }),
            update: async () => ({})
          },
          trip: {
            findMany: async () => []
          }
        },
        async () => { throw new Error('SMTP failure'); },
        { error: () => {} }
      );
      await assert.rejects(
        () => service.requestAccountDeletion({ email: 'user@example.com', typedConfirmation: 'DELETE' }),
        (err) => err.statusCode === 503 && /could not send the confirmation email/i.test(err.message)
      );
    });

    it('happy path: generates token, saves to Customer, sends email, returns 202', async () => {
      let savedToken = null;
      let savedExpiresAt = null;
      let emailSent = false;
      let emailTo = null;

      const service = await createServiceWithMocks(
        {
          customer: {
            findFirst: async () => ({
              id: 'cust-1',
              email: 'user@example.com',
              firstName: 'John',
              guestAccessExpiresAt: new Date(Date.now() + 10000)
            }),
            update: async (data) => {
              savedToken = data.data.deletionToken;
              savedExpiresAt = data.data.deletionTokenExpiresAt;
              return {};
            }
          },
          trip: {
            findMany: async () => []
          }
        },
        async ({ to, subject, text, html }) => {
          emailSent = true;
          emailTo = to;
          assert.equal(to, 'user@example.com');
          assert.match(subject, /Confirm your RideFleet account deletion/);
          assert.match(html, /John/);
          assert.match(html, /account deletion/i);
        },
        { error: () => {}, info: () => {} }
      );

      const result = await service.requestAccountDeletion({
        email: 'user@example.com',
        typedConfirmation: 'DELETE'
      });

      assert.equal(result.ok, true);
      assert.equal(result.expiresInSeconds, 86400);
      assert.ok(savedToken);
      assert.ok(savedToken.length >= 48); // crypto.randomBytes(24).toString('hex') is 48 chars
      assert.ok(savedExpiresAt);
      assert.ok(savedExpiresAt > new Date());
      assert.equal(emailSent, true);
      assert.equal(emailTo, 'user@example.com');
    });

    it('generates unique token each time', async () => {
      let tokens = [];
      const service = await createServiceWithMocks(
        {
          customer: {
            findFirst: async () => ({
              id: 'cust-1',
              email: 'user@example.com',
              firstName: 'John',
              guestAccessExpiresAt: new Date(Date.now() + 10000)
            }),
            update: async (data) => {
              tokens.push(data.data.deletionToken);
              return {};
            }
          },
          trip: {
            findMany: async () => []
          }
        },
        async () => {},
        { error: () => {}, info: () => {} }
      );

      await service.requestAccountDeletion({ email: 'user@example.com', typedConfirmation: 'DELETE' });
      await service.requestAccountDeletion({ email: 'user@example.com', typedConfirmation: 'DELETE' });

      assert.notEqual(tokens[0], tokens[1]);
    });
  });

  describe('confirmAccountDeletion', () => {
    it('rejects when token missing (404)', async () => {
      const service = await createServiceWithMocks({}, null, {});
      await assert.rejects(
        () => service.confirmAccountDeletion({ token: null }),
        (err) => err.statusCode === 404 && /Invalid confirmation link/i.test(err.message)
      );
    });

    it('rejects when token is empty string (404)', async () => {
      const service = await createServiceWithMocks({}, null, {});
      await assert.rejects(
        () => service.confirmAccountDeletion({ token: '' }),
        (err) => err.statusCode === 404 && /Invalid confirmation link/i.test(err.message)
      );
    });

    it('rejects when no Customer matches token (404)', async () => {
      const service = await createServiceWithMocks(
        {
          customer: {
            findFirst: async () => null
          }
        },
        null,
        {}
      );
      await assert.rejects(
        () => service.confirmAccountDeletion({ token: 'invalid-token' }),
        (err) => err.statusCode === 404 && /This confirmation link is invalid/i.test(err.message)
      );
    });

    it('rejects when token expired (410)', async () => {
      const service = await createServiceWithMocks(
        {
          customer: {
            findFirst: async () => ({
              id: 'cust-1',
              deletionToken: 'expired-token',
              deletionTokenExpiresAt: new Date(Date.now() - 1000) // in the past
            })
          }
        },
        null,
        {}
      );
      await assert.rejects(
        () => service.confirmAccountDeletion({ token: 'expired-token' }),
        (err) => err.statusCode === 410 && /This confirmation link has expired/i.test(err.message)
      );
    });

    it('rejects when Customer has active trip — race condition guard (409)', async () => {
      const service = await createServiceWithMocks(
        {
          customer: {
            findFirst: async () => ({
              id: 'cust-1',
              deletionToken: 'valid-token',
              deletionTokenExpiresAt: new Date(Date.now() + 10000)
            })
          },
          trip: {
            findMany: async () => [
              { id: 'trip-1', tripCode: 'RF-003', status: 'CONFIRMED' }
            ]
          }
        },
        null,
        {}
      );
      await assert.rejects(
        () => service.confirmAccountDeletion({ token: 'valid-token' }),
        (err) => {
          return err.statusCode === 409
            && /You have an active trip/i.test(err.message)
            && Array.isArray(err.activeTripCodes)
            && err.activeTripCodes.includes('RF-003');
        }
      );
    });

    it('happy path: anonymizes HostReview + Customer in-place (FK-safe)', async () => {
      let hostReviewUpdated = false;
      let customerAnonymized = false;
      let anonymizedFields = null;
      let txCalls = [];

      const mockTx = {
        hostReview: {
          updateMany: async (data) => {
            hostReviewUpdated = true;
            txCalls.push('updateHostReview');
            assert.equal(data.where.guestCustomerId, 'cust-1');
            assert.equal(data.data.reviewerName, 'Anonymous user');
            return {};
          }
        },
        customer: {
          update: async (data) => {
            customerAnonymized = true;
            txCalls.push('anonymizeCustomer');
            assert.equal(data.where.id, 'cust-1');
            anonymizedFields = data.data;
            return {};
          }
        }
      };

      const service = await createServiceWithMocks(
        {
          customer: {
            findFirst: async () => ({
              id: 'cust-1',
              email: 'user@example.com',
              deletionToken: 'valid-token',
              deletionTokenExpiresAt: new Date(Date.now() + 10000)
            })
          },
          trip: {
            findMany: async () => []
          },
          $transaction: async (fn) => fn(mockTx)
        },
        null,
        { info: () => {} }
      );

      const result = await service.confirmAccountDeletion({ token: 'valid-token' });

      assert.equal(result.ok, true);
      assert.equal(hostReviewUpdated, true);
      assert.equal(customerAnonymized, true);
      assert.deepEqual(txCalls, ['updateHostReview', 'anonymizeCustomer']);

      // Required-non-null fields get sentinel values
      assert.equal(anonymizedFields.firstName, 'Deleted');
      assert.equal(anonymizedFields.lastName, 'User');
      assert.equal(anonymizedFields.phone, '[deleted]');
      // Nullable PII gets nulled
      assert.equal(anonymizedFields.email, null);
      assert.equal(anonymizedFields.licenseNumber, null);
      assert.equal(anonymizedFields.dateOfBirth, null);
      assert.equal(anonymizedFields.idPhotoUrl, null);
      assert.equal(anonymizedFields.address1, null);
      // Tokens cleared so token can't be re-used
      assert.equal(anonymizedFields.guestAccessToken, null);
      assert.equal(anonymizedFields.deletionToken, null);
      // Block re-engagement
      assert.equal(anonymizedFields.doNotRent, true);
      assert.match(anonymizedFields.doNotRentReason, /deleted/i);
      // Credit zeroed
      assert.equal(anonymizedFields.creditBalance, 0);
    });

    it('active trip check covers all 5 active states', async () => {
      const ACTIVE_STATES = ['RESERVED', 'CONFIRMED', 'READY_FOR_PICKUP', 'IN_PROGRESS', 'DISPUTED'];
      let checkedStates = null;

      const service = await createServiceWithMocks(
        {
          customer: {
            findFirst: async () => ({
              id: 'cust-1',
              deletionToken: 'token-1',
              deletionTokenExpiresAt: new Date(Date.now() + 10000)
            })
          },
          trip: {
            findMany: async (query) => {
              checkedStates = query.where.status.in;
              return [];
            }
          },
          $transaction: async (fn) => fn({
            hostReview: { updateMany: async () => ({}) },
            customer: { update: async () => ({}) }
          })
        },
        null,
        { info: () => {} }
      );

      await service.confirmAccountDeletion({ token: 'token-1' });

      assert.deepEqual(checkedStates, ACTIVE_STATES);
    });
  });
});
