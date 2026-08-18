/**
 * The finalize tells the truth (2026-08-17). DB-free — see
 * checkout-session.test-harness.mjs. Run: npm run test:checkout-finalize-truth
 *
 * One ticket, because QA measured it as one behaviour: a checkout close that
 * fails, fails SILENTLY, and mails the customer the contract anyway. The probe
 * that found it, on a legitimate finalize hitting the double-booking guard:
 *
 *   WINNER + vehicle conflict: {"thrown":{"status":409,"code":"VEHICLE_CONFLICT"},
 *    "emailsSent":1,"sessionStep":"CLOSED","reservation":"CONFIRMED",
 *    "agreement":"DRAFT","vehicle":"AVAILABLE"}
 *
 * Read that tuple as a story: the agent sees the finished-checkout screen, the
 * customer gets a contract, the car is still bookable, and nobody was told.
 * Three independent defects produced it, so each gets its own section and its
 * own test — revert any one fix and exactly that section goes red:
 *
 *   §1  the web wizard swallowed the winner path's 409. All three cascade
 *       guards raise AFTER transition() has committed the step, so the
 *       wizard's `at >= want` swallow rule matched by construction.
 *   §2  the customer email fired BEFORE the cascade's guards, so a finalize
 *       that died on any of them had already mailed a DRAFT contract.
 *   §3  scheduleEmailDelivery was called with no await and no .catch. Its
 *       "Customer email is required" rejection had no owner and took the
 *       process down — it is what killed the QA probe.
 *
 * §4 then re-runs the probe end to end and pins the whole tuple.
 *
 * Every "no email was sent" assertion here is made with a SPY on
 * scheduleEmailDelivery, not by reading the autoEmailedAt stamp. QA's finding
 * on the H8 suite is why: a fixture that pre-stamped autoEmailedAt made
 * maybeSendFinalizeEmail return at its first line, which left a test named
 * "zero writes to the world" structurally unable to see the email path at all.
 * A spy cannot be satisfied that way, and §2's happy-path case asserts the spy
 * DOES fire — without it, every other email assertion here would be vacuous.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { CheckoutSessionError } from './checkout-session.service.js';
import { rentalAgreementsService } from '../rental-agreements/rental-agreements.service.js';
import {
  installWorld, restoreWorld, onRestore, seedFinalizeWorld, viaWebWizard,
} from './checkout-session.test-harness.mjs';

let db;
beforeEach(() => { db = installWorld(); });
afterEach(restoreWorld);

/**
 * Replaces the real sender. Each call records the state of the world AT SEND
 * TIME, because "was it sent" and "was it sent over a half-finished finalize"
 * are different questions and only the second one is the ticket.
 */
function spyOnFinalizeEmail({ rejectWith = null } = {}) {
  const calls = [];
  const orig = rentalAgreementsService.scheduleEmailDelivery;
  rentalAgreementsService.scheduleEmailDelivery = (agreementId, payload, actorUserId, tenantId) => {
    calls.push({
      agreementId,
      actorUserId,
      tenantId,
      agreementStatus: db.agreements.find((a) => a.id === agreementId)?.status ?? null,
      reservationStatus: db.reservations[0]?.status ?? null,
      vehicleStatus: db.vehicles[0]?.status ?? null,
    });
    return rejectWith ? Promise.reject(rejectWith) : Promise.resolve({ ok: true, queued: true });
  };
  onRestore(() => { rentalAgreementsService.scheduleEmailDelivery = orig; });
  return calls;
}

/**
 * The email arm is deliberately fire-and-forget, so the transition resolves
 * before it runs. Drain enough turns for the dynamic import + the CAS stamp +
 * the send to have happened — and, in §3, for Node to have decided whether a
 * rejection was unhandled.
 */
async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
}

/** Another rental is physically out on the same car. */
function doubleBookTheVehicle() {
  db.reservations.push({
    id: 'res2', tenantId: 't1', status: 'CHECKED_OUT', vehicleId: 'veh1',
    reservationNumber: 'R-2',
    pickupAt: new Date('2026-08-16T10:00:00Z'), returnAt: new Date('2026-08-19T10:00:00Z'),
  });
}

async function rejection(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return assert.fail('expected the finalize to reject');
}

// ── §1. the winner path's failure is visible ───────────────────────────────

test('§1 WINNER + double-booked vehicle: raised as FINALIZE_INCOMPLETE, not a swallowable VEHICLE_CONFLICT', async () => {
  const row = seedFinalizeWorld();
  doubleBookTheVehicle();
  spyOnFinalizeEmail();

  const err = await rejection(() => viaWebWizard({ id: 'cs1', toStep: 'CLOSED' }));

  assert.ok(err instanceof CheckoutSessionError);
  assert.equal(err.status, 409);
  // The whole §1 defect in one assertion. `VEHICLE_CONFLICT` is what this used
  // to be, and the wizard swallows it: the code arrives on a session that is
  // already CLOSED (asserted below), so its `at >= want` test passes by
  // construction and the agent is shown the finished-checkout screen.
  assert.equal(err.code, 'FINALIZE_INCOMPLETE');
  // Folding four guard failures into one code would lose the reason, so the
  // reason travels separately — machine-readable for RideOps, prose for the
  // agent at the counter.
  assert.equal(err.reason, 'VEHICLE_CONFLICT');
  assert.match(err.message, /Checkout is closed but its finalize did not complete/);
  assert.match(err.message, /still out on open rental R-2/);

  // Why the code has to carry it: the step really did commit. This is not
  // "your transition failed", it is "your transition landed and the work
  // behind it did not".
  assert.equal(row.currentStep, 'CLOSED', 'the step committed before the cascade ran');
  assert.equal(db.reservations[0].status, 'CONFIRMED', 'the rental was never handed over');
  assert.equal(db.agreements[0].status, 'DRAFT', 'the contract was never finalized');
  assert.equal(db.vehicles[0].status, 'AVAILABLE', 'and the car is still bookable');
});

test('§1 the same state reached by the SELF-HEAL path reports the same code', async () => {
  // H8 already labelled this path FINALIZE_INCOMPLETE; the winner path above
  // now joins it. Pinned together because the point is that ONE observable
  // state has ONE code — a client should not have to know which surface lost
  // a race to understand what it is looking at.
  const row = seedFinalizeWorld({ autoEmailedAt: new Date() });
  row.currentStep = 'CLOSED';
  row.finishedAt = new Date('2026-08-16T12:00:00Z');
  doubleBookTheVehicle();

  const err = await rejection(() => viaWebWizard({ id: 'cs1', toStep: 'CLOSED' }));

  assert.equal(err.code, 'FINALIZE_INCOMPLETE');
  assert.equal(err.reason, 'VEHICLE_CONFLICT');
});

// ── §2. the email is downstream of the guards ──────────────────────────────

test('§2 a finalize that dies on NO_VEHICLE_ASSIGNED mails nothing', async () => {
  const row = seedFinalizeWorld();
  db.reservations[0].vehicleId = null; // the car was unassigned mid-wizard
  const calls = spyOnFinalizeEmail();

  const err = await rejection(() => viaWebWizard({ id: 'cs1', toStep: 'CLOSED' }));
  await settle();

  // Asserted on the MESSAGE, not the code: §1 is what turns this into a
  // FINALIZE_INCOMPLETE, and this test has to be able to fail on its own.
  assert.match(err.message, /no vehicle is assigned/i);
  assert.deepEqual(calls, [], 'no contract went out for a rental with no car on it');
  assert.equal(row.autoEmailedAt, null, 'and the row does not claim one did');
});

test('§2 a cascade failure the service DOWNGRADES to a warning still stops the email', async () => {
  // The sharpest case, because this one does not throw to the caller at all:
  // anything that is not a CheckoutSessionError or a 409 is caught, logged at
  // warn, and the transition answers 200. That is exactly the half-finished
  // finalize H8's self-heal exists to repair — and the old ordering had
  // already mailed its DRAFT contract by the time the failure happened.
  const row = seedFinalizeWorld();
  const calls = spyOnFinalizeEmail();

  let breakCascade = true;
  const origUpdate = prisma.reservation.update;
  prisma.reservation.update = async (args) => {
    if (breakCascade) throw new Error('injected half-way cascade failure');
    return origUpdate(args);
  };
  onRestore(() => { prisma.reservation.update = origUpdate; });

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();

  assert.equal(out.currentStep, 'CLOSED', 'the caller got its 200...');
  assert.equal(db.agreements[0].status, 'DRAFT', '...over a contract still in DRAFT');
  assert.deepEqual(calls, [], 'which is precisely what must not be mailed');
  assert.equal(row.autoEmailedAt, null);

  // ...and when the self-heal finishes the job, the mail goes then. The stamp
  // is still null, so nothing was consumed by the failed attempt.
  breakCascade = false;
  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();

  assert.equal(db.reservations[0].status, 'CHECKED_OUT', 'self-healed');
  assert.equal(calls.length, 1, 'exactly one contract, sent once the finalize was real');
  assert.equal(calls[0].agreementStatus, 'FINALIZED');
  assert.ok(row.autoEmailedAt instanceof Date);
});

test('§2 a FINALIZED write that fails silently still stops the email', async () => {
  // Innovation caught this one on review, and it is the ticket's own tuple
  // reached through a different door: the rentalAgreement.update that turns a
  // DRAFT into the legal document is wrapped in a swallow, so the cascade used
  // to sail past its failure, mark the car ON_RENT, and mail the customer a
  // contract that is still DRAFT. Nothing throws here — the caller gets 200 —
  // so only the email guard can catch it.
  const row = seedFinalizeWorld();
  const calls = spyOnFinalizeEmail();

  const origUpdate = prisma.rentalAgreement.update;
  prisma.rentalAgreement.update = async () => { throw new Error('injected agreement write failure'); };
  onRestore(() => { prisma.rentalAgreement.update = origUpdate; });

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();

  assert.equal(out.currentStep, 'CLOSED', 'the caller still gets its 200');
  assert.equal(db.reservations[0].status, 'CHECKED_OUT', 'and the rest of the cascade still ran');
  assert.equal(db.agreements[0].status, 'DRAFT', 'but the contract never became the legal document');
  assert.deepEqual(calls, [], 'so no contract left the building');
  assert.equal(row.autoEmailedAt, null);
});

test('§2 the happy path still mails — and mails a FINALIZED contract', async () => {
  // The anti-vacuity test for this whole file: if the spy could not observe a
  // send, every `deepEqual(calls, [])` above would pass for the wrong reason.
  // It also pins the ordering benefit — the PDF now renders after the cascade
  // wrote FINALIZED and copied the odometer/fuel onto the agreement, instead
  // of racing it.
  const row = seedFinalizeWorld();
  const calls = spyOnFinalizeEmail();

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  // Before settling: the arm is fire-and-forget by design, and it has to STAY
  // that way. An `await` added here would look harmless and every other
  // assertion in this file would still pass, while a slow Puppeteer render
  // started blocking the counter's transition response.
  assert.equal(calls.length, 0, 'the transition did not wait on the mailer');
  await settle();

  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(calls.length, 1, 'the customer gets their copy');
  assert.equal(calls[0].agreementId, 'ra1');
  assert.equal(calls[0].tenantId, 't1');
  assert.equal(calls[0].agreementStatus, 'FINALIZED', 'not the DRAFT it used to mail');
  assert.equal(calls[0].reservationStatus, 'CHECKED_OUT');
  assert.equal(calls[0].vehicleStatus, 'ON_RENT');
  assert.ok(row.autoEmailedAt instanceof Date);

  // Still exactly once: the autoEmailedAt CAS is untouched by the reordering.
  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();
  assert.equal(calls.length, 1, 'a repeat POST does not mail a second contract');
});

// ── §3. the send's rejection has an owner ──────────────────────────────────

test('§3 a send that rejects is caught, not left unhandled', async () => {
  // "Customer email is required" is an ordinary state — a walk-up customer
  // with no email on file — and scheduleEmailDelivery reports it by REJECTING
  // the promise it returns. Detached, that rejection reached nobody: the
  // caller's `.catch` covers only the chain it builds. Under Node's default
  // `--unhandled-rejections=throw` it ends the process, which is how it killed
  // the QA probe rather than showing up as a failed assertion.
  const row = seedFinalizeWorld();
  const calls = spyOnFinalizeEmail({ rejectWith: new Error('Customer email is required') });

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  onRestore(() => { process.off('unhandledRejection', onUnhandled); });

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();

  assert.equal(calls.length, 1, 'the send was attempted');
  assert.deepEqual(
    unhandled.map((e) => e?.message),
    [],
    'and its rejection was owned by the caller, not by the process',
  );

  // A customer we cannot email must not cost us the checkout: the finalize
  // itself still completed, and the failure is a log line.
  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(db.reservations[0].status, 'CHECKED_OUT');
  assert.equal(db.agreements[0].status, 'FINALIZED');
  assert.equal(db.vehicles[0].status, 'ON_RENT');
  // KNOWN GAP, not a desired property: autoEmailedAt is stamped BEFORE the send
  // and is not rolled back when the send rejects, so this row now claims a
  // contract was mailed that never was — and the kiosk DONE screen shows that
  // claim to the customer (kiosk-checkout.service.js:1076 `contractEmail.sent`).
  // Left out of this ticket deliberately: the compensating un-stamp is safe but
  // it is a different defect with a different customer-facing surface. Asserted
  // here so the behaviour is DOCUMENTED rather than discovered, and so the day
  // someone fixes it, this line points at what else to check.
  assert.ok(row.autoEmailedAt instanceof Date, 'KNOWN GAP: the stamp is not rolled back');
});

// ── §4. the probe QA ran, as one assertion ─────────────────────────────────

test('§4 QA probe: WINNER + vehicle conflict, the whole tuple', async () => {
  const row = seedFinalizeWorld();
  doubleBookTheVehicle();
  const calls = spyOnFinalizeEmail();

  const err = await rejection(() => viaWebWizard({ id: 'cs1', toStep: 'CLOSED' }));
  await settle();

  // Same shape QA printed, so the before/after is readable side by side.
  // Before: {"thrown":{"status":409,"code":"VEHICLE_CONFLICT"},"emailsSent":1,…}
  assert.deepEqual({
    thrown: { status: err.status, code: err.code, reason: err.reason },
    emailsSent: calls.length,
    sessionStep: row.currentStep,
    reservation: db.reservations[0].status,
    agreement: db.agreements[0].status,
    vehicle: db.vehicles[0].status,
  }, {
    thrown: { status: 409, code: 'FINALIZE_INCOMPLETE', reason: 'VEHICLE_CONFLICT' },
    emailsSent: 0,
    // The last four are UNCHANGED by this ticket and that is the point: the
    // finalize genuinely did not happen. What changed is that the agent is now
    // told so, and the customer is not handed a contract for it.
    sessionStep: 'CLOSED',
    reservation: 'CONFIRMED',
    agreement: 'DRAFT',
    vehicle: 'AVAILABLE',
  });
});
