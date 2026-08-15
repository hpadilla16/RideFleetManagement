import test from 'node:test';
import assert from 'node:assert/strict';
import { findProof, pointsFor, standing, PROOF_SHAPE, VERIFY_TYPES } from './training-verify.js';

const ARMED = '2026-08-14T12:00:00.000Z';
const AFTER = '2026-08-14T15:00:00.000Z';
const BEFORE = '2026-08-13T09:00:00.000Z';
const ME = 'user-1';

test('every verify type has exactly one proof shape', () => {
  for (const t of VERIFY_TYPES) {
    assert.ok(PROOF_SHAPE[t], `${t} has no proof shape`);
    assert.ok(PROOF_SHAPE[t].actorField && PROOF_SHAPE[t].atField, `${t} incomplete`);
  }
  assert.equal(Object.keys(PROOF_SHAPE).length, VERIFY_TYPES.length);
});

test('a reservation this person created after arming proves it', () => {
  const out = findProof({
    verifyType: 'RESERVATION_CREATED',
    records: [{ id: 'r1', createdByUserId: ME, createdAt: AFTER }],
    userId: ME, armedAt: ARMED,
  });
  assert.equal(out.proved, true);
  assert.equal(out.provenBy, 'r1');
});

test("someone else's work never proves my module", () => {
  const out = findProof({
    verifyType: 'RESERVATION_CREATED',
    records: [{ id: 'r1', createdByUserId: 'someone-else', createdAt: AFTER }],
    userId: ME, armedAt: ARMED,
  });
  assert.equal(out.proved, false);
});

test('work done BEFORE arming does not count', () => {
  // Otherwise a new hire completes half the curriculum on first login, for
  // work the previous holder of that account did.
  const out = findProof({
    verifyType: 'RESERVATION_CREATED',
    records: [{ id: 'old', createdByUserId: ME, createdAt: BEFORE }],
    userId: ME, armedAt: ARMED,
  });
  assert.equal(out.proved, false);
});

test('it finds the qualifying record among several', () => {
  const out = findProof({
    verifyType: 'RESERVATION_CREATED',
    records: [
      { id: 'old', createdByUserId: ME, createdAt: BEFORE },
      { id: 'theirs', createdByUserId: 'other', createdAt: AFTER },
      { id: 'mine', createdByUserId: ME, createdAt: AFTER },
    ],
    userId: ME, armedAt: ARMED,
  });
  assert.equal(out.provenBy, 'mine');
});

test('an unfinished checkout session proves nothing', () => {
  // startedByUserId is set the moment the wizard opens; finishedAt is what
  // says the handover actually happened.
  const out = findProof({
    verifyType: 'RESERVATION_CHECKED_OUT',
    records: [{ id: 'cs1', startedByUserId: ME, finishedAt: null }],
    userId: ME, armedAt: ARMED,
  });
  assert.equal(out.proved, false);
});

test('a finished checkout session proves it', () => {
  const out = findProof({
    verifyType: 'RESERVATION_CHECKED_OUT',
    records: [{ id: 'cs1', startedByUserId: ME, finishedAt: AFTER }],
    userId: ME, armedAt: ARMED,
  });
  assert.equal(out.proved, true);
});

test('check-in reads the agreement, not a reservation status', () => {
  // The status route is exactly what made the audit trail wrong: a check-in
  // leaving a balance lands on CHECKED_IN_UNPAID and would be missed.
  const out = findProof({
    verifyType: 'RESERVATION_CHECKED_IN',
    records: [{ id: 'ag1', closedByUserId: ME, closedAt: AFTER }],
    userId: ME, armedAt: ARMED,
  });
  assert.equal(out.proved, true);
  assert.equal(out.provenBy, 'ag1');
});

test('a payment proves the payment module — and nothing else', () => {
  const payment = { id: 'p1', recordedByUserId: ME, paidAt: AFTER };
  assert.equal(findProof({ verifyType: 'PAYMENT_RECORDED', records: [payment], userId: ME, armedAt: ARMED }).proved, true);
  // The old audit-based design completed CHECK-IN here, because settling a
  // balance writes a CHECKED_IN status change naming the payer.
  assert.equal(findProof({ verifyType: 'RESERVATION_CHECKED_IN', records: [payment], userId: ME, armedAt: ARMED }).proved, false);
});

test('missing inputs are answered, not thrown', () => {
  assert.equal(findProof({ verifyType: 'NOPE', records: [], userId: ME, armedAt: ARMED }).proved, false);
  assert.equal(findProof({ verifyType: 'RESERVATION_CREATED', records: [], userId: null, armedAt: ARMED }).proved, false);
  assert.equal(findProof({ verifyType: 'RESERVATION_CREATED', records: [null], userId: ME, armedAt: ARMED }).proved, false);
  assert.equal(findProof({ verifyType: 'RESERVATION_CREATED', records: [{ id: 'x', createdByUserId: ME }], userId: ME, armedAt: ARMED }).proved, false);
  assert.equal(findProof({ verifyType: 'RESERVATION_CREATED', records: [], userId: ME, armedAt: null }).proved, false);
});

test('points are whole and never negative', () => {
  assert.equal(pointsFor({ points: 20 }), 20);
  assert.equal(pointsFor({ points: 0 }), 0);
  assert.equal(pointsFor({ points: -5 }), 0);
  assert.equal(pointsFor({}), 0);
  assert.equal(pointsFor(null), 0);
});

test('standing reports a percentage of what is available to THAT person', () => {
  // Raw points are not comparable across roles — an agent's whole curriculum
  // is worth less than an admin's — so the percentage is the fair number.
  const s = standing([
    { status: 'COMPLETED', pointsAwarded: 20 },
    { status: 'COMPLETED', pointsAwarded: 30 },
    { status: 'ARMED', pointsAwarded: 0 },
  ], 105);
  assert.equal(s.completedCount, 2);
  assert.equal(s.armedCount, 1);
  assert.equal(s.pointsEarned, 50);
  assert.equal(s.percent, 48);
});

test('standing never exceeds 100 even if a module was re-weighted downward', () => {
  const s = standing([{ status: 'COMPLETED', pointsAwarded: 200 }], 105);
  assert.equal(s.percent, 100);
});

test('standing with nothing available does not divide by zero', () => {
  assert.equal(standing([], 0).percent, 0);
  assert.equal(standing(null, 50).percent, 0);
});
