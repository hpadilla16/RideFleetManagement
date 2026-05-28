/**
 * Tests for the Spin charge orchestrator.
 * Run: node --test backend/src/modules/checkout-session/spin-charge.test.mjs
 *
 * The orchestrator's branching is what makes it risky — sale-success-
 * preauth-fail must roll back via void, tokenize-missing should be
 * non-fatal, etc. These tests stub prisma + spinClient to exercise
 * each branch without touching a real terminal.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import * as spinClientModule from '../payment-gateway/spin-client.js';
import { spinChargeService } from './spin-charge.service.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let calls;
function reset() {
  calls = { sale: 0, preAuth: 0, void: 0, payments: [], agreementUpdates: [], sessionUpdates: [] };
}

function setupHappyPathPrisma() {
  prisma.checkoutSession.findUnique = async () => ({
    id: 's1',
    currentStep: 'TC_SIGNED',
    events: '[]',
    reservation: { id: 'r1', reservationNumber: 'RES-1', tenantId: 't1' },
    agreement: { id: 'a1', agreementNumber: 'RA-1', paidAmount: 0 },
  });
  prisma.tenant.findUnique = async () => ({ id: 't1' });
  prisma.rentalAgreement.update = async ({ where, data }) => {
    calls.agreementUpdates.push({ where, data });
    return {};
  };
  prisma.rentalAgreementPayment.create = async ({ data }) => {
    calls.payments.push(data);
    return data;
  };
  prisma.rentalAgreementPayment.updateMany = async ({ where, data }) => {
    return { count: 1 };
  };
  prisma.checkoutSession.update = async ({ where, data }) => {
    calls.sessionUpdates.push({ where, data });
    return {};
  };
}

beforeEach(() => {
  reset();
  setupHappyPathPrisma();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('happy path: sale + tokenize + preauth + persist + stamp', async () => {
  spinClientModule.spinClient.sale = async () => {
    calls.sale += 1;
    return {
      GeneralResponse: { StatusCode: '0000', ResultCode: 0 },
      AuthCode: 'AUTH1',
      Token: '',
      IPosToken: 'tok-ipos-1',
      CardData: { CardType: 'VISA', Last4: '4242' },
    };
  };
  spinClientModule.spinClient.preAuthDeposit = async () => {
    calls.preAuth += 1;
    return {
      GeneralResponse: { StatusCode: '0000', ResultCode: 0 },
      AuthCode: 'AUTH-DEP',
    };
  };
  spinClientModule.spinClient.void = async () => { calls.void += 1; return {}; };

  const result = await spinChargeService.runChargeSequence({
    sessionId: 's1', amount: 317.78, depositAmount: 500,
  });

  assert.equal(calls.sale, 1);
  assert.equal(calls.preAuth, 1);
  assert.equal(calls.void, 0, 'no rollback on happy path');
  assert.equal(calls.payments.length, 1, 'one sale payment recorded');
  assert.equal(calls.payments[0].amount, 317.78);
  assert.equal(calls.payments[0].method, 'CARD');

  // Card-on-file persisted + deposit hold persisted
  const cofUpdate = calls.agreementUpdates.find((u) => u.data.cardOnFileToken);
  assert.ok(cofUpdate, 'card-on-file was persisted');
  assert.equal(cofUpdate.data.cardOnFileToken, 'tok-ipos-1');
  assert.equal(cofUpdate.data.cardOnFileBrand, 'VISA');
  assert.equal(cofUpdate.data.cardOnFileLast4, '4242');

  const depUpdate = calls.agreementUpdates.find((u) => u.data.depositHoldId);
  assert.ok(depUpdate, 'deposit hold was persisted');
  assert.equal(depUpdate.data.depositHoldAmount, 500);

  // Session stamped + result shape
  const sessUpdate = calls.sessionUpdates[0];
  assert.ok(sessUpdate.data.paymentCompletedAt instanceof Date);
  assert.equal(result.sale.approved, true);
  assert.equal(result.preauth.approved, true);
  assert.equal(result.cardOnFile.token, 'tok-ipos-1');
});

// ---------------------------------------------------------------------------
// Sale-declined path (no rollback needed)
// ---------------------------------------------------------------------------

test('sale-declined: throws SALE_DECLINED, no preauth attempt, no rollback', async () => {
  spinClientModule.spinClient.sale = async () => {
    calls.sale += 1;
    throw new Error('Card declined');
  };
  spinClientModule.spinClient.preAuthDeposit = async () => { calls.preAuth += 1; return {}; };
  spinClientModule.spinClient.void = async () => { calls.void += 1; return {}; };

  await assert.rejects(
    () => spinChargeService.runChargeSequence({ sessionId: 's1', amount: 100 }),
    (err) => err.code === 'SALE_DECLINED' && err.status === 402,
  );
  assert.equal(calls.sale, 1);
  assert.equal(calls.preAuth, 0, 'no preauth on sale failure');
  assert.equal(calls.void, 0, 'nothing to roll back');
  assert.equal(calls.payments.length, 0, 'no payment row');
});

// ---------------------------------------------------------------------------
// Sale-OK + preauth-fail → MUST ROLL BACK via void
// ---------------------------------------------------------------------------

test('preauth-fails-after-sale: void rolls back the sale + payment marked VOID', async () => {
  spinClientModule.spinClient.sale = async () => {
    calls.sale += 1;
    return {
      GeneralResponse: { StatusCode: '0000', ResultCode: 0 },
      AuthCode: 'AUTH1',
      IPosToken: 'tok-1',
      CardData: { CardType: 'VISA', Last4: '4242' },
    };
  };
  spinClientModule.spinClient.preAuthDeposit = async () => {
    calls.preAuth += 1;
    throw new Error('Insufficient available credit for hold');
  };
  spinClientModule.spinClient.void = async () => { calls.void += 1; return {}; };

  await assert.rejects(
    () => spinChargeService.runChargeSequence({ sessionId: 's1', amount: 200, depositAmount: 500 }),
    (err) => err.code === 'PREAUTH_FAILED' && err.status === 402,
  );
  assert.equal(calls.sale, 1);
  assert.equal(calls.preAuth, 1);
  assert.equal(calls.void, 1, 'sale was voided');
});

// ---------------------------------------------------------------------------
// Sale-OK + no token in response (rare) → still records sale,
// card-on-file stays empty, continues to preauth
// ---------------------------------------------------------------------------

test('tokenize-missing: non-fatal, card-on-file stays empty', async () => {
  spinClientModule.spinClient.sale = async () => {
    calls.sale += 1;
    return {
      GeneralResponse: { StatusCode: '0000', ResultCode: 0 },
      AuthCode: 'AUTH1',
      // No Token / IPosToken / CardData → extractCardOnFile returns null
    };
  };
  spinClientModule.spinClient.preAuthDeposit = async () => {
    calls.preAuth += 1;
    return { GeneralResponse: { StatusCode: '0000', ResultCode: 0 }, AuthCode: 'AUTH-DEP' };
  };
  spinClientModule.spinClient.void = async () => { calls.void += 1; return {}; };

  const result = await spinChargeService.runChargeSequence({
    sessionId: 's1', amount: 100, depositAmount: 200,
  });
  assert.equal(result.cardOnFile, null);
  // Card-on-file update should NOT have been called
  const cofUpdate = calls.agreementUpdates.find((u) => u.data.cardOnFileToken);
  assert.equal(cofUpdate, undefined);
  // But sale + deposit-hold still happened
  assert.equal(calls.payments.length, 1);
  const depUpdate = calls.agreementUpdates.find((u) => u.data.depositHoldId);
  assert.ok(depUpdate, 'deposit still persisted');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('rejects wrong-step state', async () => {
  prisma.checkoutSession.findUnique = async () => ({
    id: 's1',
    currentStep: 'CONFIRMING',
    events: '[]',
    reservation: { id: 'r1', reservationNumber: 'R-1', tenantId: 't1' },
    agreement: { id: 'a1', agreementNumber: 'RA-1', paidAmount: 0 },
  });
  await assert.rejects(
    () => spinChargeService.runChargeSequence({ sessionId: 's1', amount: 100 }),
    (err) => err.code === 'WRONG_STEP' && err.status === 409,
  );
});

test('rejects depositAmount=0 silently (skip preauth)', async () => {
  spinClientModule.spinClient.sale = async () => ({
    GeneralResponse: { StatusCode: '0000', ResultCode: 0 },
    AuthCode: 'A', IPosToken: 't', CardData: { CardType: 'VISA', Last4: '0' },
  });
  spinClientModule.spinClient.preAuthDeposit = async () => { calls.preAuth += 1; return {}; };
  const result = await spinChargeService.runChargeSequence({
    sessionId: 's1', amount: 100, depositAmount: 0,
  });
  assert.equal(calls.preAuth, 0, 'preauth skipped when depositAmount=0');
  assert.equal(result.preauth, null);
});
