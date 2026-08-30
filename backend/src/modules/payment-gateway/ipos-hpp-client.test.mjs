import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  hppEndpoints,
  hppReferenceId,
  isValidHppReferenceId,
  resolveTenantHppConfig,
  hppConfigured,
  mintHostedPaymentPage,
  queryHppPaymentStatus,
  normalizeHppStatus,
  hppSafeCustomerName,
  hppSafeMobile,
} from './ipos-hpp-client.js';

// THE FIRST LIVE LINK FAILED ON A NAME. iPOSpays rejected the whole mint with
// "preferences.customerName - Invalid Customer Name" because the customer was
// called Héctor — an accent, in a market where accents are the norm, not the
// edge. These pin the sanitizer that keeps a name from ever costing a payment.
describe('ipos-hpp-client: customer field sanitizing', () => {
  it('strips diacritics instead of rejecting the customer', () => {
    assert.equal(hppSafeCustomerName('Héctor Padilla'), 'Hector Padilla');
    assert.equal(hppSafeCustomerName('José Muñoz-Rivera'), 'Jose MunozRivera');
    assert.equal(hppSafeCustomerName("Mary O'Brien"), 'Mary OBrien');
  });

  it('omits the field entirely when nothing survives — optional beats invalid', () => {
    assert.equal(hppSafeCustomerName('李伟'), null);
    assert.equal(hppSafeCustomerName('   '), null);
    assert.equal(hppSafeCustomerName(null), null);
  });

  it('caps at 25 like the Transact client, without a trailing space', () => {
    const out = hppSafeCustomerName('Maximiliano Buenaventura de los Santos');
    assert.ok(out.length <= 25);
    assert.equal(out, out.trim());
  });

  it('mobile is ten digits or nothing', () => {
    assert.equal(hppSafeMobile('+1 (407) 664-4254'), '4076644254');
    assert.equal(hppSafeMobile('123'), null);
    assert.equal(hppSafeMobile(null), null);
  });
});

// NOTE (gitleaks): every credential-shaped string in this file is an obvious
// dummy — never shaped like a real ecom token or TPN in use.
const DUMMY_TOKEN = 'dummy-hpp-token-not-real';
const DUMMY_TPN = '000011112222';

function fakePrismaWithConfig(config) {
  return {
    appSetting: {
      async findUnique({ where }) {
        if (!config) return null;
        return { key: where.key, value: JSON.stringify(config) };
      },
    },
  };
}

beforeEach(() => {
  delete process.env.IPOS_HPP_DRY_RUN;
  delete process.env.SPIN_DRY_RUN;
});
afterEach(() => {
  delete process.env.IPOS_HPP_DRY_RUN;
  delete process.env.SPIN_DRY_RUN;
});

describe('ipos-hpp-client: endpoints', () => {
  it('routes sandbox and production to the documented hosts', () => {
    assert.equal(
      hppEndpoints({ environment: 'sandbox' }).hpp,
      'https://payment.ipospays.tech/api/v1/external-payment-transaction',
    );
    assert.equal(
      hppEndpoints({ environment: 'sandbox' }).query,
      'https://api.ipospays.tech/v1/queryPaymentStatus',
    );
    assert.equal(
      hppEndpoints({ environment: 'production' }).hpp,
      'https://payment.ipospays.com/api/v1/external-payment-transaction',
    );
    assert.equal(
      hppEndpoints({}).query,
      'https://api.ipospays.com/v1/queryPaymentStatus',
      'unknown/absent environment must default to production',
    );
  });
});

describe('ipos-hpp-client: reference ids', () => {
  it('mints strictly alphanumeric references of at most 20 chars', () => {
    for (const seed of ['RES-2026-0001', 'weird seed!! §§', '', 'R'.repeat(60)]) {
      const ref = hppReferenceId(seed, { dryRun: false });
      assert.match(ref, /^[A-Za-z0-9]{1,20}$/, `bad ref for seed ${JSON.stringify(seed)}: ${ref}`);
    }
  });

  it('two references for the same seed differ (uniqueness by construction)', () => {
    const a = hppReferenceId('RES1', { dryRun: false });
    const b = hppReferenceId('RES1', { dryRun: false });
    assert.notEqual(a, b);
  });

  it('dry-run references encode the amount in cents', () => {
    const ref = hppReferenceId('RES1', { dryRun: true, amount: 123.45 });
    assert.match(ref, /^DRY12345X/);
    assert.ok(isValidHppReferenceId(ref));
  });

  it('isValidHppReferenceId rejects separators and overlong values', () => {
    assert.equal(isValidHppReferenceId('ABC123'), true);
    assert.equal(isValidHppReferenceId('ABC-123'), false);
    assert.equal(isValidHppReferenceId(''), false);
    assert.equal(isValidHppReferenceId('A'.repeat(21)), false);
  });
});

describe('ipos-hpp-client: tenant config resolution (fail closed, NO env fallback)', () => {
  it('resolves a complete ipos block (legacy plaintext token passes dual-read)', async () => {
    const resolved = await resolveTenantHppConfig('t1', {
      prismaClient: fakePrismaWithConfig({
        ipos: { enabled: true, environment: 'sandbox', tpn: DUMMY_TPN, hppToken: DUMMY_TOKEN, expiryDays: 7 },
      }),
    });
    assert.equal(resolved.source, 'TENANT');
    assert.equal(resolved.tpn, DUMMY_TPN);
    assert.equal(resolved.hppToken, DUMMY_TOKEN);
    assert.equal(resolved.environment, 'sandbox');
    assert.equal(resolved.expiryDays, 7);
    assert.ok(hppConfigured(resolved));
  });

  it('falls back to the tenant OWN spin.tpn when ipos.tpn is blank', async () => {
    const resolved = await resolveTenantHppConfig('t1', {
      prismaClient: fakePrismaWithConfig({
        spin: { tpn: DUMMY_TPN },
        ipos: { hppToken: DUMMY_TOKEN },
      }),
    });
    assert.equal(resolved.source, 'TENANT');
    assert.equal(resolved.tpn, DUMMY_TPN);
  });

  it('half-configured (token without any tpn) resolves NONE — never paired with platform values', async () => {
    const resolved = await resolveTenantHppConfig('t1', {
      prismaClient: fakePrismaWithConfig({ ipos: { hppToken: DUMMY_TOKEN } }),
    });
    assert.equal(resolved.source, 'NONE');
    assert.equal(resolved.reason, 'INCOMPLETE_CONFIG');
    assert.equal(hppConfigured(resolved), false);
  });

  it('missing row, missing tenant id and read failure all resolve NONE', async () => {
    const noRow = await resolveTenantHppConfig('t1', { prismaClient: fakePrismaWithConfig(null) });
    assert.equal(noRow.source, 'NONE');
    const noTenant = await resolveTenantHppConfig('', { prismaClient: fakePrismaWithConfig({}) });
    assert.equal(noTenant.source, 'NONE');
    const broken = await resolveTenantHppConfig('t1', {
      prismaClient: { appSetting: { async findUnique() { throw new Error('db down'); } } },
    });
    assert.equal(broken.source, 'NONE');
    assert.equal(broken.reason, 'READ_FAILED');
  });

  it('resolution NEVER reads platform env credentials', async () => {
    process.env.SPIN_TPN = '999988887777';
    try {
      const resolved = await resolveTenantHppConfig('t1', { prismaClient: fakePrismaWithConfig(null) });
      assert.equal(resolved.source, 'NONE');
      assert.equal(resolved.tpn, '');
    } finally {
      delete process.env.SPIN_TPN;
    }
  });
});

function resolvedConfig(overrides = {}) {
  return {
    source: 'TENANT', reason: 'TENANT_CONFIG', tenantId: 't1',
    environment: 'sandbox', tpn: DUMMY_TPN, hppToken: DUMMY_TOKEN,
    expiryDays: 3, enabled: true, maskedTpn: '0000****2222',
    ...overrides,
  };
}

function fetchStub(response, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok, status,
      text: async () => JSON.stringify(response),
      headers: { get: () => null },
    };
  };
  return { impl, calls };
}

describe('ipos-hpp-client: getHostedPaymentPage', () => {
  it('POSTs the documented shape and returns the hosted URL', async () => {
    const { impl, calls } = fetchStub({
      message: 'URL generated successfully',
      information: 'https://payment.ipospays.tech/api/v1/externalPay?t=abc',
    });
    const out = await mintHostedPaymentPage({
      amount: 251.5,
      transactionReferenceId: 'PLRES1X2Y3',
      returnUrl: 'https://api.example.com/return?x=1',
      cancelUrl: 'https://api.example.com/cancel',
      customer: { name: 'Jane Doe', email: 'jane@example.com' },
      merchantName: 'International Rental Corp',
    }, resolvedConfig(), { fetchImpl: impl });

    assert.equal(out.url, 'https://payment.ipospays.tech/api/v1/externalPay?t=abc');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://payment.ipospays.tech/api/v1/external-payment-transaction');
    assert.equal(calls[0].options.headers.token, DUMMY_TOKEN);

    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.merchantAuthentication.merchantId, DUMMY_TPN);
    assert.equal(body.merchantAuthentication.transactionReferenceId, 'PLRES1X2Y3');
    assert.equal(body.transactionRequest.transactionType, 1);
    assert.equal(body.transactionRequest.amount, '25150', 'amount must be cents as a string');
    assert.equal(body.transactionRequest.calculateFee, false);
    assert.equal(body.transactionRequest.calculateTax, false);
    assert.equal(body.transactionRequest.tipsInputPrompt, false);
    assert.equal(body.transactionRequest.expiry, 3);
    assert.equal(body.notificationOption.notifyByRedirect, true);
    assert.equal(body.notificationOption.notifyByPOST, false);
    assert.equal(body.notificationOption.returnUrl, 'https://api.example.com/return?x=1');
    assert.equal(body.notificationOption.failureUrl, 'https://api.example.com/cancel', 'failureUrl must fall back to cancelUrl, not the success URL');
    assert.equal(body.preferences.integrationType, 1);
    assert.equal(body.preferences.requestCardToken, false);
    assert.equal(body.preferences.customerName, 'Jane Doe');
    assert.equal(body.personalization.merchantName, 'International Rental Corp');
  });

  it('surfaces the documented errors[] shape as GATEWAY_ERROR', async () => {
    const { impl } = fetchStub({ errors: [{ field: 'amount', message: 'Amount is invalid' }] }, { ok: false, status: 400 });
    await assert.rejects(
      () => mintHostedPaymentPage({
        amount: 10, transactionReferenceId: 'PLX1', returnUrl: 'https://x.example/r',
      }, resolvedConfig(), { fetchImpl: impl }),
      (err) => err.code === 'GATEWAY_ERROR' && /amount/i.test(err.message),
    );
  });

  it('refuses to mint without tenant config (fail closed)', async () => {
    const { impl, calls } = fetchStub({});
    await assert.rejects(
      () => mintHostedPaymentPage({
        amount: 10, transactionReferenceId: 'PLX1', returnUrl: 'https://x.example/r',
      }, { source: 'NONE' }, { fetchImpl: impl }),
      (err) => err.code === 'GATEWAY_NOT_CONFIGURED',
    );
    assert.equal(calls.length, 0, 'must not reach the gateway at all');
  });

  it('rejects a non-alphanumeric reference before any network call', async () => {
    const { impl, calls } = fetchStub({});
    await assert.rejects(
      () => mintHostedPaymentPage({
        amount: 10, transactionReferenceId: 'PL-X1', returnUrl: 'https://x.example/r',
      }, resolvedConfig(), { fetchImpl: impl }),
    );
    assert.equal(calls.length, 0);
  });

  it('dry-run mints a synthetic URL without credentials or network', async () => {
    process.env.IPOS_HPP_DRY_RUN = 'true';
    const { impl, calls } = fetchStub({});
    const out = await mintHostedPaymentPage({
      amount: 10, transactionReferenceId: 'DRY1000Xabc', returnUrl: 'https://x.example/r',
    }, { source: 'NONE' }, { fetchImpl: impl });
    assert.match(out.url, /^https:\/\//);
    assert.equal(calls.length, 0);
  });
});

describe('ipos-hpp-client: queryPaymentStatus', () => {
  it('GETs the documented URL and normalizes an approved response', async () => {
    const { impl, calls } = fetchStub({
      iposHPResponse: {
        responseCode: 200,
        responseMessage: 'Successful',
        transactionReferenceId: 'PLRES1X2Y3',
        transactionId: '11112222333344445555',
        amount: 251.5,
        totalAmount: 251.5,
        cardType: 'VISA',
        cardLast4Digit: 1111,
        responseApprovalCode: 'TAS164',
        rrn: '000000123456',
      },
    });
    const status = await queryHppPaymentStatus(
      { transactionReferenceId: 'PLRES1X2Y3' },
      resolvedConfig(),
      { fetchImpl: impl },
    );
    assert.equal(calls[0].url, `https://api.ipospays.tech/v1/queryPaymentStatus?tpn=${DUMMY_TPN}&transactionReferenceId=PLRES1X2Y3`);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.headers.token, DUMMY_TOKEN);
    assert.equal(status.approved, true);
    assert.equal(status.amount, 251.5);
    assert.equal(status.transactionId, '11112222333344445555');
    assert.equal(status.cardLast4, '1111');
  });

  it('accepts the live-API lowercase envelope (iposhpresponse)', () => {
    const status = normalizeHppStatus({
      iposhpresponse: { responseCode: 200, totalAmount: 10, transactionId: 'x1' },
    });
    assert.equal(status.approved, true);
    assert.equal(status.amount, 10);
  });

  it('a declined / cancelled payment is NOT approved', () => {
    for (const code of [400, 401, 402]) {
      const status = normalizeHppStatus({ iposHPResponse: { responseCode: code, totalAmount: 10 } });
      assert.equal(status.approved, false, `responseCode ${code} must not read as approved`);
    }
  });

  it('dry-run echoes the amount encoded in a DRY reference', async () => {
    process.env.IPOS_HPP_DRY_RUN = 'true';
    const status = await queryHppPaymentStatus(
      { transactionReferenceId: 'DRY25150Xabc' },
      { source: 'NONE' },
      { fetchImpl: async () => { throw new Error('must not fetch'); } },
    );
    assert.equal(status.approved, true);
    assert.equal(status.amount, 251.5);
  });

  it('refuses to query without tenant config (fail closed)', async () => {
    await assert.rejects(
      () => queryHppPaymentStatus({ transactionReferenceId: 'PLX1' }, { source: 'NONE' }, {}),
      (err) => err.code === 'GATEWAY_NOT_CONFIGURED',
    );
  });
});
