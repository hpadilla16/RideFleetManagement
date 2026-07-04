// VozIA Fase 6 RE-SCOPE (2026-07-04) — service-account guard truth tables.
// Pure: no Express, no prisma. Exercises checkServiceAccountRefund /
// checkServiceAccountCharge directly, plus the assert* service-vs-human gates and
// the generalized ceiling resolver.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkServiceAccountRefund,
  checkServiceAccountCharge,
  assertServiceAccountRefundAllowed,
  assertServiceAccountChargeAllowed,
  resolveVoziaCeiling,
  DEFAULT_VOZIA_CEILING
} from './service-payment-guards.js';

// ---------------------------------------------------------------------------
// CAP 2 — REFUND
// ---------------------------------------------------------------------------
const refundBase = { author: 'VozIA', ticketId: 'T-123.abc_x', amount: 100, maxRefund: 2000 };

test('refund: happy path passes', () => {
  assert.deepEqual(checkServiceAccountRefund(refundBase), { ok: true });
});

test('refund: author required + <=120', () => {
  assert.equal(checkServiceAccountRefund({ ...refundBase, author: '' }).statusCode, 400);
  assert.equal(checkServiceAccountRefund({ ...refundBase, author: undefined }).statusCode, 400);
  assert.equal(checkServiceAccountRefund({ ...refundBase, author: 'x'.repeat(121) }).statusCode, 400);
  assert.equal(checkServiceAccountRefund({ ...refundBase, author: 'x'.repeat(120) }).ok, true);
});

test('refund: ticketId required + shape', () => {
  assert.equal(checkServiceAccountRefund({ ...refundBase, ticketId: '' }).statusCode, 400);
  assert.equal(checkServiceAccountRefund({ ...refundBase, ticketId: 'has space' }).statusCode, 400);
  assert.equal(checkServiceAccountRefund({ ...refundBase, ticketId: 'a'.repeat(65) }).statusCode, 400);
  assert.equal(checkServiceAccountRefund({ ...refundBase, ticketId: 'a'.repeat(64) }).ok, true);
});

test('refund: amount OPTIONAL (omitted = full original, allowed)', () => {
  assert.equal(checkServiceAccountRefund({ ...refundBase, amount: undefined }).ok, true);
  assert.equal(checkServiceAccountRefund({ ...refundBase, amount: null }).ok, true);
});

test('refund: amount when provided must be > 0', () => {
  assert.equal(checkServiceAccountRefund({ ...refundBase, amount: 0 }).statusCode, 400);
  assert.equal(checkServiceAccountRefund({ ...refundBase, amount: -1 }).statusCode, 400);
});

test('refund: amount > ceiling rejected; boundary passes', () => {
  const over = checkServiceAccountRefund({ ...refundBase, amount: 2000.01, maxRefund: 2000 });
  assert.equal(over.statusCode, 400);
  assert.match(over.error, /per-transaction refund limit/);
  assert.equal(over.details.max, 2000);
  // exactly at the ceiling passes.
  assert.equal(checkServiceAccountRefund({ ...refundBase, amount: 2000, maxRefund: 2000 }).ok, true);
});

// ---------------------------------------------------------------------------
// CAP 3+4 — CHARGE (positive) / CREDIT (negative)
// ---------------------------------------------------------------------------
const chargeBase = { author: 'VozIA', ticketId: 'T-9', name: 'Late return fee', amount: 50, maxLine: 2000 };

test('charge: happy path passes (positive = added service)', () => {
  assert.deepEqual(checkServiceAccountCharge(chargeBase), { ok: true });
});

test('credit: negative amount is allowed (that is the feature)', () => {
  assert.equal(checkServiceAccountCharge({ ...chargeBase, name: 'Goodwill credit', amount: -75 }).ok, true);
});

test('charge: author + ticketId required', () => {
  assert.equal(checkServiceAccountCharge({ ...chargeBase, author: '' }).statusCode, 400);
  assert.equal(checkServiceAccountCharge({ ...chargeBase, ticketId: 'has space' }).statusCode, 400);
});

test('charge: name required + <=120', () => {
  assert.equal(checkServiceAccountCharge({ ...chargeBase, name: '' }).statusCode, 400);
  assert.equal(checkServiceAccountCharge({ ...chargeBase, name: undefined }).statusCode, 400);
  assert.equal(checkServiceAccountCharge({ ...chargeBase, name: 'x'.repeat(121) }).statusCode, 400);
  assert.equal(checkServiceAccountCharge({ ...chargeBase, name: 'x'.repeat(120) }).ok, true);
});

test('charge: amount must be finite + non-zero', () => {
  assert.equal(checkServiceAccountCharge({ ...chargeBase, amount: 0 }).statusCode, 400);
  assert.equal(checkServiceAccountCharge({ ...chargeBase, amount: Number.NaN }).statusCode, 400);
  assert.equal(checkServiceAccountCharge({ ...chargeBase, amount: 'abc' }).statusCode, 400);
});

test('charge: ceiling applies to ABSOLUTE value (both directions)', () => {
  // positive over-ceiling
  const overPos = checkServiceAccountCharge({ ...chargeBase, amount: 2000.01, maxLine: 2000 });
  assert.equal(overPos.statusCode, 400);
  assert.match(overPos.error, /per-line limit/);
  assert.equal(overPos.details.max, 2000);
  // negative over-ceiling (big credit) — also refused
  const overNeg = checkServiceAccountCharge({ ...chargeBase, amount: -2000.01, maxLine: 2000 });
  assert.equal(overNeg.statusCode, 400);
  // both boundaries pass
  assert.equal(checkServiceAccountCharge({ ...chargeBase, amount: 2000, maxLine: 2000 }).ok, true);
  assert.equal(checkServiceAccountCharge({ ...chargeBase, amount: -2000, maxLine: 2000 }).ok, true);
});

// ---------------------------------------------------------------------------
// assert* service-vs-human gates
// ---------------------------------------------------------------------------
test('assert*: NO-OP for humans even with garbage body', () => {
  assert.doesNotThrow(() => assertServiceAccountRefundAllowed({
    user: { isServiceAccount: false },
    body: { amount: 999999 },
    maxRefund: 2000
  }));
  assert.doesNotThrow(() => assertServiceAccountChargeAllowed({
    user: { isServiceAccount: false },
    body: { amount: 999999, name: '' },
    maxLine: 2000
  }));
});

test('assertRefund: throws with statusCode + details for service accounts', () => {
  try {
    assertServiceAccountRefundAllowed({
      user: { isServiceAccount: true },
      body: { author: 'VozIA', ticketId: 'T-1', amount: 5000 },
      maxRefund: 2000
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /refund limit/);
    assert.equal(err.details.max, 2000);
  }
});

test('assertRefund: explicit amount arg overrides body', () => {
  // body has no amount, but the caller passes amount=5000 → over ceiling.
  assert.throws(() => assertServiceAccountRefundAllowed({
    user: { isServiceAccount: true },
    body: { author: 'VozIA', ticketId: 'T-1' },
    amount: 5000,
    maxRefund: 2000
  }), /refund limit/);
});

test('assertCharge: throws for missing provenance on service accounts', () => {
  try {
    assertServiceAccountChargeAllowed({
      user: { isServiceAccount: true },
      body: { name: 'Fee', amount: 10 }, // no author/ticket
      maxLine: 2000
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /author is required/);
  }
});

// ---------------------------------------------------------------------------
// resolveVoziaCeiling (generalized resolver)
// ---------------------------------------------------------------------------
test('resolveVoziaCeiling: default, bare number, JSON, bad value, read failure, key shape', async () => {
  const fake = (value) => ({ appSetting: { async findUnique() { return value === undefined ? null : { value }; } } });
  assert.equal(await resolveVoziaCeiling('t1', 'voziaMaxRefundAmount', 2000, { prisma: fake(undefined) }), 2000);
  assert.equal(await resolveVoziaCeiling('t1', 'voziaMaxRefundAmount', 2000, { prisma: fake('7500') }), 7500);
  assert.equal(await resolveVoziaCeiling('t1', 'voziaMaxRefundAmount', 2000, { prisma: fake(JSON.stringify(3000)) }), 3000);
  assert.equal(await resolveVoziaCeiling('t1', 'voziaMaxRefundAmount', 2000, { prisma: fake('nope') }), 2000);
  assert.equal(await resolveVoziaCeiling('t1', 'voziaMaxRefundAmount', 2000, { prisma: fake('-10') }), 2000);
  // read failure → conservative default, never throws.
  const boom = { appSetting: { async findUnique() { throw new Error('db down'); } } };
  assert.equal(await resolveVoziaCeiling('t1', 'voziaMaxChargeLineAmount', 2000, { prisma: boom }), 2000);
  // default fallback is DEFAULT_VOZIA_CEILING when defaultAmt omitted.
  assert.equal(await resolveVoziaCeiling('t1', 'voziaMaxRefundAmount', undefined, { prisma: fake(undefined) }), DEFAULT_VOZIA_CEILING);

  // Uses the tenant-scoped key; falls back to bare key when tenantId is null.
  let seenKey = null;
  const spy = { appSetting: { async findUnique({ where }) { seenKey = where.key; return { value: '4200' }; } } };
  assert.equal(await resolveVoziaCeiling('t1', 'voziaMaxRefundAmount', 2000, { prisma: spy }), 4200);
  assert.equal(seenKey, 'tenant:t1:voziaMaxRefundAmount');
  await resolveVoziaCeiling(null, 'voziaMaxRefundAmount', 2000, { prisma: spy });
  assert.equal(seenKey, 'voziaMaxRefundAmount');
});
