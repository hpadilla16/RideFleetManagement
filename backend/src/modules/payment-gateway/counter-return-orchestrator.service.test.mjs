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
