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
 * §5 (2026-08-18) is the same tuple through a third door, reported by QA as
 *     MINOR 3: the cascade's benign short-circuit INFERRED "the contract is
 *     FINALIZED" from reservation.status alone, so a CHECKED_OUT reservation
 *     whose agreement was still DRAFT released the email anyway. It now reads
 *     the contract, and repairs that strand instead of reporting success over
 *     it — see checkout-cas-transition.test.mjs §8b for the repair itself.
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
  installWorld, restoreWorld, onRestore, seedFinalizeWorld, seedStrandedStrand,
  viaWebWizard, armReservationRace, viaKiosk,
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

  // Injected on updateMany, not update: since 2026-08-18 the cascade CLAIMS
  // the reservation (updateMany guarded by the status it read) instead of
  // updating it blind, so a patch left on the old method breaks nothing and
  // every assertion below would quietly be describing a cascade that worked.
  let breakCascade = true;
  const origUpdateMany = prisma.reservation.updateMany;
  prisma.reservation.updateMany = async (args) => {
    if (breakCascade) throw new Error('injected half-way cascade failure');
    return origUpdateMany(args);
  };
  onRestore(() => { prisma.reservation.updateMany = origUpdateMany; });

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

  // Injected on updateMany, not update: since 2026-08-18 the flip that turns
  // the DRAFT into the legal document is an updateMany CAS'd on DRAFT, so a
  // patch left on the old method breaks nothing and every assertion below
  // would quietly be describing an agreement write that succeeded. Same trap
  // the reservation claim left on this file's sibling above.
  const origUpdateMany = prisma.rentalAgreement.updateMany;
  prisma.rentalAgreement.updateMany = async () => { throw new Error('injected agreement write failure'); };
  onRestore(() => { prisma.rentalAgreement.updateMany = origUpdateMany; });

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

test('§2 the loser of the reservation claim does not mail a second contract', async () => {
  // The claim (2026-08-18) gave the cascade a second exit, and this one leaves
  // `finalizeCascadeOk` false on purpose: at the instant the claim is lost the
  // winner has claimed the row, not finished with it, so the loser cannot
  // assert the contract reached FINALIZED. The email arm is LIVE here
  // (autoEmailedAt null) — with a stamp seeded, maybeSendFinalizeEmail returns
  // at its first line and this would assert nothing.
  //
  // Honest about what it pins: this does NOT isolate `finalizeCascadeOk`.
  // Defeat the claim and the count stays 1, because the autoEmailedAt CAS
  // inside maybeSendFinalizeEmail independently refuses the second send — the
  // two guards overlap here by design. What it does pin is the end-to-end
  // property under a claim race, which nothing else covered: exactly one
  // contract leaves, and it is FINALIZED when it does.
  seedFinalizeWorld();
  const calls = spyOnFinalizeEmail();

  const raced = armReservationRace('CONFIRMED', async () => {
    await viaKiosk({ id: 'cs1', toStep: 'CLOSED' });
  });

  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  assert.equal(raced(), true, 'the race actually fired');
  await settle();

  // The winner mailed. The loser reached the email arm with finalizeCascadeOk
  // false and stopped — and the autoEmailedAt CAS is not what saved it here.
  assert.equal(calls.length, 1, 'exactly one contract, sent by the winner');
  assert.equal(calls[0].agreementStatus, 'FINALIZED', 'and it was FINALIZED when it went');
  assert.equal(db.reservations[0].status, 'CHECKED_OUT');
  assert.ok(db.checkoutSessions[0].autoEmailedAt instanceof Date);
});

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

// ── §5. the short-circuit stops inferring the contract (QA MINOR 3) ────────
//
// The cascade has a benign-looking exit for a finalize that lands on a
// reservation already CHECKED_OUT — "no work to do, the world already
// matches" — and it used to be one line: `finalizeCascadeOk = true`. That is
// the email gate, and it was being set from `reservation.status` alone. The
// reservation status is evidence about the RESERVATION. The only evidence
// about the contract is the contract, and the two come apart in exactly the
// state a broken finalize leaves behind: CHECKED_OUT, agreement still DRAFT.
//
// So the winner path could release the customer email over a contract that
// never reached FINALIZED — the ticket's own tuple, through a third door.
// Pre-existing at base, and reported by QA as MINOR 3 rather than a blocker
// because reaching it needs a session whose autoEmailedAt is still null.

test('§5 WINNER: a DRAFT contract behind a CHECKED_OUT reservation is not mailed as if it were finalized', async () => {
  // The WINNER path specifically, which is where MINOR 3 was reachable at
  // base. Note what is NOT set here: the session is still FINALIZING, so this
  // request commits the step itself and `alreadyApplied` is false — which
  // makes `finalizeOwnsReservation` true without consulting the self-heal
  // allow-list at all. The reservation is already CHECKED_OUT (another surface
  // put it there), so the cascade takes the short-circuit, and at base that
  // one line set the email gate to true over a contract still in DRAFT.
  //
  // Drive it through the self-heal instead and this proves nothing: at base
  // the ownership allow-list excluded CHECKED_OUT and stopped the email one
  // guard earlier, for an unrelated reason.
  seedFinalizeWorld({ reservationStatus: 'CHECKED_OUT' });
  const calls = spyOnFinalizeEmail();

  // The repair is what this path does now, so to isolate the GATE the repair
  // has to fail. Without the verification, `finalizeCascadeOk` would be true
  // on the reservation status alone and the DRAFT would go out regardless.
  const origFlip = prisma.rentalAgreement.updateMany;
  prisma.rentalAgreement.updateMany = async () => { throw new Error('injected agreement write failure'); };
  onRestore(() => { prisma.rentalAgreement.updateMany = origFlip; });

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();

  assert.equal(out.currentStep, 'CLOSED', 'the step still commits');
  assert.equal(db.reservations[0].status, 'CHECKED_OUT', 'the reservation says the car went out...');
  assert.equal(db.agreements[0].status, 'DRAFT', '...and the contract says it never became one');
  assert.deepEqual(calls, [], 'the second fact wins — nothing was mailed');
  assert.equal(db.checkoutSessions[0].autoEmailedAt, null, 'and the row does not claim otherwise');
});

test('§5 SELF-HEAL: the widened allow-list did not hand that email back through the other door', async () => {
  // Same end state, reached by a repeat POST on an already-CLOSED session.
  // At base this was stopped by the ownership allow-list, which excluded
  // CHECKED_OUT — an accident of a guard aimed at something else. Widening
  // that list to make the repair reachable removed the accident, so the
  // verification above is now the only thing standing here. Pinned separately
  // for exactly that reason.
  seedStrandedStrand();
  const calls = spyOnFinalizeEmail();

  const origFlip = prisma.rentalAgreement.updateMany;
  prisma.rentalAgreement.updateMany = async () => { throw new Error('injected agreement write failure'); };
  onRestore(() => { prisma.rentalAgreement.updateMany = origFlip; });

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();

  assert.equal(out.currentStep, 'CLOSED', 'the caller is still answered idempotently');
  assert.equal(db.agreements[0].status, 'DRAFT');
  assert.deepEqual(calls, [], 'nothing was mailed');
  assert.equal(db.checkoutSessions[0].autoEmailedAt, null);
});

test('§5 the repaired strand DOES mail — once, and a FINALIZED contract', async () => {
  // The anti-vacuity partner. If the repair could not mail, the assertion
  // above would pass for the wrong reason, and the failure card's "Reintentar
  // cierre" would still be leaving the customer without their copy.
  const row = seedStrandedStrand();
  const calls = spyOnFinalizeEmail();

  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();

  assert.equal(db.agreements[0].status, 'FINALIZED');
  assert.equal(calls.length, 1, 'the customer finally gets their copy');
  assert.equal(calls[0].agreementStatus, 'FINALIZED', 'and it was FINALIZED when it went');
  assert.equal(calls[0].vehicleStatus, 'ON_RENT');
  assert.ok(row.autoEmailedAt instanceof Date);

  // Pressing the button again does not mail a second one.
  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();
  assert.equal(calls.length, 1);
});

test('§5 an already-finalized CHECKED_OUT reservation still takes the benign exit', async () => {
  // The case the old one-liner was actually written for. It has to keep
  // working — the verification replaced an assumption with a read, it did not
  // replace "no work to do" with "fail closed".
  const row = seedStrandedStrand();
  const finalizedAt = new Date('2026-08-17T12:30:00Z');
  db.agreements[0].status = 'FINALIZED';
  db.agreements[0].finalizedAt = finalizedAt;
  const calls = spyOnFinalizeEmail();

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();

  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(db.agreements[0].finalizedAt, finalizedAt, 'finalizedAt was not rewritten');
  assert.equal(db.mileageEntries.length, 0, 'and no mileage row was appended');
  // autoEmailedAt was null on this fixture, so the send is a genuine outcome
  // of the gate rather than the CAS declining underneath it.
  assert.equal(calls.length, 1, 'a finalized contract that was never mailed still gets mailed');
  assert.equal(calls[0].agreementStatus, 'FINALIZED');
  assert.ok(row.autoEmailedAt instanceof Date);
});

test('§5 a contract that is CANCELLED, not DRAFT, is neither repaired nor mailed', async () => {
  // `where: { status: 'DRAFT' }` and the FINALIZED/CLOSED allow-list on the
  // re-read are doing the work here. A `{ not: 'FINALIZED' }` guard, or an
  // "anything that is not DRAFT counts as done" read, would each get this
  // wrong in a different direction — one resurrects the contract, the other
  // mails over it.
  seedStrandedStrand();
  db.agreements[0].status = 'CANCELLED';
  const calls = spyOnFinalizeEmail();

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await settle();

  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(db.agreements[0].status, 'CANCELLED', 'not resurrected into FINALIZED');
  assert.deepEqual(calls, [], 'and not mailed either');
});

test('§5 the repair keeps NO-CAR-NO-CHECKOUT: a stranded reservation with no vehicle is not finalized', async () => {
  // Innovation MUST-CHANGE, 2026-08-18. The repair skips the two ADMISSION
  // gates on purpose — the car already left, and refusing over somebody else's
  // overlapping booking would just guarantee a DRAFT contract for a rental in
  // progress. NO-CAR-NO-CHECKOUT is not one of those: beta.116 exists because
  // finalizing without a vehicle produced FINALIZED agreements with no car on
  // them, and this branch would otherwise be the only path left in the service
  // that can still do it.
  //
  // Reachable, not theoretical — reservations.service.js disconnects the
  // vehicle on any `vehicleId: null` patch with no status guard, CHECKED_OUT
  // rows included.
  seedStrandedStrand();
  db.reservations[0].vehicleId = null; // the car was unassigned after checkout
  const calls = spyOnFinalizeEmail();

  const err = await rejection(() => viaWebWizard({ id: 'cs1', toStep: 'CLOSED' }));
  await settle();

  // Reported the way the CLOSED failure card can act on: the reason is already
  // in FINALIZE_FAILURE_REASONS and already offers a retry, so the agent is
  // told to assign a car rather than left with a silent log.
  assert.equal(err.code, 'FINALIZE_INCOMPLETE');
  assert.equal(err.reason, 'NO_VEHICLE_ASSIGNED');

  // And the half-repair that silence would have produced did NOT happen: the
  // flip and its finalizedAt would have landed while the mileage row (guarded
  // on vehicleId) and the vehicle sync (no-op on a null vehicle) both skipped,
  // and the email would have gone out over exactly that.
  assert.equal(db.agreements[0].status, 'DRAFT', 'the contract was not finalized');
  assert.equal(db.agreements[0].finalizedAt, undefined, 'and not stamped');
  assert.equal(db.mileageEntries.length, 0);
  assert.deepEqual(calls, [], 'nothing was mailed over it');
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
