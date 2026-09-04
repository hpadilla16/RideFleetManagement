/**
 * View Payments refund — gateway rail dispatch (2026-09-04).
 *
 * MONEY. refundPayment used to send card money back on exactly two rails
 * (PAYARC:/AUTHNET:) and silently posted a bookkeeping row for everything
 * else — including SPIn terminal sales and Transact card-on-file charges, so a
 * SPIn tenant (Corpusa) had no way to actually refund a customer. These tests
 * pin the new dispatch, control-flow style (gateway clients stubbed, prisma
 * stubbed — same pattern as spin-reauth-deposit-hold.test.mjs):
 *
 *  - AUTH_HOLD rows refuse (release the hold instead);
 *  - SPIn rows: same-day full → voidWithRetry (original amount), later →
 *    Return with the ReferenceId from the "Spin Sale · <refId>" note; same-day
 *    partial refuses; an unconfigured tenant terminal refuses BEFORE any call;
 *  - Transact IPOS_ rows: tenant-resolved SPIn terminal FORCES the SPIn rail
 *    (platform Transact creds must never touch another merchant's
 *    transaction); legacy env-path rows void by RRN, full amount only;
 *  - manual rows post the negative row with NO gateway call;
 *  - the negative ledger row + agreement mirror + audit metadata are written
 *    the same way for every rail.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { spinClient } from '../payment-gateway/spin-client.js';
import { iposTransactClient } from '../payment-gateway/ipos-transact-client.js';
import { rentalAgreementsService } from './rental-agreements.service.js';

let created; // reservationPayment.create rows
let mirrors; // rentalAgreementPayment.create rows
let audits;
let spinCalls;
let transactCalls;
let originals;

// Each test uses a FRESH tenant id — tenant-terminal-config caches its DB read
// per tenant for 60s and these tests run in one process.
let tenantSeq = 0;
const nextTenantId = () => `t-refund-${Date.now()}-${tenantSeq += 1}`;

const TENANT_SPIN_BLOCK = JSON.stringify({
  spin: { enabled: true, authKey: 'live-key', tpn: '123456789012' },
});

function agreementRow(over = {}) {
  return {
    id: 'ra1',
    tenantId: over.tenantId || 't1',
    reservationId: 'res1',
    agreementNumber: 'RA-2026-0001',
    pickupLocationId: null,
    total: 500,
    reservation: { id: 'res1', customer: {} },
    ...over,
  };
}

/**
 * Wire prisma + gateway clients. `terminalSetting` is the AppSetting value the
 * tenant-terminal resolver reads (null = tenant has no terminal config → with
 * no SPIN_* env either, resolution is NONE).
 */
function wire({ agreement, payment, terminalSetting = null, priorRefunds = [] }) {
  prisma.rentalAgreement.findUnique = async ({ where }) => {
    // refundPayment's initial load AND recomputeAgreementPaidAndBalance both
    // land here; the recompute only selects { total } so one shape serves both.
    if (where?.id === agreement.id) return agreement;
    return null;
  };
  prisma.reservationPayment.findFirst = async () => payment;
  prisma.reservationPayment.findMany = async () => priorRefunds;
  prisma.reservationPayment.create = async ({ data }) => { created.push(data); return { id: `rp-${created.length}`, ...data }; };
  prisma.reservationPayment.update = async () => ({});
  prisma.rentalAgreementPayment.create = async ({ data }) => { mirrors.push(data); return { id: `rap-${mirrors.length}`, ...data }; };
  prisma.rentalAgreementPayment.findMany = async () => [];
  prisma.rentalAgreement.update = async () => ({});
  prisma.auditLog.create = async ({ data }) => { audits.push(data); return {}; };
  // tenant-terminal-config resolver reads:
  prisma.tenant.findUnique = async () => ({ name: 'Test Tenant' });
  prisma.appSetting.findUnique = async () => (terminalSetting ? { value: terminalSetting } : null);

  spinClient.voidWithRetry = async (args) => { spinCalls.push({ op: 'void', ...args }); return { GeneralResponse: { StatusCode: '0000' } }; };
  spinClient.refund = async (args) => { spinCalls.push({ op: 'return', ...args }); return { GeneralResponse: { StatusCode: '0000' } }; };
  iposTransactClient.voidByRrn = async (args) => { transactCalls.push(args); return { approved: true, rrn: args.rrn }; };
  iposTransactClient.normalizeResponse = (r) => r;
}

const todayAt = (h = 9) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d; };
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

beforeEach(() => {
  created = []; mirrors = []; audits = []; spinCalls = []; transactCalls = [];
  originals = {
    agrFindUnique: prisma.rentalAgreement.findUnique,
    agrUpdate: prisma.rentalAgreement.update,
    rpFindFirst: prisma.reservationPayment.findFirst,
    rpFindMany: prisma.reservationPayment.findMany,
    rpCreate: prisma.reservationPayment.create,
    rpUpdate: prisma.reservationPayment.update,
    rapCreate: prisma.rentalAgreementPayment.create,
    rapFindMany: prisma.rentalAgreementPayment.findMany,
    auditCreate: prisma.auditLog.create,
    tenantFindUnique: prisma.tenant.findUnique,
    appSettingFindUnique: prisma.appSetting.findUnique,
    spinVoidWithRetry: spinClient.voidWithRetry,
    spinRefund: spinClient.refund,
    transactVoid: iposTransactClient.voidByRrn,
    transactNormalize: iposTransactClient.normalizeResponse,
  };
});

afterEach(() => {
  prisma.rentalAgreement.findUnique = originals.agrFindUnique;
  prisma.rentalAgreement.update = originals.agrUpdate;
  prisma.reservationPayment.findFirst = originals.rpFindFirst;
  prisma.reservationPayment.findMany = originals.rpFindMany;
  prisma.reservationPayment.create = originals.rpCreate;
  prisma.reservationPayment.update = originals.rpUpdate;
  prisma.rentalAgreementPayment.create = originals.rapCreate;
  prisma.rentalAgreementPayment.findMany = originals.rapFindMany;
  prisma.auditLog.create = originals.auditCreate;
  prisma.tenant.findUnique = originals.tenantFindUnique;
  prisma.appSetting.findUnique = originals.appSettingFindUnique;
  spinClient.voidWithRetry = originals.spinVoidWithRetry;
  spinClient.refund = originals.spinRefund;
  iposTransactClient.voidByRrn = originals.transactVoid;
  iposTransactClient.normalizeResponse = originals.transactNormalize;
});

test('AUTH_HOLD rows refuse — the Release deposit tool is the correct verb', async () => {
  const tenantId = nextTenantId();
  wire({
    agreement: agreementRow({ tenantId }),
    payment: { id: 'p1', method: 'AUTH_HOLD', amount: 250, status: 'PAID', reference: 'A8K2X9', paidAt: daysAgo(1) },
  });
  await assert.rejects(
    rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 250, reason: 'test' }),
    /release the deposit hold/i,
  );
  assert.equal(created.length, 0);
  assert.equal(spinCalls.length, 0);
});

test('SPIn same-day FULL refund voids at the terminal with the original amount + sale ReferenceId', async () => {
  const tenantId = nextTenantId();
  wire({
    agreement: agreementRow({ tenantId }),
    payment: {
      id: 'p1', method: 'CARD', amount: 212.4, status: 'PAID', gateway: 'SPIN',
      reference: 'A8K2X9', notes: 'Spin Sale · RFM-RES1-777', paidAt: todayAt(),
    },
    terminalSetting: TENANT_SPIN_BLOCK,
  });
  const out = await rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 212.4, reason: 'clean cancel' });
  assert.equal(out.rail, 'SPIN_VOID');
  assert.deepEqual(spinCalls.map((c) => c.op), ['void']);
  assert.equal(spinCalls[0].referenceId, 'RFM-RES1-777');
  assert.equal(spinCalls[0].amount, 212.4);
  assert.equal(transactCalls.length, 0);
  // negative ledger row + mirror, reason on the note after the load-bearing prefix
  assert.equal(created[0].amount, -212.4);
  assert.equal(created[0].reference, 'REFUND:p1');
  assert.match(created[0].notes, /^Refund for payment p1 — clean cancel$/);
  assert.equal(mirrors[0].amount, -212.4);
  const meta = JSON.parse(audits[0].metadata);
  assert.equal(meta.rail, 'SPIN_VOID');
});

test('SPIn same-day PARTIAL refund refuses — a void can only undo the whole sale', async () => {
  const tenantId = nextTenantId();
  wire({
    agreement: agreementRow({ tenantId }),
    payment: {
      id: 'p1', method: 'CARD', amount: 212.4, status: 'PAID', gateway: 'SPIN',
      reference: 'A8K2X9', notes: 'Spin Sale · RFM-RES1-777', paidAt: todayAt(),
    },
    terminalSetting: TENANT_SPIN_BLOCK,
  });
  await assert.rejects(
    rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 100, reason: 'partial' }),
    /refunded in full/i,
  );
  assert.equal(spinCalls.length, 0);
  assert.equal(created.length, 0);
});

test('SPIn settled (prior-day) refund sends a Return — partial amounts allowed', async () => {
  const tenantId = nextTenantId();
  wire({
    agreement: agreementRow({ tenantId }),
    payment: {
      id: 'p1', method: 'CARD', amount: 212.4, status: 'PAID', gateway: 'SPIN',
      reference: 'A8K2X9', notes: 'Spin Sale · RFM-RES1-777', paidAt: daysAgo(3),
    },
    terminalSetting: TENANT_SPIN_BLOCK,
  });
  const out = await rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 50, reason: 'toll overcharge' });
  assert.equal(out.rail, 'SPIN_RETURN');
  assert.deepEqual(spinCalls.map((c) => c.op), ['return']);
  assert.equal(spinCalls[0].amount, 50);
  assert.equal(spinCalls[0].referenceId, 'RFM-RES1-777');
  assert.equal(created[0].amount, -50);
});

test('SPIn row on a tenant with NO terminal config refuses before any gateway call', async () => {
  const tenantId = nextTenantId();
  const hadKey = process.env.SPIN_AUTH_KEY; const hadTpn = process.env.SPIN_TPN;
  delete process.env.SPIN_AUTH_KEY; delete process.env.SPIN_TPN;
  try {
    wire({
      agreement: agreementRow({ tenantId }),
      payment: {
        id: 'p1', method: 'CARD', amount: 100, status: 'PAID', gateway: 'SPIN',
        reference: 'A8K2X9', notes: 'Spin Sale · RFM-X', paidAt: daysAgo(2),
      },
      terminalSetting: null,
    });
    await assert.rejects(
      rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 100, reason: 'r' }),
      /No SPIn terminal is configured/i,
    );
    assert.equal(spinCalls.length, 0);
    assert.equal(created.length, 0);
  } finally {
    if (hadKey !== undefined) process.env.SPIN_AUTH_KEY = hadKey;
    if (hadTpn !== undefined) process.env.SPIN_TPN = hadTpn;
  }
});

test('Transact IPOS_ row + tenant-resolved SPIn terminal FORCES the SPIn rail (never platform Transact creds on another merchant)', async () => {
  const tenantId = nextTenantId();
  wire({
    agreement: agreementRow({ tenantId }),
    payment: {
      id: 'p1', method: 'CARD', amount: 75, status: 'PAID', gateway: 'SPIN',
      reference: 'IPOS_COF:RRN991122 ****4821', notes: 'Spin card-on-file charge (CNP)', paidAt: daysAgo(2),
    },
    terminalSetting: TENANT_SPIN_BLOCK,
  });
  const out = await rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 75, reason: 'r' });
  assert.equal(out.rail, 'SPIN_RETURN');
  assert.equal(transactCalls.length, 0, 'Transact client must NOT be called for a tenant-resolved terminal');
  assert.equal(spinCalls[0].referenceId, 'RRN991122');
});

test('Transact IPOS_ row on the legacy env path voids by RRN — full amount only', async () => {
  const tenantId = nextTenantId();
  const hadKey = process.env.SPIN_AUTH_KEY; const hadTpn = process.env.SPIN_TPN;
  delete process.env.SPIN_AUTH_KEY; delete process.env.SPIN_TPN;
  try {
    wire({
      agreement: agreementRow({ tenantId }),
      payment: {
        id: 'p1', method: 'CARD', amount: 75, status: 'PAID', gateway: 'SPIN',
        reference: 'IPOS_COF:RRN991122 ****4821', paidAt: daysAgo(2),
      },
      terminalSetting: null, // no tenant terminal → legacy env Transact path
    });
    await assert.rejects(
      rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 20, reason: 'partial' }),
      /refunded in full/i,
    );
    assert.equal(transactCalls.length, 0);

    const out = await rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 75, reason: 'full' });
    assert.equal(out.rail, 'TRANSACT_VOID');
    assert.equal(transactCalls.length, 1);
    assert.equal(transactCalls[0].rrn, 'RRN991122');
    assert.equal(spinCalls.length, 0);
  } finally {
    if (hadKey !== undefined) process.env.SPIN_AUTH_KEY = hadKey;
    if (hadTpn !== undefined) process.env.SPIN_TPN = hadTpn;
  }
});

test('manual rows (CASH) post the negative row with NO gateway call, method preserved', async () => {
  const tenantId = nextTenantId();
  wire({
    agreement: agreementRow({ tenantId }),
    payment: { id: 'p1', method: 'CASH', amount: 60, status: 'PAID', reference: 'OTC-123', paidAt: daysAgo(1) },
  });
  const out = await rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 60, reason: 'returned early' });
  assert.equal(out.rail, 'RECORD_ONLY');
  assert.equal(spinCalls.length, 0);
  assert.equal(transactCalls.length, 0);
  assert.equal(created[0].method, 'CASH');
  assert.equal(created[0].amount, -60);
});

test('refund amount may not exceed the original or the remaining refundable balance', async () => {
  const tenantId = nextTenantId();
  wire({
    agreement: agreementRow({ tenantId }),
    payment: { id: 'p1', method: 'CASH', amount: 60, status: 'PAID', reference: 'OTC-123', paidAt: daysAgo(1) },
    priorRefunds: [{ amount: -40 }],
  });
  await assert.rejects(
    rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 61, reason: 'r' }),
    /cannot exceed the original/i,
  );
  await assert.rejects(
    rentalAgreementsService.refundPayment('ra1', 'p1', { amount: 30, reason: 'r' }),
    /remaining refundable balance/i,
  );
  assert.equal(created.length, 0);
});
