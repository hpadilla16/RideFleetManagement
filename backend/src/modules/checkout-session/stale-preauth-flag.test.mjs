/**
 * B5 Phase 1 — MONEY-ADJACENT regression (QA B1).
 * The nightly sweep used to stamp depositHoldVoidedAt WITHOUT calling any
 * gateway, so the DB claimed the customer's hold was released while it stayed
 * live on their card. These tests pin the corrected behavior.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { paymentOpsQueue } from '../payment-gateway/payment-ops-queue.service.js';
import { _internal } from './checkout-session.scheduler.js';

let db;
let raised;

function agreement(over = {}) {
  return {
    id: 'ra1', tenantId: 't1', reservationId: 'res1',
    depositHoldId: 'RRN-LIVE-1', depositHoldVoidedAt: null,
    depositHoldAmount: 250, depositHoldExpiresAt: null, cardOnFileCapturedAt: null,
    ...over,
  };
}

beforeEach(() => {
  db = { agreements: [agreement()], updates: [] };
  raised = [];
  prisma.checkoutSession.findMany = async () => [
    { id: 'cs1', agreementId: 'ra1', agreement: db.agreements[0] },
  ];
  prisma.rentalAgreement.update = async ({ where, data }) => {
    db.updates.push({ where, data });
    return {};
  };
  paymentOpsQueue.raise = async (args) => { raised.push(args); return { id: 'flag1', ...args }; };
});

test('a live stale hold is FLAGGED for staff and NEVER falsely stamped as voided', async () => {
  const flagged = await _internal.voidStalePreauths();

  assert.equal(flagged, 1);
  assert.equal(db.updates.length, 0, 'no depositHoldVoidedAt stamp — no gateway void happened');
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, 'STRANDED_DEPOSIT_HOLD');
  assert.equal(raised[0].status, 'NOT_ATTEMPTED', 'distinct from "gateway call failed"');
  assert.equal(raised[0].gatewayRef, 'RRN-LIVE-1');
  assert.equal(raised[0].rentalAgreementId, 'ra1');
  assert.equal(raised[0].reservationId, 'res1');
  assert.equal(raised[0].amount, 250);
});

test('an agreement with a REAL prior gateway void is skipped (not re-flagged)', async () => {
  db.agreements[0] = agreement({ depositHoldVoidedAt: new Date() });
  assert.equal(await _internal.voidStalePreauths(), 0);
  assert.equal(raised.length, 0);
  assert.equal(db.updates.length, 0);
});

test('no hold on file → nothing flagged, nothing stamped', async () => {
  db.agreements[0] = agreement({ depositHoldId: null });
  assert.equal(await _internal.voidStalePreauths(), 0);
  assert.equal(raised.length, 0);
  assert.equal(db.updates.length, 0);
});

test('a queue failure never crashes the nightly sweep', async () => {
  paymentOpsQueue.raise = async () => { throw new Error('db down'); };
  assert.equal(await _internal.voidStalePreauths(), 0);
  assert.equal(db.updates.length, 0, 'still no false stamp on the error path');
});
