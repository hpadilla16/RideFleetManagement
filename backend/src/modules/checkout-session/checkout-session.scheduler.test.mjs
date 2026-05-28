/**
 * Tests for the checkout-session cleanup scheduler.
 * Run: node --test backend/src/modules/checkout-session/checkout-session.scheduler.test.mjs
 *
 * These tests cover the pure helpers via a fake prisma. The scheduling
 * timer itself isn't exercised because Node's test runner can't fast-
 * forward setTimeout reliably across async ticks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { _internal } from './checkout-session.scheduler.js';

const HOUR = 60 * 60 * 1000;

function makeSession(over) {
  return {
    id: 'sess_' + Math.random().toString(36).slice(2, 8),
    abandonedAt: null,
    currentStep: 'PAYMENT_PENDING',
    updatedAt: new Date(Date.now() - 5 * HOUR),
    events: '[]',
    agreementId: null,
    agreement: null,
    ...over,
  };
}

test('flagStuckSessions marks rows stalled > 4h, leaves fresh ones alone', async () => {
  const sessions = [
    makeSession({ id: 'old1', updatedAt: new Date(Date.now() - 5 * HOUR) }),
    makeSession({ id: 'old2', updatedAt: new Date(Date.now() - 6 * HOUR) }),
    makeSession({ id: 'fresh', updatedAt: new Date(Date.now() - 1 * HOUR) }),
    makeSession({ id: 'closed', currentStep: 'CLOSED', updatedAt: new Date(Date.now() - 10 * HOUR) }),
  ];
  const updates = [];
  prisma.checkoutSession.findMany = async ({ where }) => sessions.filter((s) => {
    if (s.abandonedAt !== null) return false;
    if (where.currentStep?.notIn?.includes(s.currentStep)) return false;
    if (where.updatedAt?.lt && s.updatedAt >= where.updatedAt.lt) return false;
    return true;
  });
  prisma.checkoutSession.update = async ({ where, data }) => {
    updates.push({ id: where.id, data });
    return {};
  };

  const count = await _internal.flagStuckSessions();
  assert.equal(count, 2, 'flagged the two stalled ones');
  assert.deepEqual(updates.map((u) => u.id).sort(), ['old1', 'old2']);
  for (const u of updates) {
    assert.ok(u.data.abandonedAt instanceof Date);
    assert.match(u.data.abandonedReason, /^auto_flagged_stalled_at_/);
  }
});

test('voidStalePreauths skips sessions without depositHoldId', async () => {
  prisma.checkoutSession.findMany = async () => [
    { id: 'a', agreementId: 'ag-a', agreement: { id: 'ag-a', depositHoldId: null } },
    { id: 'b', agreementId: 'ag-b', agreement: { id: 'ag-b', depositHoldId: 'hold-1', depositHoldVoidedAt: null, cardOnFileCapturedAt: new Date(Date.now() - 30 * HOUR) } },
  ];
  const updates = [];
  prisma.rentalAgreement.update = async ({ where, data }) => {
    updates.push({ id: where.id, data });
    return {};
  };

  const count = await _internal.voidStalePreauths();
  assert.equal(count, 1, 'voided just the one with a hold + old card');
  assert.equal(updates[0].id, 'ag-b');
  assert.ok(updates[0].data.depositHoldVoidedAt instanceof Date);
});

test('voidStalePreauths skips when already voided', async () => {
  prisma.checkoutSession.findMany = async () => [
    { id: 'a', agreementId: 'ag-a', agreement: { id: 'ag-a', depositHoldId: 'h', depositHoldVoidedAt: new Date(), cardOnFileCapturedAt: new Date(Date.now() - 30 * HOUR) } },
  ];
  let called = 0;
  prisma.rentalAgreement.update = async () => { called += 1; return {}; };
  const count = await _internal.voidStalePreauths();
  assert.equal(count, 0);
  assert.equal(called, 0);
});

test('voidStalePreauths respects 24h cutoff', async () => {
  prisma.checkoutSession.findMany = async () => [
    { id: 'a', agreementId: 'ag-a', agreement: { id: 'ag-a', depositHoldId: 'h', depositHoldVoidedAt: null, cardOnFileCapturedAt: new Date(Date.now() - 1 * HOUR) } },
  ];
  let called = 0;
  prisma.rentalAgreement.update = async () => { called += 1; return {}; };
  const count = await _internal.voidStalePreauths();
  assert.equal(count, 0, 'fresh card-on-file (1h) leaves the preauth alone');
  assert.equal(called, 0);
});
