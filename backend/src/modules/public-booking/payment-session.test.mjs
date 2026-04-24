import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authNetEnabled,
  authNetHostedBase,
  computeAmountDue,
  assertPayable,
  currentGateway,
  mintAcceptHostedToken,
  renderReturnPage,
} from './authnet-accept-hosted.js';

// ─── computeAmountDue ────────────────────────────────────────────────────────

describe('payment-session: amount-due calculation', () => {
  it('returns full estimatedTotal when no payments have been made', () => {
    const due = computeAmountDue({
      estimatedTotal: 234,
      payments: [],
    });
    assert.equal(due, 234);
  });

  it('subtracts completed payments from estimatedTotal', () => {
    const due = computeAmountDue({
      estimatedTotal: 234,
      payments: [
        { amount: 50 },
        { amount: 100 },
      ],
    });
    assert.equal(due, 84);
  });

  it('ignores voided and refunded payments', () => {
    const due = computeAmountDue({
      estimatedTotal: 234,
      payments: [
        { amount: 50 },
        { amount: 100, voided: true },
        { amount: 80, refunded: true },
      ],
    });
    assert.equal(due, 184);
  });

  it('never returns a negative amount (e.g. overpaid legacy trips)', () => {
    const due = computeAmountDue({
      estimatedTotal: 100,
      payments: [{ amount: 150 }],
    });
    assert.equal(due, 0);
  });

  it('handles missing fields gracefully', () => {
    assert.equal(computeAmountDue({}), 0);
    assert.equal(computeAmountDue({ estimatedTotal: 50 }), 50);
    assert.equal(computeAmountDue({ payments: null }), 0);
  });
});

// ─── assertPayable ───────────────────────────────────────────────────────────

describe('payment-session: payability guard', () => {
  function reservation(overrides = {}) {
    return {
      id: 'res-1',
      paymentStatus: 'PENDING',
      status: 'CONFIRMED',
      estimatedTotal: 200,
      payments: [],
      ...overrides,
    };
  }

  it('accepts PENDING with outstanding balance', () => {
    const due = assertPayable(reservation());
    assert.equal(due, 200);
  });

  it('accepts PARTIAL with outstanding balance', () => {
    const due = assertPayable(
      reservation({ paymentStatus: 'PARTIAL', payments: [{ amount: 50 }] }),
    );
    assert.equal(due, 150);
  });

  it('rejects already-paid trips with ALREADY_PAID code', () => {
    assert.throws(
      () => assertPayable(reservation({ paymentStatus: 'PAID' })),
      (err) => err.code === 'ALREADY_PAID',
    );
  });

  it('rejects refunded and voided trips with NOT_PAYABLE', () => {
    for (const ps of ['REFUNDED', 'VOID']) {
      assert.throws(
        () => assertPayable(reservation({ paymentStatus: ps })),
        (err) => err.code === 'NOT_PAYABLE',
        `should reject paymentStatus=${ps}`,
      );
    }
  });

  it('rejects cancelled reservations even if paymentStatus is payable', () => {
    assert.throws(
      () =>
        assertPayable(
          reservation({ paymentStatus: 'PENDING', status: 'CANCELLED' }),
        ),
      (err) => err.code === 'NOT_PAYABLE',
    );
  });

  it('rejects zero-balance trips as ALREADY_PAID', () => {
    assert.throws(
      () =>
        assertPayable(
          reservation({ paymentStatus: 'PARTIAL', payments: [{ amount: 200 }] }),
        ),
      (err) => err.code === 'ALREADY_PAID',
    );
  });
});

// ─── gateway helpers ─────────────────────────────────────────────────────────

describe('payment-session: gateway helpers', () => {
  it('currentGateway falls back to authorizenet when unset or unknown', () => {
    assert.equal(currentGateway({}), 'authorizenet');
    assert.equal(currentGateway({ gateway: 'AUTHORIZENET' }), 'authorizenet');
    assert.equal(currentGateway({ gateway: 'bogus' }), 'authorizenet');
    assert.equal(currentGateway({ gateway: 'stripe' }), 'stripe');
    assert.equal(currentGateway({ gateway: 'spin' }), 'spin');
  });

  it('authNetEnabled requires loginId + transactionKey and non-explicit-disable', () => {
    assert.equal(authNetEnabled({}), false);
    assert.equal(
      authNetEnabled({ authorizenet: { loginId: 'x', transactionKey: 'y' } }),
      true,
    );
    assert.equal(
      authNetEnabled({
        authorizenet: { enabled: false, loginId: 'x', transactionKey: 'y' },
      }),
      false,
    );
    assert.equal(
      authNetEnabled({ authorizenet: { loginId: 'x' } }),
      false,
      'missing transactionKey',
    );
  });

  it('authNetHostedBase switches URL on environment', () => {
    assert.match(
      authNetHostedBase({ authorizenet: { environment: 'sandbox' } }),
      /test\.authorize\.net/,
    );
    assert.match(
      authNetHostedBase({ authorizenet: { environment: 'production' } }),
      /^https:\/\/accept\.authorize\.net/,
    );
    assert.match(authNetHostedBase({}), /test\.authorize\.net/);
  });
});

// ─── mintAcceptHostedToken ───────────────────────────────────────────────────

describe('payment-session: Accept Hosted token minting', () => {
  function fakeConfig() {
    return {
      gateway: 'authorizenet',
      authorizenet: {
        enabled: true,
        loginId: 'LOGIN123',
        transactionKey: 'TXNKEY456',
        environment: 'sandbox',
      },
    };
  }

  function fakeReservation() {
    return {
      id: 'res-abcd1234',
      reservationNumber: 'RF-7251',
      estimatedTotal: 234,
      payments: [],
    };
  }

  it('sends expected payload shape to Authorize.Net', async () => {
    let capturedUrl = '';
    let capturedBody = null;
    const fakeFetch = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            getHostedPaymentPageResponse: {
              token: 'HOSTED-TOKEN-OK',
              messages: { resultCode: 'Ok', message: [{ text: 'I_OK' }] },
            },
          }),
      };
    };

    const token = await mintAcceptHostedToken({
      reservation: fakeReservation(),
      amount: 234,
      config: fakeConfig(),
      successMatchUrl: 'https://api.example/payment-return',
      cancelMatchUrl: 'https://api.example/payment-cancel',
      deps: { fetchImpl: fakeFetch },
    });
    assert.equal(token, 'HOSTED-TOKEN-OK');
    assert.match(capturedUrl, /apitest\.authorize\.net/);
    assert.equal(
      capturedBody.getHostedPaymentPageRequest.merchantAuthentication.name,
      'LOGIN123',
    );
    assert.equal(
      capturedBody.getHostedPaymentPageRequest.transactionRequest.amount,
      '234.00',
    );
    const returnSetting = capturedBody.getHostedPaymentPageRequest.hostedPaymentSettings.setting.find(
      (s) => s.settingName === 'hostedPaymentReturnOptions',
    );
    assert.ok(returnSetting, 'hostedPaymentReturnOptions must be set');
    const returnJson = JSON.parse(returnSetting.settingValue);
    assert.equal(returnJson.showReceipt, false);
    assert.equal(returnJson.url, 'https://api.example/payment-return');
    assert.equal(returnJson.cancelUrl, 'https://api.example/payment-cancel');
  });

  it('throws GATEWAY_ERROR when Authorize.Net returns resultCode=Error', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          getHostedPaymentPageResponse: {
            messages: {
              resultCode: 'Error',
              message: [{ code: 'E00003', text: 'Invalid merchant login' }],
            },
          },
        }),
    });
    await assert.rejects(
      mintAcceptHostedToken({
        reservation: fakeReservation(),
        amount: 234,
        config: fakeConfig(),
        successMatchUrl: 's',
        cancelMatchUrl: 'c',
        deps: { fetchImpl: fakeFetch },
      }),
      (err) => err.code === 'GATEWAY_ERROR' && /Invalid merchant login/.test(err.message),
    );
  });

  it('enforces a minimum amount of $0.50 (Authorize.Net floor)', async () => {
    let capturedBody = null;
    const fakeFetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            getHostedPaymentPageResponse: {
              token: 't',
              messages: { resultCode: 'Ok' },
            },
          }),
      };
    };
    await mintAcceptHostedToken({
      reservation: fakeReservation(),
      amount: 0.1,
      config: fakeConfig(),
      successMatchUrl: 's',
      cancelMatchUrl: 'c',
      deps: { fetchImpl: fakeFetch },
    });
    assert.equal(
      capturedBody.getHostedPaymentPageRequest.transactionRequest.amount,
      '0.50',
    );
  });
});

// ─── renderReturnPage ────────────────────────────────────────────────────────

describe('payment-session: renderReturnPage', () => {
  it('renders a success-flavored HTML by default', () => {
    const html = renderReturnPage();
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /Payment received/);
    assert.match(html, /close this page/i);
  });

  it('renders a cancel-flavored HTML when status=cancel', () => {
    const html = renderReturnPage({ status: 'cancel' });
    assert.match(html, /Payment cancelled/);
    assert.match(html, /No charge was made/i);
  });
});
