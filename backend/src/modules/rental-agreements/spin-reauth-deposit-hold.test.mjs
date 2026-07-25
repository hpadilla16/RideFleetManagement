/**
 * MONEY regression (QA MAJOR, 2026-07-25).
 *
 * spinReauthDepositHold is void-old → pre-auth-new → persist. Once the
 * voidByRrn contract fix makes step 1 actually succeed at the gateway, a
 * failure in step 2 throws BEFORE the persist step — leaving the agreement
 * pointing at a hold that no longer exists, with depositHoldVoidedAt still
 * null. The DB and the staff panel would both claim a live hold while the
 * customer's card carries nothing.
 *
 * These tests pin: the truth is persisted, staff SEE the gap, and the original
 * gateway error still reaches the agent unchanged.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { iposTransactClient } from '../payment-gateway/ipos-transact-client.js';
import { paymentOpsQueue } from '../payment-gateway/payment-ops-queue.service.js';
import { rentalAgreementsService } from './rental-agreements.service.js';

const DECLINE = 'iPOSpays re-auth declined — insufficient funds';

let updates;
let audits;
let raised;
let originals;

function agreement(over = {}) {
  return {
    id: 'ra1',
    tenantId: 't1',
    reservationId: 'res1',
    agreementNumber: 'RA-2026-0001',
    cardOnFileToken: 'tok_abc',
    depositHoldId: 'RRN-OLD-1',
    depositHoldVoidedAt: null,
    depositHoldAmount: 250,
    customerFirstName: 'Ada',
    customerLastName: 'Lovelace',
    customerEmail: 'ada@example.com',
    customerPhone: '7875551234',
    reservation: { id: 'res1', tenantId: 't1', reservationNumber: 'RES-1', customer: {} },
    ...over,
  };
}

/** Wire the whole path with a healthy DB, an APPROVED void and a DECLINED re-auth. */
function wire({ row = agreement(), voidResult, preAuth } = {}) {
  prisma.rentalAgreement.findUnique = async () => row;
  prisma.tenant.findUnique = async () => ({ id: 't1' });
  prisma.rentalAgreement.update = async ({ where, data }) => {
    updates.push({ where, data });
    return {};
  };
  prisma.auditLog.create = async ({ data }) => { audits.push(data); return {}; };
  prisma.reservationPayment.create = async () => ({});
  paymentOpsQueue.raise = async (args) => { raised.push(args); return { id: 'flag1', ...args }; };

  // normalizeResponse is the identity here so the stubs below ARE the
  // normalized shapes — this suite is about control flow, not parsing.
  iposTransactClient.normalizeResponse = (r) => r;
  iposTransactClient.voidByRrn = async () => (
    typeof voidResult === 'function' ? voidResult() : (voidResult ?? { approved: true, rrn: 'RRN-OLD-1' })
  );
  iposTransactClient.preAuthDeposit = async () => (
    typeof preAuth === 'function' ? preAuth() : (preAuth ?? { approved: false, errMessage: DECLINE })
  );
  return row;
}

beforeEach(() => {
  updates = [];
  audits = [];
  raised = [];
  originals = {
    findUnique: prisma.rentalAgreement.findUnique,
    tenantFindUnique: prisma.tenant.findUnique,
    update: prisma.rentalAgreement.update,
    auditCreate: prisma.auditLog.create,
    paymentCreate: prisma.reservationPayment.create,
    raise: paymentOpsQueue.raise,
    normalize: iposTransactClient.normalizeResponse,
    voidByRrn: iposTransactClient.voidByRrn,
    preAuthDeposit: iposTransactClient.preAuthDeposit,
  };
});

afterEach(() => {
  prisma.rentalAgreement.findUnique = originals.findUnique;
  prisma.tenant.findUnique = originals.tenantFindUnique;
  prisma.rentalAgreement.update = originals.update;
  prisma.auditLog.create = originals.auditCreate;
  prisma.reservationPayment.create = originals.paymentCreate;
  paymentOpsQueue.raise = originals.raise;
  iposTransactClient.normalizeResponse = originals.normalize;
  iposTransactClient.voidByRrn = originals.voidByRrn;
  iposTransactClient.preAuthDeposit = originals.preAuthDeposit;
});

// ---------------------------------------------------------------------------
// The defect: void succeeded, replacement failed.
// ---------------------------------------------------------------------------

test('void APPROVED + re-auth DECLINED → hold stamped voided, flag raised, original error still thrown', async () => {
  wire();

  await assert.rejects(
    () => rentalAgreementsService.spinReauthDepositHold('ra1', { amount: 300 }, 'user1'),
    (err) => {
      assert.equal(err.message, DECLINE, 'the staff-facing gateway error must propagate unchanged');
      return true;
    },
  );

  // 1. The truth about the OLD hold is persisted.
  assert.equal(updates.length, 1, 'exactly one compensating update');
  const data = updates[0].data;
  assert.equal(updates[0].where.id, 'ra1');
  assert.ok(data.depositHoldVoidedAt instanceof Date, 'depositHoldVoidedAt stamped — a gateway void DID succeed');
  assert.ok(data.securityDepositReleasedAt instanceof Date, 'securityDepositReleasedAt stamped');
  assert.equal(data.securityDepositCaptured, false, 'no phantom "Authorized" deposit in the UI');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(data, 'depositHoldId'),
    'depositHoldId is RETAINED for traceability — the voided RRN is the audit handle',
  );

  // 2. Staff SEE that there is now no hold in place.
  assert.equal(raised.length, 1, 'exactly one payment ops flag');
  const flag = raised[0];
  assert.equal(flag.kind, 'ROLLBACK_FAILED', 'existing enum value — this ship stays migration-free');
  assert.notEqual(flag.kind, 'STRANDED_DEPOSIT_HOLD', 'the hold is GONE, not stranded live');
  assert.equal(flag.status, 'GATEWAY_FAILED', 'a gateway call was made and refused');
  assert.equal(flag.tenantId, 't1');
  assert.equal(flag.rentalAgreementId, 'ra1');
  assert.equal(flag.reservationId, 'res1');
  assert.equal(flag.gatewayRef, 'RRN-OLD-1', 'the ref that was voided');
  assert.equal(flag.amount, 300, 'the intended replacement amount');
  assert.equal(flag.lastError, DECLINE);
  assert.match(flag.note, /NO deposit hold/i);

  // 3. Audit trail.
  assert.equal(audits.length, 1);
  assert.match(audits[0].reason, /re-auth failed/i);
  assert.equal(JSON.parse(audits[0].metadata).voidedRef, 'RRN-OLD-1');
});

test('void APPROVED + preAuthDeposit THROWS → same compensating record, thrown error propagates', async () => {
  const boom = new Error('ECONNRESET talking to iPOSpays');
  wire({ preAuth: () => { throw boom; } });

  await assert.rejects(
    () => rentalAgreementsService.spinReauthDepositHold('ra1', { amount: 300 }, 'user1'),
    (err) => {
      assert.equal(err, boom, 'the SAME error object must reach the agent');
      return true;
    },
  );

  assert.equal(updates.length, 1);
  assert.ok(updates[0].data.depositHoldVoidedAt instanceof Date);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, 'ROLLBACK_FAILED');
  assert.equal(raised[0].lastError, boom.message);
});

// ---------------------------------------------------------------------------
// The no-void-happened paths must be completely unchanged: the old hold is
// still LIVE, so stamping it voided would be the exact false-stamp bug
// beta.343 removed from the nightly sweep.
// ---------------------------------------------------------------------------

test('no hold on file + re-auth DECLINED → no stamp, no flag', async () => {
  wire({ row: agreement({ depositHoldId: null }) });

  await assert.rejects(() => rentalAgreementsService.spinReauthDepositHold('ra1', { amount: 300 }));
  assert.equal(updates.length, 0);
  assert.equal(raised.length, 0);
  assert.equal(audits.length, 0);
});

test('gateway void DECLINED (hold still live) + re-auth DECLINED → no stamp, no flag', async () => {
  wire({ voidResult: { approved: false, errMessage: 'void declined' } });

  await assert.rejects(() => rentalAgreementsService.spinReauthDepositHold('ra1', { amount: 300 }));
  assert.equal(updates.length, 0, 'the old hold is STILL LIVE — never stamp it voided');
  assert.equal(raised.length, 0);
});

test('gateway void THREW (swallowed) + re-auth DECLINED → no stamp, no flag', async () => {
  wire({ voidResult: () => { throw new Error('gateway timeout'); } });

  await assert.rejects(() => rentalAgreementsService.spinReauthDepositHold('ra1', { amount: 300 }));
  assert.equal(updates.length, 0, 'a swallowed void failure is not evidence the hold is gone');
  assert.equal(raised.length, 0);
});

test('MANUAL- hold (bookkeeping only, no gateway call) + re-auth DECLINED → no stamp, no flag', async () => {
  let voidCalled = false;
  wire({
    row: agreement({ depositHoldId: 'MANUAL-123' }),
    voidResult: () => { voidCalled = true; return { approved: true }; },
  });

  await assert.rejects(() => rentalAgreementsService.spinReauthDepositHold('ra1', { amount: 300 }));
  assert.equal(voidCalled, false, 'the manual shortcut never calls the gateway');
  assert.equal(updates.length, 0, 'no gateway void happened — nothing to record');
  assert.equal(raised.length, 0);
});

test('an already-voided hold is not re-voided and raises nothing', async () => {
  let voidCalled = false;
  wire({
    row: agreement({ depositHoldVoidedAt: new Date() }),
    voidResult: () => { voidCalled = true; return { approved: true }; },
  });

  await assert.rejects(() => rentalAgreementsService.spinReauthDepositHold('ra1', { amount: 300 }));
  assert.equal(voidCalled, false);
  assert.equal(updates.length, 0);
  assert.equal(raised.length, 0);
});

// ---------------------------------------------------------------------------
// The bookkeeping must never mask the real gateway failure.
// ---------------------------------------------------------------------------

test('a flag-write failure never replaces the underlying gateway error', async () => {
  wire();
  paymentOpsQueue.raise = async () => { throw new Error('payment ops queue down'); };

  await assert.rejects(
    () => rentalAgreementsService.spinReauthDepositHold('ra1', { amount: 300 }),
    (err) => {
      assert.equal(err.message, DECLINE, 'the gateway decline wins over the flag-write failure');
      return true;
    },
  );
  assert.equal(updates.length, 1, 'the stamp still landed');
});

test('a stamp-write failure never replaces the underlying gateway error (and still flags)', async () => {
  wire();
  prisma.rentalAgreement.update = async () => { throw new Error('db down'); };

  await assert.rejects(
    () => rentalAgreementsService.spinReauthDepositHold('ra1', { amount: 300 }),
    (err) => {
      assert.equal(err.message, DECLINE);
      return true;
    },
  );
  assert.equal(raised.length, 1, 'the staff flag is still raised when the stamp cannot be written');
});

test('an audit-write failure never replaces the underlying gateway error', async () => {
  wire();
  prisma.auditLog.create = async () => { throw new Error('audit down'); };

  await assert.rejects(
    () => rentalAgreementsService.spinReauthDepositHold('ra1', { amount: 300 }),
    (err) => {
      assert.equal(err.message, DECLINE);
      return true;
    },
  );
  assert.equal(updates.length, 1);
  assert.equal(raised.length, 1);
});
