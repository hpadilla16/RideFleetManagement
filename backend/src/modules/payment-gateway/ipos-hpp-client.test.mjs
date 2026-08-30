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

  it('status check without the API Key or Secret Key refuses loudly, never guesses', async () => {
    for (const missing of [{ apiKey: '' }, { secretKey: '' }]) {
      await assert.rejects(
        () => queryHppPaymentStatus(
          { transactionReferenceId: 'PLRES1X2Y3' },
          resolvedConfig(missing),
          { fetchImpl: () => { throw new Error('must not be called'); } },
        ),
        (err) => err.code === 'GATEWAY_NOT_CONFIGURED' && /API Key/.test(err.message),
      );
    }
  });
});

// NOTE (gitleaks): every credential-shaped string in this file is an obvious
// dummy — never shaped like a real ecom token or TPN in use.
const DUMMY_TOKEN = 'dummy-hpp-token-not-real';
const DUMMY_TPN = '000011112222';
const DUMMY_API_KEY = 'dummy-merchant-api-key-not-real';
const DUMMY_SECRET_KEY = 'dummy-merchant-secret-not-real';
const DUMMY_JWT = 'dummy-minted-jwt-not-real';

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
    apiKey: DUMMY_API_KEY, secretKey: DUMMY_SECRET_KEY,
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

/**
 * A stub that answers each call in sequence — the status check is now TWO
 * requests: authenticate-token first, then the query.
 */
function sequencedFetchStub(responses) {
  const calls = [];
  const impl = async (url, options) => {
    const r = responses[Math.min(calls.length, responses.length - 1)];
    calls.push({ url, options });
    return {
      ok: r.ok !== false, status: r.status || 200,
      text: async () => JSON.stringify(r.body),
      headers: { get: () => null },
    };
  };
  return { impl, calls };
}

const APPROVED_STATUS_BODY = {
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
};

describe('ipos-hpp-client: queryPaymentStatus', () => {
  it('exchanges apiKey+secretKey for a JWT, then GETs the documented URL', async () => {
    const { impl, calls } = sequencedFetchStub([
      { body: { responseCode: '00', responseMessage: 'Success', token: DUMMY_JWT } },
      { body: APPROVED_STATUS_BODY },
    ]);
    const status = await queryHppPaymentStatus(
      { transactionReferenceId: 'PLRES1X2Y3' },
      resolvedConfig(),
      { fetchImpl: impl },
    );
    // THREE credentials in this integration, each with its own door: the ecom
    // token mints pages, and apiKey+secretKey mint the JWT the status API
    // accepts. Probed live 2026-08-30: the status API 401s the ecom token AND
    // the bare API key in every header spelling. Do not resurrect either.
    assert.equal(calls[0].url, 'https://auth.ipospays.tech/v1/authenticate-token');
    // Credentials must ride in the HEADERS (body-only gets AUTH_ERR_001 "API
    // Key is required" — probed live 2026-08-30, and ipos-auth.js had already
    // learned the same for Transact). Body carries a duplicate.
    assert.equal(calls[0].options.headers.apiKey, DUMMY_API_KEY);
    assert.equal(calls[0].options.headers.secretKey, DUMMY_SECRET_KEY);
    const authBody = JSON.parse(calls[0].options.body);
    assert.equal(authBody.apiKey, DUMMY_API_KEY);
    assert.equal(authBody.secretKey, DUMMY_SECRET_KEY);
    assert.equal(authBody.scope, 'ExternalApi');
    assert.equal(authBody.jwtTokenExpiryMinutes, 30);
    assert.equal(calls[1].url, `https://api.ipospays.tech/v1/queryPaymentStatus?tpn=${DUMMY_TPN}&transactionReferenceId=PLRES1X2Y3`);
    assert.equal(calls[1].options.method, 'GET');
    assert.equal(calls[1].options.headers.Authorization, `Bearer ${DUMMY_JWT}`);
    assert.equal(calls[1].options.headers.token, undefined, 'the ecom token must NOT be sent to the status API');
    assert.equal(status.approved, true);
    assert.equal(status.amount, 251.5);
    assert.equal(status.transactionId, '11112222333344445555');
    assert.equal(status.cardLast4, '1111');
  });

  it('walks the header chain on 401s and STOPS at the first acceptance', async () => {
    // Chain per scope: Bearer → raw Authorization → bare token. Here raw
    // Authorization is the winner, so the bare-token spelling is never sent.
    const { impl, calls } = sequencedFetchStub([
      { body: { token: DUMMY_JWT } },
      { ok: false, status: 401, body: { message: 'unauthorized' } },
      { body: APPROVED_STATUS_BODY },
    ]);
    const status = await queryHppPaymentStatus(
      { transactionReferenceId: 'PLRES1X2Y3' },
      resolvedConfig(),
      { fetchImpl: impl },
    );
    assert.equal(calls.length, 3);
    assert.equal(calls[1].options.headers.Authorization, `Bearer ${DUMMY_JWT}`);
    assert.equal(calls[2].options.headers.Authorization, DUMMY_JWT);
    assert.equal(status.approved, true);
  });

  it('exhausting one scope re-mints under the next scope before giving up', async () => {
    // All three spellings 401 under ExternalApi → a SECOND auth mint (call 5)
    // under PaymentTokenization, whose first spelling succeeds.
    const { impl, calls } = sequencedFetchStub([
      { body: { token: DUMMY_JWT } },
      { ok: false, status: 401, body: {} },
      { ok: false, status: 401, body: {} },
      { ok: false, status: 401, body: {} },
      { body: { token: DUMMY_JWT } },
      { body: APPROVED_STATUS_BODY },
    ]);
    const status = await queryHppPaymentStatus(
      { transactionReferenceId: 'PLRES1X2Y3' },
      resolvedConfig(),
      { fetchImpl: impl },
    );
    assert.equal(calls.length, 6);
    assert.equal(JSON.parse(calls[0].options.body).scope, 'ExternalApi');
    assert.equal(JSON.parse(calls[4].options.body).scope, 'PaymentTokenization');
    assert.equal(status.approved, true);
  });

  it('an auth-mint failure surfaces as GATEWAY_ERROR without touching the query', async () => {
    const { impl, calls } = sequencedFetchStub([
      { ok: false, status: 401, body: { responseMessage: 'bad credentials' } },
    ]);
    await assert.rejects(
      () => queryHppPaymentStatus(
        { transactionReferenceId: 'PLRES1X2Y3' }, resolvedConfig(), { fetchImpl: impl },
      ),
      (err) => err.code === 'GATEWAY_ERROR' && /auth token/i.test(err.message),
    );
    assert.equal(calls.length, 1);
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
