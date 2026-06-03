/**
 * Tests for the iPOSpays Transact API client.
 * Run: node --test backend/src/modules/payment-gateway/ipos-transact-client.test.mjs
 *
 * These tests pin the request shape against the documented sample
 * payloads in https://docs.ipospays.com/ipos-transact/apidocs so a
 * future refactor can't accidentally break the wire format.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { iposTransactClient } from './ipos-transact-client.js';

// Capture the underlying fetch call so we can inspect what we'd send
// over the wire without actually hitting the iPOSpays API.
let originalFetch;
let lastRequest;

function installFetchSpy(response = {
  iposTransactResponse: {
    responseCode: 200,
    responseMessage: 'Successful',
    errResponseCode: '00',
    errResponseMessage: 'Approval',
    transactionReferenceId: 'TEST-REF',
    transactionType: 5,
    transactionId: 'tx-test',
    RRN: '123456789012',
    responseApprovalCode: 'TAS001',
    amount: 500,
  },
}) {
  originalFetch = global.fetch;
  lastRequest = null;
  global.fetch = async (url, init) => {
    lastRequest = {
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : null,
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(response),
    };
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

describe('iPOSpays Transact client — request shape', () => {
  beforeEach(() => {
    process.env.IPOS_TRANSACT_AUTH_TOKEN = 'fake-jwt';
    process.env.IPOS_TRANSACT_MERCHANT_ID = '816026739983';
    process.env.IPOS_TRANSACT_VERSION = 'v2';
    process.env.SPIN_DRY_RUN = '';
    process.env.IPOS_TRANSACT_DRY_RUN = '';
    installFetchSpy();
  });
  afterEach(() => {
    restoreFetch();
  });

  it('preAuthDeposit hits the V2 endpoint by default', async () => {
    await iposTransactClient.preAuthDeposit({
      amount: 500,
      agreementNumber: 'RA-2026-0001',
      cardToken: 'ipos-token-abc',
    });
    assert.equal(lastRequest.url, 'https://payment.ipospays.com/api/v2/iposTransact');
  });

  it('switches endpoint when IPOS_TRANSACT_VERSION=v3', async () => {
    process.env.IPOS_TRANSACT_VERSION = 'v3';
    await iposTransactClient.preAuthDeposit({
      amount: 500,
      agreementNumber: 'RA-2026-0001',
      cardToken: 'ipos-token-abc',
    });
    assert.equal(lastRequest.url, 'https://payment.ipospays.com/api/v3/iposTransact');
  });

  it('sends auth token in the "token" header per docs', async () => {
    await iposTransactClient.preAuthDeposit({
      amount: 500,
      agreementNumber: 'RA-2026-0001',
      cardToken: 'ipos-token-abc',
    });
    assert.equal(lastRequest.headers.token, 'fake-jwt');
    assert.equal(lastRequest.headers['Content-Type'], 'application/json');
  });

  it('preAuth payload uses transactionType 5 + cardToken + amount in cents', async () => {
    await iposTransactClient.preAuthDeposit({
      amount: 500.00,
      agreementNumber: 'RA-2026-0001',
      cardToken: 'ipos-token-abc',
    });
    const body = lastRequest.body;
    assert.equal(body.transactionRequest.transactionType, 5);
    assert.equal(body.transactionRequest.cardToken, 'ipos-token-abc');
    // $500.00 → "50000" cents per docs (amount × 100)
    assert.equal(body.transactionRequest.amount, '50000');
    assert.equal(body.transactionRequest.applySteamSettingTipFeeTax, false);
    assert.equal(body.merchantAuthentication.merchantId, '816026739983');
    assert.ok(body.merchantAuthentication.transactionReferenceId);
    assert.ok(body.merchantAuthentication.transactionReferenceId.length <= 20);
  });

  it('chargeWithToken uses transactionType 1 (Sale via token)', async () => {
    await iposTransactClient.chargeWithToken({
      amount: 49.99,
      agreementNumber: 'RA-2026-0001',
      cardToken: 'ipos-token-abc',
      description: 'Late return fee',
    });
    assert.equal(lastRequest.body.transactionRequest.transactionType, 1);
    assert.equal(lastRequest.body.transactionRequest.cardToken, 'ipos-token-abc');
    assert.equal(lastRequest.body.transactionRequest.amount, '4999');
    assert.equal(lastRequest.body.preferences.requestCardToken, false);
  });

  it('voidByRrn uses transactionType 2 and the RRN field', async () => {
    await iposTransactClient.voidByRrn({
      rrn: '123456789012',
      agreementNumber: 'RA-2026-0001',
    });
    assert.equal(lastRequest.body.transactionRequest.transactionType, 2);
    assert.equal(lastRequest.body.transactionRequest.RRN, '123456789012');
    assert.equal(lastRequest.body.transactionRequest.amount, '0');
    assert.equal(lastRequest.body.preferences.eReceipt, false);
  });

  it('preAuth includes Auto Rental L3Data with PurchaseIdFormatCode "3"', async () => {
    await iposTransactClient.preAuthDeposit({
      amount: 500,
      agreementNumber: 'RA-2026-0001',
      cardToken: 'ipos-token-abc',
    });
    const l3 = lastRequest.body.L3Data;
    assert.ok(l3, 'L3Data block should be present by default');
    assert.equal(l3.Header.PurchaseIdFormatCode, '3', 'PurchaseIdFormatCode "3" = Auto Rental Agreement Number');
    assert.equal(l3.Header.PurchaseIdentifier, 'RA-2026-0001');
    assert.equal(l3.Header.LineItemCount, 1);
    assert.equal(l3.items.length, 1);
    assert.equal(l3.items[0].UnitOfMeasure, 'EA');
  });

  it('Auto Rental L3 can be disabled via autoRental:false', async () => {
    await iposTransactClient.preAuthDeposit({
      amount: 500,
      agreementNumber: 'RA-2026-0001',
      cardToken: 'ipos-token-abc',
      autoRental: false,
    });
    assert.equal(lastRequest.body.L3Data, undefined);
  });

  it('Auto Rental L3 can be disabled via env IPOS_TRANSACT_AUTO_RENTAL=false', async () => {
    process.env.IPOS_TRANSACT_AUTO_RENTAL = 'false';
    try {
      await iposTransactClient.preAuthDeposit({
        amount: 500,
        agreementNumber: 'RA-2026-0001',
        cardToken: 'ipos-token-abc',
      });
      assert.equal(lastRequest.body.L3Data, undefined);
    } finally {
      process.env.IPOS_TRANSACT_AUTO_RENTAL = 'true';
    }
  });

  it('customer info populates preferences block when present', async () => {
    await iposTransactClient.preAuthDeposit({
      amount: 500,
      agreementNumber: 'RA-2026-0001',
      cardToken: 'ipos-token-abc',
      customer: { name: 'John Doe', email: 'john@example.com', phone: '+17875551212' },
    });
    const prefs = lastRequest.body.preferences;
    assert.equal(prefs.customerName, 'John Doe');
    assert.equal(prefs.customerEmail, 'john@example.com');
    assert.equal(prefs.customerMobile, '+17875551212');
    // eReceipt false — we own the receipt UX via PDF
    assert.equal(prefs.eReceipt, false);
  });

  it('missing cardToken throws synchronously', async () => {
    await assert.rejects(
      () => iposTransactClient.preAuthDeposit({ amount: 500, agreementNumber: 'X' }),
      /cardToken/,
    );
    await assert.rejects(
      () => iposTransactClient.chargeWithToken({ amount: 10, agreementNumber: 'X' }),
      /cardToken/,
    );
    await assert.rejects(
      () => iposTransactClient.voidByRrn({ agreementNumber: 'X' }),
      /rrn/,
    );
  });

  it('missing auth credentials throws a clear error (no static, no API key)', async () => {
    const prev = {
      tok: process.env.IPOS_TRANSACT_AUTH_TOKEN,
      key: process.env.IPOS_TRANSACT_API_KEY,
      sec: process.env.IPOS_TRANSACT_SECRET_KEY,
    };
    process.env.IPOS_TRANSACT_AUTH_TOKEN = '';
    process.env.IPOS_TRANSACT_API_KEY = '';
    process.env.IPOS_TRANSACT_SECRET_KEY = '';
    try {
      await assert.rejects(
        () => iposTransactClient.preAuthDeposit({
          amount: 500, agreementNumber: 'X', cardToken: 'tok',
        }),
        /not configured|IPOS_TRANSACT_AUTH_TOKEN|IPOS_TRANSACT_API_KEY/i,
      );
    } finally {
      process.env.IPOS_TRANSACT_AUTH_TOKEN = prev.tok || '';
      process.env.IPOS_TRANSACT_API_KEY = prev.key || '';
      process.env.IPOS_TRANSACT_SECRET_KEY = prev.sec || '';
    }
  });
});

describe('iPOSpays Transact client — response normalization', () => {
  it('normalizes approved (responseCode 200)', () => {
    const norm = iposTransactClient.normalizeResponse({
      iposTransactResponse: {
        responseCode: 200,
        responseMessage: 'Successful',
        responseApprovalCode: 'TAS001',
        RRN: '123456789012',
        transactionId: 'tx-1',
        amount: 500,
      },
    });
    assert.equal(norm.approved, true);
    assert.equal(norm.authCode, 'TAS001');
    assert.equal(norm.rrn, '123456789012');
    assert.equal(norm.amount, 500);
  });

  it('normalizes declined (responseCode 400)', () => {
    const norm = iposTransactClient.normalizeResponse({
      iposTransactResponse: {
        responseCode: 400,
        responseMessage: 'Declined',
        errResponseCode: '05',
        errResponseMessage: 'Do not honor',
      },
    });
    assert.equal(norm.approved, false);
    assert.equal(norm.errMessage, 'Do not honor');
  });

  it('handles empty / malformed response gracefully', () => {
    const norm = iposTransactClient.normalizeResponse({});
    assert.equal(norm.approved, false);
    assert.equal(norm.rrn, '');
  });
});

describe('iPOSpays Transact client — dry-run', () => {
  beforeEach(() => { process.env.IPOS_TRANSACT_DRY_RUN = 'true'; });
  afterEach(() => { process.env.IPOS_TRANSACT_DRY_RUN = ''; });

  it('dry-run returns a synthetic approval without hitting the network', async () => {
    const resp = await iposTransactClient.preAuthDeposit({
      amount: 500, agreementNumber: 'X', cardToken: 'tok',
    });
    const norm = iposTransactClient.normalizeResponse(resp);
    assert.equal(norm.approved, true);
    assert.ok(norm.rrn);
    assert.ok(norm.authCode);
  });
});
