/**
 * M2-H8 — compare-and-set commit in transition() (2026-08-17). DB-free
 * (in-memory prisma stubs, dummy DATABASE_URL convention from beta-ci.yml).
 * Run: npm run test:checkout-cas
 *
 * Four surfaces can move one CheckoutSession (RideOps, web wizard, kiosk,
 * portal). Before H8, transition() read the row and then wrote it
 * unconditionally, so two surfaces sitting on the same step could both
 * commit the same hop. What this file pins, in order:
 *
 *   1. the duplicate TRANSITION is gone — the loser's write is refused by
 *      the DB, not by a hope
 *   2. the loser gets the TRUTH (200 + the fresh row), not ILLEGAL_TRANSITION
 *   3. idempotency is NARROW: already-PAST toStep is still a hard 409
 *   4. assertExpectedVersion's TOCTOU window is closed for opt-in callers
 *   5. a concurrent STAMP does NOT break transitions for clients that never
 *      opted in (the regression that guarding everyone on stateVersion would
 *      have caused)
 *   6. a cancel that loses the race still cancels
 *   7. the idempotent answer still runs the CLOSED cascade, so a winner whose
 *      finalize died half-way gets self-healed instead of papered over
 *   8. the self-heal CLAIMS the reservation, so two concurrent re-runs of the
 *      cascade cannot both rewrite finalizedAt and both append a mileage row
 *  8b. the CHECKED_OUT + DRAFT-agreement strand — the half-finished finalize
 *      that used to be un-self-healable, because the ownership allow-list and
 *      the cascade's status short-circuit BOTH declined it — is repaired, and
 *      the flip that repairs it carries its own compare-and-set
 *   9. what H8 does NOT close: the `events` lost-update against the FOURTEEN
 *      other writers of that TEXT column. Written as a `todo` asserting the
 *      DESIRED result, not as a passing test asserting the defect — a todo
 *      that starts passing is the signal that the hole closed.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { checkoutSessionService, CheckoutSessionError } from './checkout-session.service.js';
import { readFileSync } from 'node:fs';
import { readEvents } from './state-machine.js';
import {
  installWorld, restoreWorld, onRestore as restorePush,
  seedSession, seedFinalizeWorld, seedStrandedStrand,
  armRace, armReservationRace, armAgreementRace, viaWebWizard, viaKiosk,
} from './checkout-session.test-harness.mjs';

// The in-memory prisma world lives in checkout-session.test-harness.mjs so the
// finalize-truth suite runs against the SAME fake database. `db` stays a local
// name here, and `restore` keeps the shape the tests below already use.
let db;
const restore = { push: restorePush };

beforeEach(() => { db = installWorld(); });
afterEach(restoreWorld);

// ── 1 + 2. the duplicate TRANSITION, and what the loser is told ────────────

test('two surfaces on the same step: exactly ONE commit, and the loser gets the truth', async () => {
  const row = seedSession();

  // The web wizard reads CONFIRMING; the kiosk commits CONFIRMING→TC_PENDING
  // before the wizard's write lands.
  const raced = armRace('CONFIRMING', () => viaKiosk({ id: 'cs1', toStep: 'TC_PENDING' }));

  const out = await viaWebWizard({ id: 'cs1', toStep: 'TC_PENDING' });
  assert.equal(raced(), true, 'the race actually fired');

  // 1 — the write was refused by the CAS, not merged.
  const transitions = readEvents(row.events).filter((e) => e.kind === 'TRANSITION');
  assert.equal(transitions.length, 1, `exactly one TRANSITION, got ${transitions.length}`);
  assert.equal(row.stateVersion, 1, 'version bumped once, not twice');
  assert.equal(row.currentStep, 'TC_PENDING');

  // Attribution survives: the log names the surface that REALLY moved it.
  assert.equal(transitions[0].metadata?.kiosk, true, 'the kiosk owns the hop it made');
  assert.equal(transitions[0].actorUserId, null);

  // 2 — the loser is told the truth, with the fresh row to render.
  assert.equal(out.currentStep, 'TC_PENDING');
  assert.equal(out.stateVersion, 1, 'the loser is handed the FRESH row, not its own snapshot');
});

test('idempotent answer appends no event and does not bump the version', async () => {
  const row = seedFinalizeWorld({ reservationStatus: 'CONFIRMED', autoEmailedAt: new Date() });

  armRace('FINALIZING', () => viaKiosk({ id: 'cs1', toStep: 'CLOSED' }));
  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(readEvents(row.events).filter((e) => e.kind === 'TRANSITION').length, 1);
  assert.equal(row.stateVersion, 1, 'the no-op did not bump the version');
});

test('winner already finalized: the re-run cascade short-circuits, no double side-effects', async () => {
  seedFinalizeWorld({ reservationStatus: 'CONFIRMED', autoEmailedAt: new Date() });

  // The winner runs the whole cascade; the reservation ends CHECKED_OUT.
  armRace('FINALIZING', () => viaKiosk({ id: 'cs1', toStep: 'CLOSED' }));
  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  assert.equal(db.reservations[0].status, 'CHECKED_OUT');
  assert.equal(db.agreements[0].status, 'FINALIZED');
  // The loser re-entered the cascade, found an already CHECKED_OUT
  // reservation and stopped there — one audit line, not two.
  assert.equal(db.auditLogs.length, 1, 'exactly one STATUS_CHANGE audit line');
  assert.equal(db.mileageEntries.length, 1, 'exactly one mileage entry');
});

// QA blocker (2026-08-17). The self-heal was introduced with a single guard
// borrowed from the winner path — a DENY-list naming 3 of the 8
// ReservationStatus values. CANCELLED was not in it, and ensureCheckoutGates
// only looks at pre-checkin and age rules, never at status. So a plain repeat
// POST, no race at all, against a session closed days ago, re-ran the whole
// finalize and resurrected a reservation staff had cancelled: reservation back
// to CHECKED_OUT, finalizedAt overwritten with today, vehicle back to ON_RENT
// (which then collides the NEXT real reservation with "still out on open
// rental"), plus a spurious audit line. The docs shipped in the same change
// tell every client that re-sending a transition is safe, so this was an
// invitation to retry.
test('BLOCKER: session already CLOSED + reservation CANCELLED → 200 and ZERO writes to the world', async () => {
  // The end state directly: a checkout closed days ago, whose reservation
  // staff has since cancelled (reservations.routes.js allows CHECKED_OUT →
  // CANCELLED). Seeded rather than driven so the email arm below is LIVE —
  // autoEmailedAt null — without any winner call firing a real send first.
  const row = seedFinalizeWorld({ reservationStatus: 'CANCELLED' });
  row.currentStep = 'CLOSED';
  row.finishedAt = new Date('2026-08-10T12:00:00Z');
  const finalizedAt = new Date('2026-08-10T12:00:00Z');
  db.agreements[0].status = 'FINALIZED';
  db.agreements[0].finalizedAt = finalizedAt;
  const versionBefore = row.stateVersion;

  // An old wizard tab, a retry, anything — fires the transition again.
  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget email arm settle

  assert.equal(out.currentStep, 'CLOSED', 'still answers idempotently');
  assert.equal(db.reservations[0].status, 'CANCELLED', 'NOT resurrected');
  assert.equal(db.vehicles[0].status, 'AVAILABLE', 'car stays in the available fleet');
  assert.equal(db.agreements[0].finalizedAt, finalizedAt, 'finalizedAt not overwritten with today');
  assert.equal(db.auditLogs.length, 0, 'no spurious "Checkout wizard finalized" line');
  assert.equal(db.mileageEntries.length, 0, 'no duplicate mileage row');
  assert.equal(row.stateVersion, versionBefore, 'and no version bump');
  // The one QA caught: the guard declined the cascade and the SAME request
  // then stamped the row and handed the signed contract to the mailer, for a
  // customer whose rental was cancelled. An email cannot be un-sent.
  assert.equal(row.autoEmailedAt, null, 'and NO finalize email was queued');
});

test('a NO_SHOW reservation is not finalized onto either', async () => {
  seedFinalizeWorld({ reservationStatus: 'NO_SHOW' });

  // Winner path this time (a session parked in FINALIZING while staff marked
  // the customer a no-show) — the deny-list has to stop this one too.
  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(out.currentStep, 'CLOSED', 'the session still closes');
  assert.equal(db.reservations[0].status, 'NO_SHOW', 'but the reservation is left alone');
  assert.equal(db.vehicles[0].status, 'AVAILABLE');
  assert.equal(db.auditLogs.length, 0);
  // Ownership gates the email too, on the WINNER path — not just the
  // self-heal. No contract goes out for a no-show.
  assert.equal(db.checkoutSessions[0].autoEmailedAt, null, 'no finalize email queued');
});

// The two guards are deliberately different shapes, so each needs a case only
// IT catches — otherwise one of them ships unverified. CANCELLED/NO_SHOW above
// are caught by the deny-list; PENDING_FRANCHISE_IMPORT is caught only by the
// self-heal allow-list, because the winner path is intentionally left
// unchanged for that status.
test('self-heal declines a status it does not understand (PENDING_FRANCHISE_IMPORT)', async () => {
  seedFinalizeWorld({ reservationStatus: 'PENDING_FRANCHISE_IMPORT', autoEmailedAt: new Date() });

  // Winner path first: unchanged: this status is NOT in the deny-list, so the
  // legitimate finalize still advances it exactly as before H8.
  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  assert.equal(db.reservations[0].status, 'CHECKED_OUT', 'winner path untouched');

  // Now put it back and repeat the POST: the OPPORTUNISTIC re-run refuses,
  // because guessing on a status we do not model is not free.
  db.reservations[0].status = 'PENDING_FRANCHISE_IMPORT';
  const auditsBefore = db.auditLogs.length;

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(db.reservations[0].status, 'PENDING_FRANCHISE_IMPORT', 'self-heal declined');
  assert.equal(db.auditLogs.length, auditsBefore);
});

test('SELF-HEAL: a winner whose cascade died half-way is completed by the idempotent caller', async () => {
  const row = seedFinalizeWorld({ reservationStatus: 'CONFIRMED', autoEmailedAt: new Date() });

  // The winner reaches CLOSED, then its cascade dies. The catch at the end of
  // transition() swallows anything that is not a CheckoutSessionError with a
  // logger.warn, so the winner returns 200 over a half-finalized checkout and
  // NOTHING ever retries it. That is the state the loser walks into.
  // Injected on updateMany, not update: the cascade's reservation write is the
  // CLAIM now (2026-08-18), and a patch left on the old method would break
  // nothing at all — the assertions below would then be describing a cascade
  // that simply succeeded.
  let breakCascade = true;
  const origResvUpdateMany = prisma.reservation.updateMany;
  prisma.reservation.updateMany = async (args) => {
    if (breakCascade) throw new Error('injected half-way cascade failure');
    return origResvUpdateMany(args);
  };
  restore.push(() => { prisma.reservation.updateMany = origResvUpdateMany; });

  armRace('FINALIZING', () => viaKiosk({ id: 'cs1', toStep: 'CLOSED' }));

  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  assert.equal(row.currentStep, 'CLOSED', 'the step moved...');
  assert.equal(db.reservations[0].status, 'CONFIRMED', '...but the reservation was left behind');
  assert.equal(db.agreements[0].status, 'DRAFT', 'and so was the contract');

  // A later caller — the agent's screen retrying, RideOps polling — now
  // finishes the job instead of being told a clean 200 over a broken finalize.
  breakCascade = false;
  const healed = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  assert.equal(healed.currentStep, 'CLOSED');
  assert.equal(db.reservations[0].status, 'CHECKED_OUT', 'self-healed');
  assert.equal(db.agreements[0].status, 'FINALIZED', 'self-healed');
  assert.equal(db.vehicles[0].status, 'ON_RENT', 'self-healed');
  // Still no second hop in the log — healing is not a transition.
  assert.equal(readEvents(row.events).filter((e) => e.kind === 'TRANSITION').length, 1);
  assert.equal(row.stateVersion, 1);
});

// The self-heal is the one path into the cascade that breaks out of the CAS
// loop WITHOUT a commit, so until the claim it held nothing: two callers on it
// both ran the whole arm. The allow-list and the status short-circuit were
// containing that, which is an unenforced invariant three files from the writes
// it protects. "Reintentar cierre" — a button on the CLOSED failure card whose
// entire job is to re-POST CLOSED → CLOSED and re-run this cascade — is what
// made the second caller ordinary rather than theoretical:
// `transitionInFlightRef` guards one tab, and a second tab is not that tab.
test('two concurrent self-heals: the claim lets exactly ONE run the cascade', async () => {
  const row = seedFinalizeWorld({ reservationStatus: 'CONFIRMED', autoEmailedAt: new Date() });
  // The exact state the failure card offers the button on: the step committed,
  // the cascade behind it did not.
  row.currentStep = 'CLOSED';
  row.finishedAt = new Date('2026-08-17T12:00:00Z');

  // Two tabs press it together. The second commits the entire cascade while
  // the first is still holding the reservation row it read a moment ago.
  let winnerFinalizedAt = null;
  const raced = armReservationRace('CONFIRMED', async () => {
    await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
    winnerFinalizedAt = db.agreements[0].finalizedAt;
  });

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  assert.equal(raced(), true, 'the race actually fired');

  // Both tabs are still answered honestly, and the work really happened.
  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(db.reservations[0].status, 'CHECKED_OUT', 'the cascade ran');
  assert.equal(db.agreements[0].status, 'FINALIZED');
  assert.equal(db.vehicles[0].status, 'ON_RENT');
  assert.ok(winnerFinalizedAt, 'the winner really finalized inside the race');

  // ...but exactly once. These are the two writes that do not survive a second
  // run: compared by REFERENCE, so a rewrite with an identical millisecond
  // still fails.
  assert.equal(db.agreements[0].finalizedAt, winnerFinalizedAt,
    'finalizedAt still says when the car left, not when the retry landed');
  assert.equal(db.mileageEntries.length, 1, 'exactly one CHECKOUT mileage row');
  assert.equal(db.auditLogs.length, 1, 'exactly one STATUS_CHANGE audit line');
  // And healing is still not a transition, on either tab.
  assert.equal(readEvents(row.events).filter((e) => e.kind === 'TRANSITION').length, 0);
});

// The WINNER can lose the claim too, and it is the more alarming direction:
// this is the request the agent is actually staring at. transition() commits
// CLOSED before the cascade runs, which is exactly what makes a second tab
// eligible to self-heal — so the winner can be overtaken between its own
// ownership read and its own write.
test('the WINNER losing the claim writes nothing either', async () => {
  const row = seedFinalizeWorld({ reservationStatus: 'CONFIRMED', autoEmailedAt: new Date() });

  let winnerFinalizedAt = null;
  const raced = armReservationRace('CONFIRMED', async () => {
    // The session is already CLOSED by now — the step commit happens before
    // the cascade — so this second surface takes the self-heal path and wins.
    await viaKiosk({ id: 'cs1', toStep: 'CLOSED' });
    winnerFinalizedAt = db.agreements[0].finalizedAt;
  });

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  assert.equal(raced(), true, 'the race actually fired');

  assert.equal(out.currentStep, 'CLOSED', 'the finalize still answers 200');
  assert.equal(db.reservations[0].status, 'CHECKED_OUT');
  assert.equal(db.agreements[0].finalizedAt, winnerFinalizedAt, 'not rewritten');
  assert.equal(db.mileageEntries.length, 1, 'exactly one CHECKOUT mileage row');
  assert.equal(db.auditLogs.length, 1, 'exactly one STATUS_CHANGE audit line');
  // One hop, committed by the wizard — the kiosk self-healed, it did not move.
  assert.equal(readEvents(row.events).filter((e) => e.kind === 'TRANSITION').length, 1);
});

// A property the claim added on the way past, worth pinning because nothing
// else asserts it: `finalizeOwnsReservation` is decided at the ownership read,
// so a cancel landing AFTER it used to sail straight into the cascade. The
// claim re-asserts the status at write time, which is the only place it can be
// checked and acted on atomically.
test('staff cancels inside the window: the claim refuses, the cascade writes nothing', async () => {
  seedFinalizeWorld({ reservationStatus: 'CONFIRMED', autoEmailedAt: new Date() });

  const raced = armReservationRace('CONFIRMED', async () => {
    // reservations.routes.js allows this while the agent is at the counter.
    db.reservations[0].status = 'CANCELLED';
  });

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  assert.equal(raced(), true, 'the race actually fired');

  assert.equal(out.currentStep, 'CLOSED', 'the session still closes');
  assert.equal(db.reservations[0].status, 'CANCELLED', 'NOT resurrected');
  assert.equal(db.agreements[0].status, 'DRAFT', 'and no contract was finalized');
  assert.equal(db.vehicles[0].status, 'AVAILABLE', 'car stays in the available fleet');
  assert.equal(db.mileageEntries.length, 0);
  assert.equal(db.auditLogs.length, 0);
});

// ── 8b. the strand the self-heal could not reach (2026-08-18) ──────────────
//
// A reservation on CHECKED_OUT with its agreement still DRAFT was PERMANENTLY
// un-self-healable, and it is the state a broken finalize most often leaves:
// the claim succeeds, the agreement write behind it does not. Both doors were
// shut. `selfHealOwns` excluded CHECKED_OUT, so a repeat POST declined at the
// ownership guard; and even granted ownership, the cascade's status
// short-circuit declines an already-CHECKED_OUT reservation and reported
// SUCCESS — it inferred "the contract is FINALIZED" from `reservation.status`
// alone. So "Reintentar cierre", the button on the CLOSED failure card whose
// entire job is to re-POST CLOSED → CLOSED, was a no-op on precisely the
// failure mode that card exists to report.
//
// Before the reservation claim shipped, a CONCURRENT caller would blunder
// through and accidentally finish the abandoned cascade — at the cost of the
// duplicate finalizedAt/mileage rows that ticket killed. Removing the accident
// is what made the repair worth writing on purpose.

test('the strand is REACHABLE: a finalize whose agreement write fails leaves CHECKED_OUT + DRAFT', async () => {
  // Driven, not seeded. Everything below is about repairing this state, so it
  // has to be a state a real finalize can actually produce.
  const row = seedFinalizeWorld({ reservationStatus: 'CONFIRMED', autoEmailedAt: new Date() });

  const origFlip = prisma.rentalAgreement.updateMany;
  prisma.rentalAgreement.updateMany = async () => { throw new Error('injected agreement write failure'); };
  restore.push(() => { prisma.rentalAgreement.updateMany = origFlip; });

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  // Nothing throws — the agreement write is best-effort by design — so the
  // agent is answered 200 and the session shows a finished checkout.
  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(row.currentStep, 'CLOSED');
  assert.equal(db.reservations[0].status, 'CHECKED_OUT', 'the claim went through...');
  assert.equal(db.agreements[0].status, 'DRAFT', '...and the contract was left behind it');
  // The mileage row rides the flip now, so a failed flip writes none — which
  // is what stops the repair below from appending a second one.
  assert.equal(db.mileageEntries.length, 0, 'no mileage row for a contract that never finalized');
});

test('SELF-HEAL: the CHECKED_OUT + DRAFT-agreement strand is repaired, not reported as success', async () => {
  const row = seedStrandedStrand();
  const versionBefore = row.stateVersion;

  const healed = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  assert.equal(healed.currentStep, 'CLOSED', 'still answers idempotently');
  assert.equal(db.agreements[0].status, 'FINALIZED', 'the contract is the legal document now');
  assert.ok(db.agreements[0].finalizedAt instanceof Date);
  // The companions that hang off the flip come with it.
  assert.equal(db.agreements[0].odometerOut, 45000, 'the CHECKOUT odometer was copied over');
  assert.equal(db.mileageEntries.length, 1, 'exactly one CHECKOUT mileage row');
  // The same strand can have left the car behind, since the old cascade ran
  // the vehicle sync AFTER the agreement write.
  assert.equal(db.vehicles[0].status, 'ON_RENT', 'and the car is marked rented');

  // Healing is still not a transition, and the repair touches neither the
  // reservation row nor the audit trail: nothing changed status, so a
  // CHECKED_OUT → CHECKED_OUT line would be a false entry.
  assert.equal(db.reservations[0].status, 'CHECKED_OUT');
  assert.equal(db.auditLogs.length, 0, 'no STATUS_CHANGE line for a status that did not change');
  assert.equal(readEvents(row.events).filter((e) => e.kind === 'TRANSITION').length, 0);
  assert.equal(row.stateVersion, versionBefore, 'and no version bump');
});

test('the repair is idempotent: pressing "Reintentar cierre" twice more changes nothing', async () => {
  seedStrandedStrand();

  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  const finalizedAt = db.agreements[0].finalizedAt;
  assert.ok(finalizedAt, 'the first press repaired it');

  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  // Compared by REFERENCE, so a rewrite with an identical millisecond fails.
  assert.equal(db.agreements[0].finalizedAt, finalizedAt,
    'finalizedAt still says when the repair ran, not when the last retry landed');
  assert.equal(db.mileageEntries.length, 1, 'still exactly one CHECKOUT mileage row');
  assert.equal(db.auditLogs.length, 0);
});

// The flip's OWN guard, isolated. This is the one path where the reservation
// claim cannot help: the row it would claim is already CHECKED_OUT, so there
// is nothing left to claim and the agreement write is on its own. Race it here
// and a bare `update` — what this was until 2026-08-18 — rewrites finalizedAt
// and appends a second mileage row.
test('two concurrent repairs: the flip lets exactly ONE finalize the contract', async () => {
  seedStrandedStrand();

  let winnerFinalizedAt = null;
  const raced = armAgreementRace('DRAFT', async () => {
    await viaKiosk({ id: 'cs1', toStep: 'CLOSED' });
    winnerFinalizedAt = db.agreements[0].finalizedAt;
  });

  // Our caller is now holding a DRAFT snapshot of a row the other surface has
  // already finalized, and walks straight into the flip with it.
  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  assert.equal(raced(), true, 'the race actually fired');

  assert.equal(out.currentStep, 'CLOSED', 'both surfaces are still answered honestly');
  assert.ok(winnerFinalizedAt, 'the winner really finalized inside the race');
  assert.equal(db.agreements[0].status, 'FINALIZED');
  assert.equal(db.agreements[0].finalizedAt, winnerFinalizedAt, 'not rewritten by the loser');
  assert.equal(db.mileageEntries.length, 1, 'exactly one CHECKOUT mileage row');
});

test('a repair whose flip FAILS reports failure instead of claiming the contract is finalized', async () => {
  seedStrandedStrand();

  // Counted, not just patched: every other assertion here is about what did
  // NOT happen, and they all pass just as well against a build where the
  // repair never ran at all — which is exactly the defect being fixed.
  let flipAttempts = 0;
  const origFlip = prisma.rentalAgreement.updateMany;
  prisma.rentalAgreement.updateMany = async () => {
    flipAttempts += 1;
    throw new Error('injected agreement write failure');
  };
  restore.push(() => { prisma.rentalAgreement.updateMany = origFlip; });

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  assert.equal(flipAttempts, 1, 'the repair was actually attempted');
  assert.equal(out.currentStep, 'CLOSED', 'the caller still gets its 200');
  assert.equal(db.agreements[0].status, 'DRAFT', 'and the contract is still not the legal document');
  assert.equal(db.mileageEntries.length, 0);
  // What must NOT happen is the old one-liner's answer — see the email gate in
  // checkout-finalize-truth.test.mjs, which is where this becomes observable.
  assert.equal(db.checkoutSessions[0].autoEmailedAt, null, 'and no contract was mailed over it');
});

test('CHECKED_IN + a DRAFT contract is NOT repaired — the car already came back', async () => {
  // Deliberately out of scope: stamping `finalizedAt: now` onto a rental that
  // has already been returned would date the handover after the return. The
  // repair is for the strand where the checkout itself is unfinished.
  const row = seedFinalizeWorld({ reservationStatus: 'CHECKED_IN' });
  row.currentStep = 'CLOSED';
  row.finishedAt = new Date('2026-08-17T12:00:00Z');

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(db.agreements[0].status, 'DRAFT', 'left exactly as it was found');
  assert.equal(db.mileageEntries.length, 0);
  assert.equal(db.auditLogs.length, 0);
  assert.equal(row.autoEmailedAt, null, 'and no contract went out for it');
});

test('widening selfHealOwns did not reopen the CANCELLED door', async () => {
  // CHECKED_OUT joined the allow-list; CANCELLED and NO_SHOW are still refused
  // one guard earlier, by `cancelledLate`. Pinned because the widening is the
  // kind of edit that invites the QA blocker of 2026-08-17 back in.
  const row = seedFinalizeWorld({ reservationStatus: 'CANCELLED' });
  row.currentStep = 'CLOSED';
  row.finishedAt = new Date('2026-08-10T12:00:00Z');

  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  assert.equal(db.reservations[0].status, 'CANCELLED', 'NOT resurrected');
  assert.equal(db.agreements[0].status, 'DRAFT', 'and its contract was not finalized either');
  assert.equal(db.vehicles[0].status, 'AVAILABLE');
  assert.equal(db.auditLogs.length, 0);
  assert.equal(row.autoEmailedAt, null);
});

// ── 3. idempotency stays narrow ────────────────────────────────────────────

test('already PAST toStep is still ILLEGAL_TRANSITION — "already at" is not "already past"', async () => {
  seedSession({ currentStep: 'PAID', paymentCompletedAt: new Date() });

  // The wizard asks for step 2 while the session sits on step 3. Answering
  // 200 here would tell the agent a step just succeeded that did not.
  await assert.rejects(
    () => viaWebWizard({ id: 'cs1', toStep: 'TC_PENDING' }),
    (e) => {
      assert.ok(e instanceof CheckoutSessionError);
      assert.equal(e.status, 409);
      assert.equal(e.code, 'ILLEGAL_TRANSITION');
      assert.match(e.message, /PAID → TC_PENDING/, 'the message names the step it is REALLY on');
      return true;
    },
  );
});

test('a CAS loss that lands on an illegal step reports the FRESH step, not the stale one', async () => {
  seedSession({ currentStep: 'TC_PENDING', tcCompletedAt: new Date() });

  // We want TC_SIGNED from TC_PENDING (legal). Another surface runs two hops,
  // so by commit time the row is on PAYMENT_PENDING and our hop is illegal.
  armRace('TC_PENDING', async () => {
    await viaKiosk({ id: 'cs1', toStep: 'TC_SIGNED' });
    await viaKiosk({ id: 'cs1', toStep: 'PAYMENT_PENDING' });
  });

  await assert.rejects(
    () => viaWebWizard({ id: 'cs1', toStep: 'TC_SIGNED' }),
    (e) => e.code === 'ILLEGAL_TRANSITION' && /PAYMENT_PENDING → TC_SIGNED/.test(e.message),
  );
});

// ── 4. the assertExpectedVersion TOCTOU window ─────────────────────────────

test('expectedVersion: a write between the check and the commit is caught (TOCTOU closed)', async () => {
  const row = seedSession({ currentStep: 'TC_PENDING', tcCompletedAt: new Date() });

  // The version MATCHES at check time (snapshot says 0). The stamp lands
  // after. Pre-H8 the write went through on a check that was already false.
  armRace('TC_PENDING', () => checkoutSessionService.stampSideEffect({
    id: 'cs1', field: 'paymentCompletedAt',
  }));

  await assert.rejects(
    () => checkoutSessionService.transition({ id: 'cs1', toStep: 'TC_SIGNED', expectedVersion: 0 }),
    (e) => {
      assert.equal(e.code, 'STALE_VERSION');
      assert.equal(e.status, 409);
      assert.equal(e.session?.stateVersion, 1, 'the 409 carries the fresh row');
      return true;
    },
  );
  assert.equal(row.currentStep, 'TC_PENDING', 'the refused transition wrote nothing');
});

test('expectedVersion opts OUT of the idempotent answer — strict callers get STALE_VERSION', async () => {
  seedSession();

  armRace('CONFIRMING', () => viaKiosk({ id: 'cs1', toStep: 'TC_PENDING' }));

  // Same situation as test 1 (another surface made our exact hop), but this
  // caller asked to be told when its snapshot died. It is told.
  await assert.rejects(
    () => checkoutSessionService.transition({ id: 'cs1', toStep: 'TC_PENDING', expectedVersion: 0 }),
    (e) => e.code === 'STALE_VERSION' && e.session?.currentStep === 'TC_PENDING',
  );
});

// ── 5. no new failure mode for clients that never opted in ─────────────────

test('a concurrent STAMP must NOT fail a legacy transition (version is not in their CAS)', async () => {
  const row = seedSession({ currentStep: 'TC_PENDING', tcCompletedAt: new Date() });

  // A stamp bumps stateVersion WITHOUT moving currentStep. Had H8 guarded
  // every caller on stateVersion, the web wizard and the kiosk would start
  // 409ing every time the customer's phone stamped mid-step — a regression
  // invented by the fix. Their CAS is on currentStep only.
  armRace('TC_PENDING', () => checkoutSessionService.stampSideEffect({
    id: 'cs1', field: 'paymentCompletedAt',
  }));

  const out = await viaWebWizard({ id: 'cs1', toStep: 'TC_SIGNED' });
  assert.equal(out.currentStep, 'TC_SIGNED', 'the legacy transition went through');
  assert.equal(row.currentStep, 'TC_SIGNED');
});

// ── 6. a cancel that loses the race still cancels ──────────────────────────

test('CANCELLED stays legal from wherever the winner left us — the retry commits it', async () => {
  const row = seedSession();

  // The agent hits "cancel" on a CONFIRMING snapshot; the kiosk advances to
  // TC_PENDING first. CANCELLED is legal from any non-terminal step, so
  // refusing here would be the same lie in the other direction.
  armRace('CONFIRMING', () => viaKiosk({ id: 'cs1', toStep: 'TC_PENDING' }));

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CANCELLED' });
  assert.equal(out.currentStep, 'CANCELLED');
  assert.ok(row.finishedAt instanceof Date, 'terminal stamp applied');

  const transitions = readEvents(row.events).filter((e) => e.kind === 'TRANSITION');
  assert.deepEqual(
    transitions.map((t) => `${t.from}→${t.to}`),
    ['CONFIRMING→TC_PENDING', 'TC_PENDING→CANCELLED'],
    'the cancel is recorded from the step it really left',
  );
});

// ── the inventory of 14 writers must not rot ────────────────────────────────
//
// The line numbers in transition()'s events comment have gone stale three
// times in three edits — twice because correcting the comment changed its own
// length and shifted the very lines it cites. A reviewer who spot-checks one
// and finds a blank line stops trusting the whole list, which is the point of
// having it. So the list is checked, not promised.

test('every line number in the 14-writer inventory still points at what it claims', () => {
  const here = new URL('.', import.meta.url);
  const svc = readFileSync(new URL('checkout-session.service.js', here), 'utf8').split('\n');
  const comment = svc.join('\n');

  // Local entries: "name :READ → :WRITE" inside this file.
  const local = [...comment.matchAll(/^\s*\/\/\s{3}(\w+)\s+:(\d+) → :(\d+)/gm)];
  assert.equal(local.length, 5, 'expected the 5 in-file writers');
  for (const [, name, readLine, writeLine] of local) {
    assert.match(svc[Number(readLine) - 1], /prisma\.checkoutSession\.findUnique/, `${name} read line ${readLine}`);
    assert.match(svc[Number(writeLine) - 1], /events: appendEvent/, `${name} write line ${writeLine}`);
  }

  // External entries: "some/file.js:12, :34" style.
  const external = [...comment.matchAll(/^\s*\/\/\s{3}([\w-]+\.service\.js|[\w-]+\.scheduler\.js):([\d, :]+)/gm)];
  assert.ok(external.length >= 4, 'expected the external files to be listed');
  let externalRefs = 0;
  for (const [, file, nums] of external) {
    const lines = readFileSync(new URL(file, here), 'utf8').split('\n');
    for (const n of nums.match(/\d+/g) || []) {
      assert.match(lines[Number(n) - 1], /appendEvent/, `${file}:${n}`);
      externalRefs += 1;
    }
  }
  assert.equal(externalRefs, 9, 'expected 9 external references (5 + 1 + 1 + 1 + 1)');
  assert.equal(local.length + externalRefs, 14, 'fourteen writers, all resolving');

  // The parenthetical on saveCustomerSignature is part of the same list and
  // rots the same way, but the two regexes above cannot see it. It went stale
  // in the change that added the reservation claim and was caught by hand,
  // which is the failure mode this whole test exists to remove. Checked now.
  const txRef = comment.match(/\$transaction that starts :(\d+)/);
  assert.ok(txRef, 'the saveCustomerSignature parenthetical is still there');
  assert.match(svc[Number(txRef[1]) - 1], /prisma\.\$transaction\(\[/, `$transaction line ${txRef[1]}`);
});

// ── CONCURRENT_MODIFICATION — documented client contract, so it gets a test ─

test('losing the CAS race every attempt → 409 CONCURRENT_MODIFICATION with the fresh row', async () => {
  seedSession();

  // A cancel is the only request that stays legal after losing, so it is the
  // only one that can exhaust the retry budget. Move the step out from under
  // every single commit attempt.
  const origUpdateMany = prisma.checkoutSession.updateMany;
  prisma.checkoutSession.updateMany = async (args) => {
    const row = db.checkoutSessions[0];
    if (args?.data?.currentStep === 'CANCELLED') {
      // Somebody else advances a step between our read and our write, every time.
      const order = ['CONFIRMING', 'TC_PENDING', 'TC_SIGNED', 'PAYMENT_PENDING'];
      const next = order[order.indexOf(row.currentStep) + 1];
      if (next) { row.currentStep = next; row.stateVersion += 1; }
    }
    return origUpdateMany(args);
  };
  restore.push(() => { prisma.checkoutSession.updateMany = origUpdateMany; });

  await assert.rejects(
    () => viaWebWizard({ id: 'cs1', toStep: 'CANCELLED' }),
    (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, 'CONCURRENT_MODIFICATION');
      assert.ok(e.session, 'carries the fresh row, as the client contract promises');
      return true;
    },
  );
  assert.notEqual(db.checkoutSessions[0].currentStep, 'CANCELLED', 'nothing was committed');
});

// ── 7. what H8 does NOT close ──────────────────────────────────────────────

// What H8 DOES hold when a stamp races a transition: the step and both
// version bumps. These are permanent invariants, so they are a normal test.
test('a stamp racing a transition still loses neither the step nor a version bump', async () => {
  const row = seedSession({ currentStep: 'TC_PENDING', tcCompletedAt: new Date() });

  armRace('TC_PENDING', () => viaKiosk({ id: 'cs1', toStep: 'TC_SIGNED' }));
  await checkoutSessionService.stampSideEffect({ id: 'cs1', field: 'paymentCompletedAt' });

  assert.equal(row.currentStep, 'TC_SIGNED', 'the step survived');
  assert.ok(row.paymentCompletedAt instanceof Date, 'the stamp survived');
  assert.equal(row.stateVersion, 2, 'both bumps survived — increment is atomic, unlike the string');
});

// ...and what it does NOT hold. Written as a todo asserting the result we
// WANT, not as a green test asserting the defect: pinning the bug means the
// day somebody fixes it the suite turns red and reads like a regression.
// node:test reports a failing todo as expected; a todo that starts PASSING is
// the signal that the lost-update was really closed (row locking, or a CAS on
// the observed `events` value, or moving it off TEXT) — at which point delete
// the todo marker and update ops-app-plan.
test('RESIDUAL (14 unguarded writers): a concurrent stamp should not eat the TRANSITION entry', {
  todo: 'events is a TEXT column with unguarded read-modify-write in 14 places; H8 only serialises transition-vs-transition',
}, async () => {
  const row = seedSession({ currentStep: 'TC_PENDING', tcCompletedAt: new Date() });

  // Same column, opposite order: the STAMP reads events, a transition commits,
  // then the stamp writes the string it computed before that. H8's CAS is on
  // currentStep, and a stamp has no step to compare against.
  armRace('TC_PENDING', () => viaKiosk({ id: 'cs1', toStep: 'TC_SIGNED' }));
  await checkoutSessionService.stampSideEffect({ id: 'cs1', field: 'paymentCompletedAt' });

  const kinds = readEvents(row.events).map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['SIDE_EFFECT', 'TRANSITION'], 'both entries should survive');
});
