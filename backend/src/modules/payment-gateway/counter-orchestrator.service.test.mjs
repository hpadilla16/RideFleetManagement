/**
 * Tests for counter-orchestrator.service.js (2026-05-21).
 * Run: node --test backend/src/modules/payment-gateway/counter-orchestrator.service.test.mjs
 *
 * Heavy use of DI seams (deps.*) to avoid hitting prisma / spinpos / supabase.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runCounterCheckinFlow,
  CounterOrchestratorError,
  _internal,
} from './counter-orchestrator.service.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakePrisma({ tenants, reservations, terminals } = {}) {
  let nextId = 1;
  const signings = [];
  const signingFields = [];
  const transactions = [];
  return {
    _state: { tenants, reservations, terminals, signings, signingFields, transactions },
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
      async update({ where, data }) {
        const idx = reservations.findIndex((r) => r.id === where.id);
        if (idx !== -1) reservations[idx] = { ...reservations[idx], ...data };
        return reservations[idx];
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
    reservationSigning: {
      async findUnique({ where }) {
        return signings.find((s) => s.reservationId === where.reservationId) || null;
      },
      async create({ data }) {
        const row = { id: `sgn_${nextId++}`, createdAt: new Date(), ...data };
        signings.push(row);
        return row;
      },
      async update({ where, data }) {
        const idx = signings.findIndex((s) => s.id === where.id);
        if (idx !== -1) signings[idx] = { ...signings[idx], ...data };
        return signings[idx];
      },
    },
    reservationSigningField: {
      async findMany({ where, select }) {
        const rows = signingFields.filter((f) => f.signingId === where.signingId);
        if (!select) return rows;
        return rows.map((r) => {
          const out = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
          return out;
        });
      },
      async create({ data }) {
        const row = { id: `sf_${nextId++}`, createdAt: new Date(), ...data };
        signingFields.push(row);
        return row;
      },
    },
    dejavooTransaction: {
      async create({ data }) {
        const row = { id: `tx_${nextId++}`, ...data };
        transactions.push(row);
        return row;
      },
      async update({ where, data }) {
        const idx = transactions.findIndex((t) => t.id === where.id);
        if (idx !== -1) transactions[idx] = { ...transactions[idx], ...data };
        return transactions[idx];
      },
    },
    // Round 21 — tenantAuditLog for pre-auth override audit
    tenantAuditLog: {
      _rows: [],
      async create({ data }) {
        const row = { id: `tal_${nextId++}`, createdAt: new Date(), ...data };
        this._rows.push(row);
        return row;
      },
    },
    // Round 20 — customer for card-on-file token promotion
    customer: {
      async update({ where, data }) {
        const r = reservations.find((x) => x.customer?.id === where.id);
        if (r && r.customer) Object.assign(r.customer, data);
        return r?.customer || { id: where.id, ...data };
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

function makeSpinStub({ onSignature, onChoice, onInput } = {}) {
  let sigIdx = 0;
  let choiceIdx = 0;
  let inputIdx = 0;
  return {
    disclaimer: async () => makeOkResponse(),
    getSignature: async () => {
      const sig = onSignature ? onSignature(sigIdx++) : 'TINY_PNG_BASE64';
      return makeOkResponse({ SignatureData: sig });
    },
    userChoice: async () => {
      const choice = onChoice ? onChoice(choiceIdx++) : 'Sí';
      return makeOkResponse({ SelectedChoice: choice });
    },
    userInput: async () => {
      const value = onInput ? onInput(inputIdx++) : '2026-05-21';
      return makeOkResponse({ UserInput: value });
    },
    autoRentalAuth: async () =>
      makeOkResponse({
        AuthCode: 'AUTH123',
        CardData: { Last4: '4242', CardType: 'VISA', EntryType: 'CHIP' },
      }),
    normalizeResponse: (resp) => ({
      approved: resp?.GeneralResponse?.StatusCode === '0000',
      statusCode: resp?.GeneralResponse?.StatusCode || '',
      message: resp?.GeneralResponse?.Message || '',
      detailedMessage: resp?.GeneralResponse?.DetailedMessage || '',
      authCode: resp?.AuthCode || '',
      cardData: resp?.CardData
        ? {
            last4: resp.CardData.Last4 || '',
            cardType: resp.CardData.CardType || '',
            entryType: resp.CardData.EntryType || '',
          }
        : null,
    }),
  };
}

function makeStorageStub() {
  const uploaded = [];
  return {
    uploaded,
    uploadSignatureBlob: async (args) => {
      const path = `tenants/${args.tenantId}/reservations/${args.reservationId}/signing/${args.kind}-${args.fieldKey}-x.png`;
      uploaded.push({ ...args, storagePath: path });
      return { storagePath: path, contentType: 'image/png', sizeBytes: 100 };
    },
  };
}

const SAMPLE_TEMPLATE = {
  id: 'tpl1',
  contentHtml: '<p>{{INITIALS_A}}{{SIG_X}}{{CB_Y}}{{TEXT_Z}}{{DATE_D}}</p>',
  name: 'Sample',
  fields: [
    { id: 'f1', kind: 'INITIAL', markerKey: 'INITIALS_A', label: 'Section A', required: true, order: 0 },
    { id: 'f2', kind: 'SIGNATURE', markerKey: 'SIG_X', label: 'Sign', required: true, order: 1 },
    { id: 'f3', kind: 'CHECKBOX', markerKey: 'CB_Y', label: 'Decline', required: true, order: 2 },
    { id: 'f4', kind: 'TEXT_FIELD', markerKey: 'TEXT_Z', label: 'License', required: true, order: 3 },
    { id: 'f5', kind: 'DATE', markerKey: 'DATE_D', label: 'Today', required: true, order: 4 },
  ],
};

function baseDeps({ flags = { interactiveTC: true, dejavooCounter: true }, signOpts, template = SAMPLE_TEMPLATE } = {}) {
  const tenants = [
    { id: 't1', name: 'Pilot', settingsJson: { dejavoo: { preAuthAmountCents: 25000 } }, termsHtml: null },
  ];
  const reservations = [
    {
      id: 'r1',
      tenantId: 't1',
      estimatedTotal: 500,
      pickupAt: new Date('2026-05-21T14:00:00Z'),
      returnAt: new Date('2026-05-24T14:00:00Z'),
      pickupLocation: { code: 'SJU' },
      returnLocation: { code: 'SJU' },
      vehicle: { plate: 'ABC123', vehicleType: { code: 'SFAR' } },
      customer: { firstName: 'M', lastName: 'Rivera', licenseNumber: 'PR-1234' },
      charges: [{ name: 'Base', quantity: 3, rate: 75, total: 225, selected: true }],
      rentalAgreement: { agreementNumber: 'AG-1', dailyRate: 75, totalDays: 3 },
    },
  ];
  const terminals = [
    {
      id: 'term1',
      tenantId: 't1',
      tpn: '12345',
      authKeyEnc: 'PLAINTEXT_KEY',
      merchantNumber: 1,
      sandbox: true,
      status: 'ACTIVE',
    },
  ];
  return {
    prisma: makeFakePrisma({ tenants, reservations, terminals }),
    spin: makeSpinStub(signOpts),
    storage: makeStorageStub(),
    getFlagOn: async (_tenantId, name) => !!flags[name],
    getActiveTemplate: async () => template,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('runCounterCheckinFlow completes end-to-end with all field kinds', async () => {
  const deps = baseDeps();
  const user = { sub: 'u_alice', role: 'AGENT', tenantId: 't1' };
  const result = await runCounterCheckinFlow({
    reservationId: 'r1',
    terminalId: 'term1',
    user,
    deps,
  });
  assert.equal(result.completed, true);
  assert.equal(result.signedFields, 5);
  assert.equal(result.pendingFields, 0);
  assert.equal(result.authAmountCents, 25000);
  assert.equal(result.cardLast4, '4242');
  // Reservation.signingCompletedAt set
  const r = deps.prisma._state.reservations[0];
  assert.ok(r.signingCompletedAt instanceof Date);
  // Signing row finalized
  const sgn = deps.prisma._state.signings[0];
  assert.ok(sgn.completedAt instanceof Date);
  assert.equal(sgn.customerCardLast4, '4242');
  // 5 signing fields persisted
  assert.equal(deps.prisma._state.signingFields.length, 5);
  // Many DejavooTransaction rows
  const txTypes = deps.prisma._state.transactions.map((t) => t.type);
  assert.ok(txTypes.includes('DISCLAIMER'));
  assert.ok(txTypes.includes('GET_SIGNATURE'));
  assert.ok(txTypes.includes('USER_CHOICE'));
  assert.ok(txTypes.includes('USER_INPUT'));
  assert.ok(txTypes.includes('AUTH'));
});

// ---------------------------------------------------------------------------
// Feature flag gate
// ---------------------------------------------------------------------------

test('runCounterCheckinFlow refuses when interactiveTC OFF', async () => {
  const deps = baseDeps({ flags: { interactiveTC: false, dejavooCounter: true } });
  await assert.rejects(
    () =>
      runCounterCheckinFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err instanceof CounterOrchestratorError && err.code === 'FLAG_OFF'
  );
});

test('runCounterCheckinFlow refuses when dejavooCounter OFF', async () => {
  const deps = baseDeps({ flags: { interactiveTC: true, dejavooCounter: false } });
  await assert.rejects(
    () =>
      runCounterCheckinFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err instanceof CounterOrchestratorError && err.code === 'FLAG_OFF'
  );
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('runCounterCheckinFlow requires reservationId + terminalId + tenantScope', async () => {
  const deps = baseDeps();
  await assert.rejects(
    () => runCounterCheckinFlow({ terminalId: 'term1', user: { tenantId: 't1' }, deps }),
    /reservationId required/
  );
  await assert.rejects(
    () => runCounterCheckinFlow({ reservationId: 'r1', user: { tenantId: 't1' }, deps }),
    /terminalId required/
  );
  await assert.rejects(
    () =>
      runCounterCheckinFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: {},
        deps,
      }),
    /user.tenantId required/
  );
});

// ---------------------------------------------------------------------------
// Pre-conditions
// ---------------------------------------------------------------------------

test('runCounterCheckinFlow 404 when reservation not in tenant scope', async () => {
  const deps = baseDeps();
  await assert.rejects(
    () =>
      runCounterCheckinFlow({
        reservationId: 'r_missing',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'RESERVATION_NOT_FOUND'
  );
});

test('runCounterCheckinFlow 404 when terminal not in tenant scope', async () => {
  const deps = baseDeps();
  await assert.rejects(
    () =>
      runCounterCheckinFlow({
        reservationId: 'r1',
        terminalId: 'term_missing',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'TERMINAL_NOT_FOUND'
  );
});

test('runCounterCheckinFlow 409 when terminal inactive', async () => {
  const deps = baseDeps();
  deps.prisma._state.terminals[0].status = 'INACTIVE';
  await assert.rejects(
    () =>
      runCounterCheckinFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'TERMINAL_INACTIVE'
  );
});

test('runCounterCheckinFlow 422 when no active TermsTemplate', async () => {
  const deps = baseDeps();
  deps.getActiveTemplate = async () => null;
  await assert.rejects(
    () =>
      runCounterCheckinFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'NO_ACTIVE_TEMPLATE'
  );
});

// ---------------------------------------------------------------------------
// Resume + already-signed
// ---------------------------------------------------------------------------

test('runCounterCheckinFlow 409 when reservation already signed', async () => {
  const deps = baseDeps();
  deps.prisma._state.signings.push({
    id: 'sgn_pre',
    reservationId: 'r1',
    templateId: 'tpl1',
    completedAt: new Date(),
    surfaceUsed: 'DEJAVOO_TERMINAL',
  });
  await assert.rejects(
    () =>
      runCounterCheckinFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'ALREADY_SIGNED'
  );
});

// ---------------------------------------------------------------------------
// Date validation
// ---------------------------------------------------------------------------

test('runCounterCheckinFlow 422 when DATE input is not parseable', async () => {
  const deps = baseDeps({ signOpts: { onInput: (idx) => (idx === 0 ? 'PR-1234' : 'not a date') } });
  await assert.rejects(
    () =>
      runCounterCheckinFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'INVALID_DATE'
  );
});

// ---------------------------------------------------------------------------
// AUTH-decline path
// ---------------------------------------------------------------------------

test('runCounterCheckinFlow 402 when AUTH declined', async () => {
  const deps = baseDeps();
  deps.spin.autoRentalAuth = async () => ({
    GeneralResponse: { ResultCode: 0, StatusCode: '0010', Message: 'CARD DECLINED' },
  });
  await assert.rejects(
    () =>
      runCounterCheckinFlow({
        reservationId: 'r1',
        terminalId: 'term1',
        user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
        deps,
      }),
    (err) => err.code === 'AUTH_DECLINED'
  );
});

// ---------------------------------------------------------------------------
// resolvePreAuthAmountCents
// ---------------------------------------------------------------------------

test('resolvePreAuthAmountCents prefers tenant settings', () => {
  const tenant = { settingsJson: { dejavoo: { preAuthAmountCents: 50000 } } };
  const reservation = { estimatedTotal: 1000 };
  assert.equal(_internal.resolvePreAuthAmountCents(tenant, reservation), 50000);
});

test('resolvePreAuthAmountCents falls back to 25% of estimatedTotal', () => {
  const tenant = { settingsJson: {} };
  const reservation = { estimatedTotal: 400 };
  // 25% of 400 = 100; *100 cents = 10000
  assert.equal(_internal.resolvePreAuthAmountCents(tenant, reservation), 10000);
});

test('resolvePreAuthAmountCents last-resort default 25000', () => {
  assert.equal(_internal.resolvePreAuthAmountCents({}, {}), 25000);
});

// ---------------------------------------------------------------------------
// makeRefId / isValidIsoDate
// ---------------------------------------------------------------------------

test('makeRefId includes prefix + reservation suffix', () => {
  const ref = _internal.makeRefId('AUTH', 'reservation_xyz_12345678');
  assert.match(ref, /^AUTH-12345678-/);
  assert.ok(ref.length <= 50);
});

test('isValidIsoDate accepts YYYY-MM-DD and ISO datetime', () => {
  assert.equal(_internal.isValidIsoDate('2026-05-21'), true);
  assert.equal(_internal.isValidIsoDate('2026-05-21T10:30:00Z'), true);
  assert.equal(_internal.isValidIsoDate('not-a-date'), false);
  assert.equal(_internal.isValidIsoDate(''), false);
  assert.equal(_internal.isValidIsoDate(null), false);
});

// ---------------------------------------------------------------------------
// AuthKey decryption fallback
// ---------------------------------------------------------------------------

test('resolveTenantConfigForTerminal decrypts when authKeyEnc has enc:v1: prefix', async () => {
  const deps = baseDeps();
  deps.prisma._state.terminals[0].authKeyEnc = 'enc:v1:CIPHERTEXT_HERE';
  // Inject decrypt fn into the deps that the orchestrator threads through
  const tenantConfig = await _internal.resolveTenantConfigForTerminal(
    deps.prisma._state.terminals[0],
    deps.prisma._state.tenants[0],
    { decrypt: (cipher) => `DECRYPTED:${cipher}` }
  );
  assert.equal(tenantConfig.spinAuthKey, 'DECRYPTED:CIPHERTEXT_HERE');
  assert.equal(tenantConfig.spinTpn, '12345');
  assert.equal(tenantConfig.spinSandbox, true);
});

test('resolveTenantConfigForTerminal uses plaintext authKeyEnc when no prefix', async () => {
  const tenantConfig = await _internal.resolveTenantConfigForTerminal(
    {
      id: 'term',
      tenantId: 't',
      tpn: '999',
      authKeyEnc: 'RAW_KEY',
      merchantNumber: 1,
      sandbox: false,
    },
    { settingsJson: {} },
  );
  assert.equal(tenantConfig.spinAuthKey, 'RAW_KEY');
});

test('resolveTenantConfigForTerminal falls back to tenant.settingsJson.spinAuthKey', async () => {
  const tenantConfig = await _internal.resolveTenantConfigForTerminal(
    { id: 'term', tenantId: 't', tpn: '999', authKeyEnc: null, merchantNumber: 1 },
    { settingsJson: { spinAuthKey: 'LEGACY_KEY' } }
  );
  assert.equal(tenantConfig.spinAuthKey, 'LEGACY_KEY');
});

test('resolveTenantConfigForTerminal throws when no key anywhere', async () => {
  await assert.rejects(
    () =>
      _internal.resolveTenantConfigForTerminal(
        { id: 'term', tenantId: 't', tpn: '999', authKeyEnc: null, merchantNumber: 1 },
        { settingsJson: {} }
      ),
    (err) => err instanceof CounterOrchestratorError && err.code === 'AUTHKEY_MISSING'
  );
});

// ---------------------------------------------------------------------------
// Round 21 — pre-auth override
// ---------------------------------------------------------------------------

test('runCounterCheckinFlow uses tenant default pre-auth when no override', async () => {
  const deps = baseDeps();
  // tenant settings has preAuthAmountCents = 25000 (set in baseDeps)
  const result = await runCounterCheckinFlow({
    reservationId: 'r1',
    terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    deps,
  });
  assert.equal(result.authAmountCents, 25000);
  // No audit row written
  assert.equal(deps.prisma.tenantAuditLog._rows.length, 0);
});

test('runCounterCheckinFlow applies pre-auth override + writes audit row', async () => {
  const deps = baseDeps();
  const result = await runCounterCheckinFlow({
    reservationId: 'r1',
    terminalId: 'term1',
    user: { sub: 'u_alice', role: 'AGENT', tenantId: 't1' },
    preAuthOverrideCents: 50000, // $500 override vs $250 default
    preAuthOverrideReason: 'Manager Juan approved — corporate client',
    deps,
  });
  assert.equal(result.authAmountCents, 50000);
  // Audit row written
  const audits = deps.prisma.tenantAuditLog._rows;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'PREAUTH_OVERRIDE');
  assert.equal(audits[0].actorUserId, 'u_alice');
  assert.equal(audits[0].payload.defaultCents, 25000);
  assert.equal(audits[0].payload.overrideCents, 50000);
  assert.equal(audits[0].payload.reason, 'Manager Juan approved — corporate client');
  // The AUTH DejavooTransaction.customLabel reflects the override
  const authTx = deps.prisma._state.transactions.find((t) => t.type === 'AUTH');
  assert.match(authTx.customLabel, /override/i);
});

test('runCounterCheckinFlow no-op override (same as default) does not audit', async () => {
  const deps = baseDeps();
  await runCounterCheckinFlow({
    reservationId: 'r1',
    terminalId: 'term1',
    user: { sub: 'u', role: 'AGENT', tenantId: 't1' },
    preAuthOverrideCents: 25000, // same as default
    deps,
  });
  // No audit row for no-op
  assert.equal(deps.prisma.tenantAuditLog._rows.length, 0);
});
