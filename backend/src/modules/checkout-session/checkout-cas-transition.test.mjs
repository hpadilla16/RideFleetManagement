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
 *   8. what H8 does NOT close: the `events` lost-update against the FOURTEEN
 *      other writers of that TEXT column. Written as a `todo` asserting the
 *      DESIRED result, not as a passing test asserting the defect — a todo
 *      that starts passing is the signal that the hole closed.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { checkoutSessionService, CheckoutSessionError } from './checkout-session.service.js';
import { readEvents } from './state-machine.js';

// ── minimal in-memory stubs (checkout-stale-version.test.mjs style) ─────────

let db;
let restore = [];

function applyData(row, data) {
  for (const [key, val] of Object.entries(data || {})) {
    if (val && typeof val === 'object' && !(val instanceof Date) && 'increment' in val) {
      row[key] = (row[key] || 0) + val.increment;
    } else {
      row[key] = val;
    }
  }
  return row;
}

// Operator support is NOT optional here (kiosk-checkout.test.mjs shape). The
// CLOSED cascade runs ensureNoVehicleConflict, whose where clauses are built
// out of `not` / `in` / date ranges. A matcher that waves operator objects
// through as `true` makes the reservation conflict with ITSELF and the
// cascade dies on a VEHICLE_CONFLICT that no real database would produce.
function condMatch(rowVal, cond) {
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'mode') continue;
    if (op === 'not') {
      if (val === null ? rowVal == null : rowVal === val) return false;
    } else if (op === 'in') {
      if (!val.includes(rowVal)) return false;
    } else if (op === 'notIn') {
      if (val.includes(rowVal)) return false;
    } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (rowVal == null) return false;
      if (op === 'gt' && !(rowVal > val)) return false;
      if (op === 'gte' && !(rowVal >= val)) return false;
      if (op === 'lt' && !(rowVal < val)) return false;
      if (op === 'lte' && !(rowVal <= val)) return false;
    } else if (op === 'equals') {
      if (rowVal !== val) return false;
    }
  }
  return true;
}

function matches(row, where) {
  return Object.entries(where || {}).every(([key, val]) => {
    if (val === undefined) return true;
    if (key === 'OR') return val.some((clause) => matches(row, clause));
    if (key === 'AND') return val.every((clause) => matches(row, clause));
    if (key === 'NOT') return !matches(row, val);
    if (val === null) return row[key] == null;
    if (val instanceof Date || typeof val !== 'object') return row[key] === val;
    return condMatch(row[key], val);
  });
}

let seq = 0;

function stub(rows) {
  return {
    // `create` matters more than it looks: the cascade's auditLog and mileage
    // writes are wrapped in .catch(() => {}), so a stub missing this method
    // fails SILENTLY and the "exactly one audit line" assertion below would
    // pass against zero of them.
    create: async ({ data } = {}) => {
      const row = { id: `row_${++seq}`, ...data };
      rows().push(row);
      return row;
    },
    count: async ({ where } = {}) => rows().filter((r) => matches(r, where)).length,
    findFirst: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findUnique: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findMany: async ({ where } = {}) => rows().filter((r) => matches(r, where)),
    update: async ({ where, data } = {}) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error('stub update: no match');
      return applyData(row, data);
    },
    updateMany: async ({ where, data } = {}) => {
      const hits = rows().filter((r) => matches(r, where));
      hits.forEach((r) => applyData(r, data));
      return { count: hits.length };
    },
  };
}

beforeEach(() => {
  db = {
    checkoutSessions: [], agreements: [], reservations: [], vehicles: [],
    inspections: [], loanerAgreements: [], auditLogs: [], mileageEntries: [],
  };
  Object.assign(prisma.checkoutSession, stub(() => db.checkoutSessions));
  Object.assign(prisma.rentalAgreement, stub(() => db.agreements));
  Object.assign(prisma.reservation, stub(() => db.reservations));
  // Only the CLOSED-cascade tests reach these; the rest never touch them.
  Object.assign(prisma.vehicle, stub(() => db.vehicles));
  Object.assign(prisma.rentalAgreementInspection, stub(() => db.inspections));
  Object.assign(prisma.loanerAgreement, stub(() => db.loanerAgreements));
  Object.assign(prisma.auditLog, stub(() => db.auditLogs));
  Object.assign(prisma.vehicleMileageEntry, stub(() => db.mileageEntries));
  prisma.$transaction = async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma));
  restore = [];
});

afterEach(() => { restore.forEach((fn) => fn()); });

function seedSession(overrides = {}) {
  const row = {
    id: 'cs1', reservationId: 'res1', agreementId: null, tenantId: 't1',
    currentStep: 'CONFIRMING', events: '[]', stateVersion: 0,
    tcCompletedAt: null, paymentCompletedAt: null, inspectionCompletedAt: null,
    customerSignedAt: null, finishedAt: null, autoEmailedAt: null,
    ...overrides,
  };
  db.checkoutSessions.push(row);
  return row;
}

/**
 * The race, made deterministic. The next read of a row sitting on
 * `triggerStep` returns the SNAPSHOT that read would have seen — and `foreign`
 * (the other surface) commits in between. That is exactly the read-then-write
 * window: our caller now holds a row the database has already moved past.
 */
function armRace(triggerStep, foreign) {
  const orig = prisma.checkoutSession.findUnique;
  let fired = false;
  prisma.checkoutSession.findUnique = async (args) => {
    const row = await orig(args);
    if (!fired && row && row.currentStep === triggerStep) {
      fired = true;
      const snapshot = { ...row }; // detached, like a real read
      await foreign();
      return snapshot;
    }
    return row;
  };
  restore.push(() => { prisma.checkoutSession.findUnique = orig; });
  return () => fired;
}

// ── the REAL payloads, not invented ones ───────────────────────────────────
//
// frontend/src/lib/checkout-session.js#transition puts exactly
// `JSON.stringify({ toStep, metadata })` on the wire, and
// checkout-session.routes.js:97 destructures `{ toStep, metadata,
// expectedVersion }` out of it. With metadata omitted, JSON.stringify DROPS
// the key, so the service is called with metadata AND expectedVersion
// undefined. Round-tripping through JSON here is the point: a hand-written
// `{ expectedVersion: undefined }` would be the payload we imagined.

function viaWebWizard({ id, toStep, metadata, actorUserId = 'agent-1' }) {
  const body = JSON.parse(JSON.stringify({ toStep, metadata }));
  const { toStep: t, metadata: m, expectedVersion } = body || {};
  return checkoutSessionService.transition({ id, toStep: t, actorUserId, metadata: m, expectedVersion });
}

// kiosk-checkout.service.js:841 — no expectedVersion key at all, actorUserId null.
function viaKiosk({ id, toStep }) {
  return checkoutSessionService.transition({
    id, toStep, actorUserId: null,
    metadata: { kiosk: true, kioskSessionId: 'ks1', deviceId: 'dev1' },
  });
}

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

/**
 * Seeds a session one hop from CLOSED plus the world its finalize cascade
 * touches. autoEmailedAt is PRE-STAMPED so maybeSendFinalizeEmail returns at
 * its first line: it dynamic-imports the rental-agreements service (Puppeteer
 * underneath) and is fire-and-forget anyway, so it is not what these two
 * tests are about. The reservation/agreement/vehicle triple is.
 */
function seedFinalizeWorld({ reservationStatus = 'CONFIRMED' } = {}) {
  const row = seedSession({
    currentStep: 'FINALIZING', customerSignedAt: new Date(),
    agreementId: 'ra1', autoEmailedAt: new Date(),
  });
  db.agreements.push({
    id: 'ra1', reservationId: 'res1', status: 'DRAFT',
    odometerOut: null, fuelOut: null, agreementNumber: 'AG-1',
  });
  db.reservations.push({
    id: 'res1', tenantId: 't1', status: reservationStatus, vehicleId: 'veh1',
    pickupAt: new Date('2026-08-17T10:00:00Z'), returnAt: new Date('2026-08-20T10:00:00Z'),
    customerInfoCompletedAt: new Date(), customer: null, pickupLocation: null,
  });
  db.vehicles.push({ id: 'veh1', status: 'AVAILABLE', mileage: 1000 });
  // A real finalize has a CHECKOUT inspection to copy odometer/fuel from —
  // without it `checkoutOdometer` is null and the cascade legitimately writes
  // no mileage entry, which would make the "exactly one" assertions vacuous.
  db.inspections.push({
    id: 'insp1', rentalAgreementId: 'ra1', phase: 'CHECKOUT',
    odometer: 45000, fuelLevel: 'HALF',
  });
  return row;
}

test('idempotent answer appends no event and does not bump the version', async () => {
  const row = seedFinalizeWorld({ reservationStatus: 'CONFIRMED' });

  armRace('FINALIZING', () => viaKiosk({ id: 'cs1', toStep: 'CLOSED' }));
  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(readEvents(row.events).filter((e) => e.kind === 'TRANSITION').length, 1);
  assert.equal(row.stateVersion, 1, 'the no-op did not bump the version');
});

test('winner already finalized: the re-run cascade short-circuits, no double side-effects', async () => {
  seedFinalizeWorld({ reservationStatus: 'CONFIRMED' });

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
  const row = seedFinalizeWorld({ reservationStatus: 'CONFIRMED' });

  // A real, completed checkout...
  await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  assert.equal(db.reservations[0].status, 'CHECKED_OUT');
  const finalizedAt = db.agreements[0].finalizedAt;

  // ...that staff cancels afterwards (reservations.routes.js allows
  // CHECKED_OUT → CANCELLED).
  db.reservations[0].status = 'CANCELLED';
  db.vehicles[0].status = 'AVAILABLE';
  const auditsBefore = db.auditLogs.length;
  const mileageBefore = db.mileageEntries.length;

  // Now an old wizard tab, a retry, anything — fires the transition again.
  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  assert.equal(out.currentStep, 'CLOSED', 'still answers idempotently');
  assert.equal(db.reservations[0].status, 'CANCELLED', 'NOT resurrected');
  assert.equal(db.vehicles[0].status, 'AVAILABLE', 'car stays in the available fleet');
  assert.equal(db.agreements[0].finalizedAt, finalizedAt, 'finalizedAt not overwritten with today');
  assert.equal(db.auditLogs.length, auditsBefore, 'no spurious "Checkout wizard finalized" line');
  assert.equal(db.mileageEntries.length, mileageBefore, 'no duplicate mileage row');
  assert.equal(row.stateVersion, 1, 'and no version bump');
});

test('a NO_SHOW reservation is not finalized onto either', async () => {
  seedFinalizeWorld({ reservationStatus: 'NO_SHOW' });

  // Winner path this time (a session parked in FINALIZING while staff marked
  // the customer a no-show) — the deny-list has to stop this one too.
  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });

  assert.equal(out.currentStep, 'CLOSED', 'the session still closes');
  assert.equal(db.reservations[0].status, 'NO_SHOW', 'but the reservation is left alone');
  assert.equal(db.vehicles[0].status, 'AVAILABLE');
  assert.equal(db.auditLogs.length, 0);
});

// The two guards are deliberately different shapes, so each needs a case only
// IT catches — otherwise one of them ships unverified. CANCELLED/NO_SHOW above
// are caught by the deny-list; PENDING_FRANCHISE_IMPORT is caught only by the
// self-heal allow-list, because the winner path is intentionally left
// unchanged for that status.
test('self-heal declines a status it does not understand (PENDING_FRANCHISE_IMPORT)', async () => {
  seedFinalizeWorld({ reservationStatus: 'PENDING_FRANCHISE_IMPORT' });

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
  const row = seedFinalizeWorld({ reservationStatus: 'CONFIRMED' });

  // The winner reaches CLOSED, then its cascade dies. The catch at the end of
  // transition() swallows anything that is not a CheckoutSessionError with a
  // logger.warn, so the winner returns 200 over a half-finalized checkout and
  // NOTHING ever retries it. That is the state the loser walks into.
  let breakCascade = true;
  const origResvUpdate = prisma.reservation.update;
  prisma.reservation.update = async (args) => {
    if (breakCascade) throw new Error('injected half-way cascade failure');
    return origResvUpdate(args);
  };
  restore.push(() => { prisma.reservation.update = origResvUpdate; });

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
