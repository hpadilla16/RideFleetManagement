import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGuestPaymentSession } from './payment-session.service.js';

/**
 * Website-checkout gateway routing (owner decision 2026-08-29):
 *   • tenant gateway 'ipos'  → the tenant's iPOSpays HPP, whatever the pickup
 *     location — website money settles into THAT tenant's merchant account.
 *   • any other tenant       → byte-for-byte the pre-existing behavior
 *     (location-driven Auth.Net/PayArc; tenant-wide gateway without a
 *     pickupLocation). Pinned here.
 *   • ipos with creds missing → GATEWAY_NOT_CONFIGURED, never a silent
 *     fall-through to the authorizenet block.
 */

function fakePrisma(reservation) {
  return {
    trip: { async findUnique() { return null; } },
    reservation: {
      async findUnique() { return reservation; },
      async findFirst() { return reservation; },
    },
  };
}

function reservationFixture(overrides = {}) {
  return {
    id: 'res-1',
    tenantId: 'tenant-1',
    reservationNumber: 'RF-7251',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    estimatedTotal: 180,
    payments: [],
    currency: 'usd',
    pickupLocation: { country: 'Puerto Rico' },
    ...overrides,
  };
}

function settingsStub(config) {
  return { async getPaymentGatewayConfig() { return config; } };
}

const AUTHNET_CONFIG = {
  gateway: 'authorizenet',
  authorizenet: { enabled: true, environment: 'sandbox', loginId: 'dummy-login', transactionKey: 'dummy-key-not-real' },
};

describe('website checkout: tenant gateway ipos routes to the iPOSpays HPP', () => {
  it('mints an HPP session with the neutral WebView contract and the reference on the successMatchUrl', async () => {
    let mintArgs = null;
    const session = await createGuestPaymentSession({
      tripCode: 'RF-7251',
      deps: {
        prisma: fakePrisma(reservationFixture()),
        settingsService: settingsStub({ ...AUTHNET_CONFIG, gateway: 'ipos' }),
        mintHppSession: async (args) => {
          mintArgs = args;
          return { url: 'https://payment.ipospays.tech/pay?t=x', referenceId: 'PLRF7251XYZ' };
        },
      },
    });

    assert.equal(session.gateway, 'ipos');
    assert.equal(session.checkoutUrl, 'https://payment.ipospays.tech/pay?t=x');
    assert.equal(session.checkoutMethod, 'GET');
    assert.deepEqual(session.checkoutFields, {});
    assert.equal(session.amountDue, 180);
    assert.equal(session.currency, 'USD');
    assert.ok(session.successMatchUrl.includes('/payment-return?r=res-1'));
    assert.ok(session.cancelMatchUrl.includes('/payment-cancel?r=res-1'));
    assert.ok(session.expiresAt);

    // The HPP return URL must land on the successMatchUrl the WebView watches,
    // carrying our reference for server-side verification.
    const returnUrl = mintArgs.buildReturnUrl('PLREF123');
    assert.ok(returnUrl.startsWith(session.successMatchUrl), 'return URL must extend successMatchUrl');
    assert.ok(returnUrl.includes('iposRef=PLREF123'));
    assert.equal(mintArgs.cancelUrl, session.cancelMatchUrl);
    assert.equal(mintArgs.failureUrl, session.cancelMatchUrl, 'a failed payment must not land on the success URL');
    assert.equal(mintArgs.origin, 'PUBLIC');
    assert.equal(mintArgs.amount, 180);
  });

  it('ipos wins over location routing — even a Puerto Rico pickup uses the tenant HPP', async () => {
    // (Pre-change, PR always routed to Auth.Net. The tenant's configured
    // gateway now takes precedence for the website checkout.)
    const session = await createGuestPaymentSession({
      tripCode: 'RF-7251',
      deps: {
        prisma: fakePrisma(reservationFixture({ pickupLocation: { country: 'Puerto Rico' } })),
        settingsService: settingsStub({ ...AUTHNET_CONFIG, gateway: 'ipos' }),
        mintHppSession: async () => ({ url: 'https://payment.ipospays.tech/pay?t=x' }),
      },
    });
    assert.equal(session.gateway, 'ipos');
  });

  it('FAILS CLOSED when ipos creds are missing — GATEWAY_NOT_CONFIGURED, and the authorizenet block is never touched', async () => {
    let authNetCalled = false;
    await assert.rejects(
      () => createGuestPaymentSession({
        tripCode: 'RF-7251',
        deps: {
          prisma: fakePrisma(reservationFixture()),
          settingsService: settingsStub({ ...AUTHNET_CONFIG, gateway: 'ipos' }),
          // fetchImpl is what the Auth.Net mint would use — it must stay cold.
          fetchImpl: async () => { authNetCalled = true; throw new Error('must not be called'); },
          mintHppSession: async () => {
            const err = new Error('Customer payment links are set to iPOS, but iPOS payment links are not configured for this tenant.');
            err.code = 'GATEWAY_NOT_CONFIGURED';
            throw err;
          },
        },
      }),
      (err) => err.code === 'GATEWAY_NOT_CONFIGURED',
    );
    assert.equal(authNetCalled, false, 'no silent Auth.Net fallback — that settles into the wrong merchant');
  });
});

describe('website checkout: tenants NOT set to ipos keep the pre-existing routing byte-for-byte', () => {
  it('Puerto Rico pickup + gateway authorizenet → Accept Hosted (POST + token field)', async () => {
    const session = await createGuestPaymentSession({
      tripCode: 'RF-7251',
      deps: {
        prisma: fakePrisma(reservationFixture({ pickupLocation: { country: 'Puerto Rico' } })),
        settingsService: settingsStub(AUTHNET_CONFIG),
        fetchImpl: async () => ({
          ok: true, status: 200,
          text: async () => JSON.stringify({
            getHostedPaymentPageResponse: { token: 'hosted-token-1', messages: { resultCode: 'Ok' } },
          }),
        }),
        mintHppSession: async () => { throw new Error('HPP must NOT be reached for a non-ipos tenant'); },
      },
    });
    assert.equal(session.gateway, 'authorizenet');
    assert.equal(session.checkoutMethod, 'POST');
    assert.deepEqual(session.checkoutFields, { token: 'hosted-token-1' });
    assert.equal(session.checkoutUrl, 'https://test.authorize.net/payment/payment');
  });

  it('US pickup + PayArc configured + gateway authorizenet → PayArc bridge (unchanged)', async () => {
    const session = await createGuestPaymentSession({
      tripCode: 'RF-7251',
      deps: {
        prisma: fakePrisma(reservationFixture({ pickupLocation: { country: 'USA' } })),
        settingsService: settingsStub({
          ...AUTHNET_CONFIG,
          payarc: { enabled: true, environment: 'sandbox', bearerToken: 'dummy-bearer-not-real', publicKey: 'dummy-public-not-real', webhookSecret: 'dummy-secret-not-real' },
        }),
        fetchImpl: async () => { throw new Error('no gateway call expected for the PayArc bridge mint'); },
        mintHppSession: async () => { throw new Error('HPP must NOT be reached for a non-ipos tenant'); },
      },
    });
    assert.equal(session.gateway, 'payarc');
    assert.equal(session.checkoutMethod, 'GET');
    assert.ok(session.checkoutUrl.includes('/payarc-bridge?s='));
  });

  it("gateway 'spin' still refuses (unchanged terminal-only posture)", async () => {
    await assert.rejects(
      () => createGuestPaymentSession({
        tripCode: 'RF-7251',
        deps: {
          prisma: fakePrisma(reservationFixture({ pickupLocation: null })),
          settingsService: settingsStub({ ...AUTHNET_CONFIG, gateway: 'spin' }),
          mintHppSession: async () => { throw new Error('HPP must NOT be reached'); },
        },
      }),
      (err) => err.code === 'GATEWAY_NOT_CONFIGURED' && /SPIn online/.test(err.message),
    );
  });
});
