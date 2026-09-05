import test from 'node:test';
import assert from 'node:assert/strict';
import { findProof, pointsFor, standing, parseArmStamp, canCompleteByWalkthrough, PROOF_SHAPE, VERIFY_TYPES } from './training-verify.js';

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

test('the arm stamp round-trips, and an empty verify type is preserved', () => {
  assert.deepEqual(parseArmStamp('pending:RESERVATION_CREATED:20'), { armed: true, verifyType: 'RESERVATION_CREATED', points: 20 });
  assert.deepEqual(parseArmStamp('pending::5'), { armed: true, verifyType: null, points: 5 });
  assert.equal(parseArmStamp(null).armed, false);
  assert.equal(parseArmStamp('walkthrough').armed, false);
  assert.equal(parseArmStamp('some-record-id').armed, false);
});

test('walking a guide completes a module with nothing to prove', () => {
  assert.equal(canCompleteByWalkthrough({ status: 'ARMED', provenBy: 'pending::5' }), true);
});

test('finishing the guide completes a module even when it has a verify rule', () => {
  // Reversed on 2026-08-17 (Hector). Holding a trainee's progress until a real
  // customer happened to appear left three of the four hands-on modules armed
  // indefinitely, which taught nothing. The verify rule is now the OTHER route
  // in — whichever comes first wins — not a gate on the guide.
  for (const type of VERIFY_TYPES) {
    assert.equal(
      canCompleteByWalkthrough({ status: 'ARMED', provenBy: `pending:${type}:20` }),
      true,
      `${type} should complete when the walkthrough is finished`
    );
  }
});

test('what the stamp still guarantees: armed first, and only once', () => {
  // The boundary that survives — a module cannot be completed by a stray call
  // on a row that was never armed, nor completed twice.
  assert.equal(canCompleteByWalkthrough({ status: 'ARMED', provenBy: 'garbage' }), false);
  assert.equal(canCompleteByWalkthrough({ status: 'ARMED', provenBy: '' }), false);
  assert.equal(canCompleteByWalkthrough({ status: 'COMPLETED', provenBy: 'pending:RESERVATION_CREATED:20' }), false);
});

test('an already-completed or unstamped module is not completable again', () => {
  assert.equal(canCompleteByWalkthrough({ status: 'COMPLETED', provenBy: 'pending::5' }), false);
  assert.equal(canCompleteByWalkthrough({ status: 'ARMED', provenBy: null }), false);
  assert.equal(canCompleteByWalkthrough(null), false);
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

/* ───── Ride University · kiosk course (2026-09-04) ───── */

test('kiosk: an IN-PERSON staff verify after arming proves KIOSK_ASSISTED', () => {
  const armedAt = new Date('2026-09-04T10:00:00Z');
  const out = findProof({
    verifyType: 'KIOSK_ASSISTED', userId: 'u1', armedAt,
    records: [{ id: 'ks1', assistUserId: 'u1', idVerifiedAt: '2026-09-04T10:30:00Z', idVerifyMethod: 'STAFF_OVERRIDE' }],
  });
  assert.equal(out.proved, true);
  assert.equal(out.provenBy, 'ks1');
});

test('kiosk: vouching for the NAME in person counts too — it is the other in-person method', () => {
  const out = findProof({
    verifyType: 'KIOSK_ASSISTED', userId: 'u1', armedAt: new Date('2026-09-04T10:00:00Z'),
    records: [{ id: 'ks2', assistUserId: 'u1', idVerifiedAt: '2026-09-04T10:30:00Z', idVerifyMethod: 'STAFF_NAME_OVERRIDE' }],
  });
  assert.equal(out.proved, true);
});

test('kiosk: a REMOTE override never proves the in-person module, even with the same actor', () => {
  // In production the remote actor is the Valet service account anyway; this
  // pins that the METHOD is what decides, not the actor column alone.
  for (const method of ['REMOTE_AGENT_OVERRIDE', 'REMOTE_AGENT_NAME_OVERRIDE', 'SCAN', 'SCAN_NAME_UPDATED', null]) {
    const out = findProof({
      verifyType: 'KIOSK_ASSISTED', userId: 'u1', armedAt: new Date('2026-09-04T10:00:00Z'),
      records: [{ id: 'ks3', assistUserId: 'u1', idVerifiedAt: '2026-09-04T10:30:00Z', idVerifyMethod: method }],
    });
    assert.equal(out.proved, false, `method ${method} must not prove it`);
  }
});

test('kiosk: a verify that predates arming, or a grant that was never consumed, proves nothing', () => {
  const armedAt = new Date('2026-09-04T10:00:00Z');
  assert.equal(findProof({
    verifyType: 'KIOSK_ASSISTED', userId: 'u1', armedAt,
    records: [{ id: 'old', assistUserId: 'u1', idVerifiedAt: '2026-09-04T09:00:00Z', idVerifyMethod: 'STAFF_OVERRIDE' }],
  }).proved, false, 'before arming');
  assert.equal(findProof({
    verifyType: 'KIOSK_ASSISTED', userId: 'u1', armedAt,
    // unlocked, never verified: no idVerifiedAt
    records: [{ id: 'open', assistUserId: 'u1', idVerifiedAt: null, idVerifyMethod: null, assistGrantedAt: '2026-09-04T10:30:00Z' }],
  }).proved, false, 'a grant is not a verify');
});

test('kiosk admin: granting the kiosk module to a user proves KIOSK_ACCESS_GRANTED', () => {
  const out = findProof({
    verifyType: 'KIOSK_ACCESS_GRANTED', userId: 'admin1', armedAt: new Date('2026-09-04T10:00:00Z'),
    records: [{ id: 'mal1', scope: 'USER', actorUserId: 'admin1', changedAt: '2026-09-04T10:05:00Z', changed: [{ module: 'tolls', from: true, to: false }, { module: 'kiosk', from: false, to: true }] }],
  });
  assert.equal(out.proved, true);
  assert.equal(out.provenBy, 'mal1');
});

test('kiosk admin: REVOKING kiosk, or changing some other module, does not count', () => {
  const armedAt = new Date('2026-09-04T10:00:00Z');
  assert.equal(findProof({
    verifyType: 'KIOSK_ACCESS_GRANTED', userId: 'admin1', armedAt,
    records: [{ id: 'x', scope: 'USER', actorUserId: 'admin1', changedAt: '2026-09-04T10:05:00Z', changed: [{ module: 'kiosk', from: true, to: false }] }],
  }).proved, false, 'revoke');
  assert.equal(findProof({
    verifyType: 'KIOSK_ACCESS_GRANTED', userId: 'admin1', armedAt,
    records: [{ id: 'y', scope: 'USER', actorUserId: 'admin1', changedAt: '2026-09-04T10:05:00Z', changed: [{ module: 'tolls', from: false, to: true }] }],
  }).proved, false, 'other module');
  assert.equal(findProof({
    verifyType: 'KIOSK_ACCESS_GRANTED', userId: 'admin1', armedAt,
    records: [{ id: 'z', scope: 'USER', actorUserId: 'admin1', changedAt: '2026-09-04T10:05:00Z', changed: null }],
  }).proved, false, 'malformed changed');
});

test('kiosk admin: the TENANT-wide switch in Settings is a different module — it does not prove the People one', () => {
  const out = findProof({
    verifyType: 'KIOSK_ACCESS_GRANTED', userId: 'admin1', armedAt: new Date('2026-09-04T10:00:00Z'),
    records: [{ id: 't1', scope: 'TENANT', targetUserId: null, actorUserId: 'admin1', changedAt: '2026-09-04T10:05:00Z', changed: [{ module: 'kiosk', from: false, to: true }] }],
  });
  assert.equal(out.proved, false);
});
