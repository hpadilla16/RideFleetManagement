/**
 * Tests for counter-return-orchestrator.service.js (2026-05-21).
 * Run: node --test backend/src/modules/payment-gateway/counter-return-orchestrator.service.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runCounterReturnFlow,
  _internal,
} from './counter-return-orchestrator.service.js';
import { CounterOrchestratorError } from './counter-orchestrator.service.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakePrisma({ tenants = [], reservations = [], terminals = [], priorAuths = [] } = {}) {
  let nextId = 1;
  const transactions = [...priorAuths];
  return {
    _state: { tenants, reservations, terminals, transactions },
    tenant: {
      async findUnique({ where, select }) {
        const t = tenants.find((x) => x.id === where.id);
        if (!t) return null;
        if (!select) return t;
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = t[k];
        return out;
      },
    },
    reservation: {
      async findFirst({ where }) {
        const r = reservations.find((x) => x.id === where.id && x.tenantId === where.tenantId);
        return r || null;
      },
    },
    dejavooTerminal: {
      async findFirst({ where }) {
        const t = terminals.find((x) => x.id === where.id && x.tenantId === where.tenantId);
        return t || null;
      },
      async update({ where, data }) {
        const idx = terminals.findIndex((t) => t.id === where.id);
        if (idx !== -1) terminals[idx] = { ...terminals[idx], ...data };
        return terminals[idx];
      },
    },
    dejavooTransaction: {
      async findFirst({ where, orderBy }) {
        let rows = transactions.filter((t) => {
          if (where.reservationId && t.reservationId !== where.reservationId) return false;
          if (where.type && t.type !== where.type) return false;
          if (where.approved !== undefined && t.approved !== where.approved) return false;
          return true;
        });
        if (orderBy?.createdAt === 'desc') {
          rows = rows.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        }
        return rows[0] || null;
      },
      async create({ data }) {
        const row = {
          id: `tx_${nextId++}`,
          createdAt: new Date(),
          ...data,
        };
        transactions.push(row);
        return row;
      },
      async update({ where, data }) {
        const idx = transactions.findIndex((t) => t.id === where.id);
        if (idx !== -1) transactions[idx] = { ...transactions[idx], ...data };
        return transactions[idx];
      },
    },
  };
}

function makeOkResponse(extra = {}) {
  return {
    GeneralResponse: { ResultCode: 0, StatusCode: '0000', Message: 'OK' },
    ...extra,
  };
}

function makeSpinStub({ overrides = {} } = {}) {
  return {
    cart: async () => makeOkResponse(),
    autoRentalCapture: async () => makeOkResponse({ AuthCode: 'AUTH_CAP' }),
    autoRentalSale: async () =>
      makeOkResponse({
        AuthCode: 'AUTH_SALE',
        SignatureData: 'BASE64_PNG',
        CardData: { Last4: '4242', CardType: 'VISA', EntryType: 'CHIP' },
      }),
    void: async () => makeOkResponse({ AuthCode: 'VOIDED' }),
    normalizeResponse: (resp) => ({
      approved: resp?.GeneralResponse?.StatusCode === '0000',
      statusCode: resp?.GeneralResponse?.StatusCode || '',
      message: resp?.GeneralResponse?.Message || '',
      detailedMessage: resp?.GeneralResponse?.DetailedMessage || '',
      authCode: resp?.AuthCode || '',
      cardData: resp?.CardData
        ? { last4: resp.CardData.Last4 || '', cardType: resp.CardData.CardType || '', entryType: resp.CardData.EntryType || '' }
        : null,
    }),
    ...overrides,
  };
}

function makeStorageStub() {
  const uploaded = [];
  return {
    uploaded,
    uploadSignatureBlob: async (args) => {
      const storagePath = `tenants/${args.tenantId}/reservations/${args.reservationId}/signing/receipt-${args.fieldKey}.png`;
      uploaded.push({ ...args, storagePath });
      return { storagePath, contentType: 'image/png', sizeBytes: 100 };
    },
  };
}

function baseDeps({ flagOn = true, finalCents, authCents = 25000, charges } = {}) {
  const tenants = [{ id: 't1', settingsJson: {} }];
  const reservations = [
    {
      id: 'r1',
      tenantId: 't1',
      pickupLocation: { code: 'SJU' },
      returnLocation: { code: 'SJU' },
      vehicle: { plate: 'ABC123', vehicleType: { code: 'SFAR' } },
      customer: { firstName: 'M', lastName: 'Rivera' },
      charges: charges || [{ name: 'Base', quantity: 3, rate: 75, total: 200, selected: true }],
      rentalAgreement: { agreementNumber: 'AG-1', dailyRate: 75, totalDays: 3 },
      signing: { id: 'sgn1' },
    },
  ];
  const terminals = [
    { id: 'term1', tenantId: 't1', tpn: '123', authKeyEnc: 'KEY', merchantNumber: 1, status: 'ACTIVE' },
  ];
  const priorAuths = [
    {
      id: 'auth1',
      tenantId: 't1',
      terminalId: 'term1',
      reservationId: 'r1',
      type: 'AUTH',
      referenceId: 'AUTH-REF-1',
      amountCents: authCents,
      approved: true,
      createdAt: new Date(Date.now() - 60_000),
    },
  ];
  return {
    prisma: makeFakePrisma({ tenants, reservations, terminals, priorAuths }),
    spin: makeSpinStub(),
    storage: makeStorageStub(),
    getFlagOn: async () => flagOn,
  };
}

// ---------------------------------------------------------------------------
// CASE A — final <= preAuth (capture)
// ---------------------------------------------------------------------------

test('CASE A: final <= preAuth → CAPTURE only', async () => {
  // charges total $200 = 20000 cents; preAuth = 25000
  const deps = baseDeps();
  // Override autoRentalCapture to return signature
  deps.spin.autoRentalCapture = async () =>
    makeOkResponse({
      AuthCode: 'CAP_OK',
      SignatureData: 'PNG_DATA',
      CardData: { Last4: '4242', CardType: 'VISA' },
    });
  const result = await runCounterReturnFlow({
    reservationId: 'r1',
    terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    deps,
  });
  assert.equal(result.case, 'CAPTURE');
  assert.equal(result.capturedAmountCents, 20000);
  assert.equal(result.additionalSaleCents, 0);
  assert.ok(result.captureReferenceId);
  assert.equal(result.receiptSignaturePath, 'tenants/t1/reservations/r1/signing/receipt-RECEIPT-' +
    deps.prisma._state.transactions.find((t) => t.type === 'CAPTURE').id.slice(-8) + '.png');
});

test('CASE A with explicit finalAmountCents override', async () => {
  const deps = baseDeps({ authCents: 50000 });
  // Charges total $200 but we override
  const result = await runCounterReturnFlow({
    reservationId: 'r1',
    terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    finalAmountCents: 12345,
    deps,
  });
  assert.equal(result.case, 'CAPTURE');
  assert.equal(result.capturedAmountCents, 12345);
});

// ---------------------------------------------------------------------------
// CASE B — final > preAuth (capture full + sale for diff)
// ---------------------------------------------------------------------------

test('CASE B: final > preAuth → CAPTURE full + SALE for difference', async () => {
  // charges $400 = 40000 cents; preAuth 25000 → capture 25000 + sale 15000
  const deps = baseDeps({
    authCents: 25000,
    charges: [{ name: 'Total', quantity: 1, rate: 400, total: 400, selected: true }],
  });
  const result = await runCounterReturnFlow({
    reservationId: 'r1',
    terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    deps,
  });
  assert.equal(result.case, 'CAPTURE_PLUS_SALE');
  assert.equal(result.capturedAmountCents, 25000);
  assert.equal(result.additionalSaleCents, 15000);
  assert.ok(result.captureReferenceId);
  assert.ok(result.saleReferenceId);
  // Two new txs (CAPTURE + SALE), plus CART, plus the seeded AUTH
  const types = deps.prisma._state.transactions.map((t) => t.type);
  assert.ok(types.filter((t) => t === 'CAPTURE').length === 1);
  assert.ok(types.filter((t) => t === 'SALE').length === 1);
});

test('CASE B with SALE declined throws AUTH_DECLINED-like error', async () => {
  const deps = baseDeps({
    authCents: 25000,
    charges: [{ name: 'Total', quantity: 1, rate: 400, total: 400, selected: true }],
  });
  deps.spin.autoRentalSale = async () => ({
    GeneralResponse: { ResultCode: 0, StatusCode: '0010', Message: 'DECLINED' },
  });
  await assert.rejects(
    () =>
      runCounterReturnFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err instanceof CounterOrchestratorError && err.code === 'SALE_FAILED'
  );
});

// ---------------------------------------------------------------------------
// CASE C — final == 0 (void)
// ---------------------------------------------------------------------------

test('CASE C: final == 0 → VOID pre-auth', async () => {
  const deps = baseDeps({
    finalCents: 0,
    charges: [], // empty charges = 0 total
  });
  const result = await runCounterReturnFlow({
    reservationId: 'r1',
    terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    deps,
  });
  assert.equal(result.case, 'VOID');
  assert.equal(result.capturedAmountCents, 0);
  assert.equal(result.additionalSaleCents, 0);
  assert.ok(result.voidReferenceId);
  assert.equal(result.receiptSignaturePath, null);
});

// ---------------------------------------------------------------------------
// Pre-conditions
// ---------------------------------------------------------------------------

test('runCounterReturnFlow refuses when dejavooCounter OFF', async () => {
  const deps = baseDeps({ flagOn: false });
  await assert.rejects(
    () =>
      runCounterReturnFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'FLAG_OFF'
  );
});

test('runCounterReturnFlow 422 when no prior AUTH exists', async () => {
  const deps = baseDeps();
  // Remove the prior AUTH
  deps.prisma._state.transactions.length = 0;
  await assert.rejects(
    () =>
      runCounterReturnFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'NO_PRIOR_AUTH'
  );
});

test('runCounterReturnFlow 409 when terminal inactive', async () => {
  const deps = baseDeps();
  deps.prisma._state.terminals[0].status = 'INACTIVE';
  await assert.rejects(
    () =>
      runCounterReturnFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'TERMINAL_INACTIVE'
  );
});

test('runCounterReturnFlow 404 when terminal not in tenant scope', async () => {
  const deps = baseDeps();
  await assert.rejects(
    () =>
      runCounterReturnFlow({
        reservationId: 'r1',
        terminalId: 'term_missing',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'TERMINAL_NOT_FOUND'
  );
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('runCounterReturnFlow rejects missing args', async () => {
  const deps = baseDeps();
  await assert.rejects(
    () => runCounterReturnFlow({ terminalId: 'term1', user: { tenantId: 't1' }, deps }),
    /reservationId required/
  );
  await assert.rejects(
    () => runCounterReturnFlow({ reservationId: 'r1', user: { tenantId: 't1' }, deps }),
    /terminalId required/
  );
  await assert.rejects(
    () =>
      runCounterReturnFlow({ reservationId: 'r1', terminalId: 'term1', user: {}, deps }),
    /user.tenantId required/
  );
});

// ---------------------------------------------------------------------------
// computeFinalAmountCents
// ---------------------------------------------------------------------------

test('computeFinalAmountCents sums selected charges', () => {
  const r = {
    charges: [
      { total: 100, selected: true },
      { total: 50.5, selected: true },
      { total: 25, selected: false },
    ],
  };
  assert.equal(_internal.computeFinalAmountCents(r), 15050);
});

test('computeFinalAmountCents handles empty/missing charges', () => {
  assert.equal(_internal.computeFinalAmountCents({}), 0);
  assert.equal(_internal.computeFinalAmountCents({ charges: [] }), 0);
});

test('computeFinalAmountCents handles Decimal-as-string', () => {
  const r = { charges: [{ total: '75.50', selected: true }, { total: '24.50', selected: true }] };
  assert.equal(_internal.computeFinalAmountCents(r), 10000);
});

// ---------------------------------------------------------------------------
// AuthKey resolution
// ---------------------------------------------------------------------------

test('resolveTenantConfigForTerminal handles encrypted authKey', async () => {
  const config = await _internal.resolveTenantConfigForTerminal(
    { id: 't', tenantId: 'x', tpn: '999', authKeyEnc: 'enc:v1:CIPHER', merchantNumber: 1, sandbox: false },
    { settingsJson: {} },
    { decrypt: (cipher) => `decrypted:${cipher}` }
  );
  assert.equal(config.spinAuthKey, 'decrypted:CIPHER');
  assert.equal(config.spinTpn, '999');
  assert.equal(config.spinSandbox, false);
});

test('resolveTenantConfigForTerminal falls back to plaintext', async () => {
  const config = await _internal.resolveTenantConfigForTerminal(
    { id: 't', tenantId: 'x', tpn: '999', authKeyEnc: 'PLAIN', merchantNumber: 1, sandbox: true },
    {}
  );
  assert.equal(config.spinAuthKey, 'PLAIN');
});

test('resolveTenantConfigForTerminal throws when no key anywhere', async () => {
  await assert.rejects(
    () =>
      _internal.resolveTenantConfigForTerminal(
        { id: 't', tenantId: 'x', tpn: '999', authKeyEnc: null, merchantNumber: 1 },
        { settingsJson: {} }
      ),
    (err) => err.code === 'AUTHKEY_MISSING'
  );
});

// ---------------------------------------------------------------------------
// Round 22 — extras-vs-deposit semantics
// ---------------------------------------------------------------------------
//
// At return, the orchestrator now reasons about EXTRAS = final - rentalFeePaid,
// not about the raw final. The base rental fee was already charged at pickup
// via SALE (single swipe → IPosToken saved on Customer). The deposit hold
// (AUTH against that token) is what we capture / void / overage-charge.

function baseDepsR22({
  flagOn = true, authCents = 25000, charges, rentalFeeCollectedCents = null,
  customerToken = null,
} = {}) {
  const tenants = [{ id: 't1', settingsJson: {} }];
  const reservations = [
    {
      id: 'r1',
      tenantId: 't1',
      pickupLocation: { code: 'SJU' },
      returnLocation: { code: 'SJU' },
      vehicle: { plate: 'ABC123', vehicleType: { code: 'SFAR' } },
      customer: {
        id: 'cust1',
        firstName: 'M',
        lastName: 'Rivera',
        dejavooIposToken: customerToken,
        dejavooCardLast4: customerToken ? '4242' : null,
        dejavooCardBrand: customerToken ? 'VISA' : null,
      },
      charges: charges || [{ name: 'Base', quantity: 3, rate: 75, total: 300, selected: true }],
      rentalAgreement: { agreementNumber: 'AG-1', dailyRate: 75, totalDays: 3 },
      signing: { id: 'sgn1' },
      rentalFeeCollectedAt: rentalFeeCollectedCents ? new Date() : null,
      rentalFeeCollectedCents,
    },
  ];
  const terminals = [
    { id: 'term1', tenantId: 't1', tpn: '123', authKeyEnc: 'KEY', merchantNumber: 1, status: 'ACTIVE' },
  ];
  const priorAuths = [
    {
      id: 'auth1',
      tenantId: 't1',
      terminalId: 'term1',
      reservationId: 'r1',
      type: 'AUTH',
      referenceId: 'AUTH-REF-1',
      amountCents: authCents,
      approved: true,
      createdAt: new Date(Date.now() - 60_000),
    },
  ];
  return {
    prisma: makeFakePrisma({ tenants, reservations, terminals, priorAuths }),
    spin: makeSpinStub(),
    storage: makeStorageStub(),
    getFlagOn: async () => flagOn,
  };
}

test('R22 — extras < hold with rental fee already collected → CAPTURE extras only', async () => {
  // total charges $300, rental fee $200 already collected at pickup → extras = $100
  // hold = $250 → capture $100, void $150 (auto by gateway).
  const deps = baseDepsR22({
    authCents: 25000,
    charges: [{ name: 'Total', quantity: 1, rate: 300, total: 300, selected: true }],
    rentalFeeCollectedCents: 20000,
  });
  let capturedAmount = null;
  deps.spin.autoRentalCapture = async ({ amount }) => {
    capturedAmount = amount;
    return makeOkResponse({ AuthCode: 'CAP_OK', CardData: { Last4: '4242', CardType: 'VISA' } });
  };
  const result = await runCounterReturnFlow({
    reservationId: 'r1', terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    deps,
  });
  assert.equal(result.case, 'CAPTURE');
  assert.equal(result.rentalFeeCollectedCents, 20000);
  assert.equal(result.extrasCents, 10000);
  assert.equal(result.capturedAmountCents, 10000);
  assert.equal(capturedAmount, 100); // dollars passed to spin
});

test('R22 — extras == 0 with rental fee fully covering total → VOID hold', async () => {
  // Most common: customer returns with no damage / late fee / fuel.
  // Rental fee $200 was paid at pickup, charges total $200 → extras = 0 → VOID.
  const deps = baseDepsR22({
    authCents: 25000,
    charges: [{ name: 'Total', quantity: 1, rate: 200, total: 200, selected: true }],
    rentalFeeCollectedCents: 20000,
  });
  const result = await runCounterReturnFlow({
    reservationId: 'r1', terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    deps,
  });
  assert.equal(result.case, 'VOID');
  assert.equal(result.rentalFeeCollectedCents, 20000);
  assert.equal(result.extrasCents, 0);
  assert.ok(result.voidReferenceId);
});

test('R22 — extras > hold WITH card-on-file → CAPTURE full + saleWithToken (CNP) for overage', async () => {
  // total $700, rental fee $200 → extras $500 > hold $250 → capture $250 + CNP sale $250
  const deps = baseDepsR22({
    authCents: 25000,
    charges: [{ name: 'Total', quantity: 1, rate: 700, total: 700, selected: true }],
    rentalFeeCollectedCents: 20000,
    customerToken: 'TOKEN_FROM_PICKUP',
  });
  let tokenSeen = null;
  let cnpAmount = null;
  deps.spin.saleWithToken = async ({ amount, iposToken }) => {
    tokenSeen = iposToken;
    cnpAmount = amount;
    return makeOkResponse({
      AuthCode: 'CNP_OK',
      CardData: { Last4: '4242', CardType: 'VISA', EntryType: 'CARD_ON_FILE' },
    });
  };
  const result = await runCounterReturnFlow({
    reservationId: 'r1', terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    deps,
  });
  assert.equal(result.case, 'CAPTURE_PLUS_SALE');
  assert.equal(result.capturedAmountCents, 25000);
  assert.equal(result.additionalSaleCents, 25000);
  assert.equal(result.additionalSaleMode, 'CARD_ON_FILE');
  assert.equal(tokenSeen, 'TOKEN_FROM_PICKUP');
  assert.equal(cnpAmount, 250); // dollars
  // CNP sale doesn't capture a signature, so receiptSignaturePath should be null.
  assert.equal(result.receiptSignaturePath, null);
});

test('R22 — extras > hold WITHOUT card-on-file → falls back to CARD_PRESENT sale', async () => {
  const deps = baseDepsR22({
    authCents: 25000,
    charges: [{ name: 'Total', quantity: 1, rate: 600, total: 600, selected: true }],
    rentalFeeCollectedCents: 20000,
    customerToken: null,
  });
  let cnpCalled = false;
  let cpCalled = false;
  deps.spin.saleWithToken = async () => { cnpCalled = true; return makeOkResponse({}); };
  const origAutoRentalSale = deps.spin.autoRentalSale;
  deps.spin.autoRentalSale = async (args) => {
    cpCalled = true;
    return origAutoRentalSale(args);
  };
  const result = await runCounterReturnFlow({
    reservationId: 'r1', terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    deps,
  });
  assert.equal(result.case, 'CAPTURE_PLUS_SALE');
  assert.equal(result.additionalSaleMode, 'CARD_PRESENT');
  assert.equal(cnpCalled, false);
  assert.equal(cpCalled, true);
});

test('R22 — explicit extrasAmountCents wins over computed extras', async () => {
  // Computed extras would be $0, but caller passes an explicit override of $80.
  const deps = baseDepsR22({
    authCents: 25000,
    charges: [{ name: 'Total', quantity: 1, rate: 200, total: 200, selected: true }],
    rentalFeeCollectedCents: 20000,
  });
  let capturedAmount = null;
  deps.spin.autoRentalCapture = async ({ amount }) => {
    capturedAmount = amount;
    return makeOkResponse({ AuthCode: 'CAP_OK', CardData: { Last4: '4242', CardType: 'VISA' } });
  };
  const result = await runCounterReturnFlow({
    reservationId: 'r1', terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    extrasAmountCents: 8000,
    deps,
  });
  assert.equal(result.case, 'CAPTURE');
  assert.equal(result.extrasCents, 8000);
  assert.equal(result.capturedAmountCents, 8000);
  assert.equal(capturedAmount, 80);
});

test('R22 — CNP sale declined → SALE_FAILED with helpful manual-refund hint', async () => {
  const deps = baseDepsR22({
    authCents: 25000,
    charges: [{ name: 'Total', quantity: 1, rate: 700, total: 700, selected: true }],
    rentalFeeCollectedCents: 20000,
    customerToken: 'TOKEN_X',
  });
  deps.spin.saleWithToken = async () => ({
    GeneralResponse: { ResultCode: 0, StatusCode: '0010', Message: 'DECLINED', DetailedMessage: 'Insufficient funds' },
  });
  await assert.rejects(
    () => runCounterReturnFlow({
      reservationId: 'r1', terminalId: 'term1',
      user: { sub: 'u', role: 'AGENT', tenantId: 't1' }, deps,
    }),
    (err) => err instanceof CounterOrchestratorError
      && err.code === 'SALE_FAILED'
      && /CARD_ON_FILE/.test(err.message)
      && /Pre-auth capture/.test(err.message),
  );
});
