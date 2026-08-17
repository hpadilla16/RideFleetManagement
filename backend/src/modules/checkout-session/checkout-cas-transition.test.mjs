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
 *   7. what H8 does NOT close: the `events` lost-update against every OTHER
 *      writer of that TEXT column. Pinned on purpose so the honesty is
 *      executable and the day someone closes it, this test tells them.
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

function matches(row, where) {
  return Object.entries(where || {}).every(([key, val]) => {
    if (val === undefined) return true;
    if (val === null) return row[key] == null;
    if (val instanceof Date || typeof val !== 'object') return row[key] === val;
    return true; // ignore operator objects — not needed by these paths
  });
}

function stub(rows) {
  return {
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
  db = { checkoutSessions: [], agreements: [], reservations: [] };
  Object.assign(prisma.checkoutSession, stub(() => db.checkoutSessions));
  Object.assign(prisma.rentalAgreement, stub(() => db.agreements));
  Object.assign(prisma.reservation, stub(() => db.reservations));
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

test('idempotent answer appends nothing and never re-runs the CLOSED cascade', async () => {
  const row = seedSession({
    currentStep: 'FINALIZING', customerSignedAt: new Date(), agreementId: 'ra1',
  });
  db.agreements.push({ id: 'ra1', reservationId: 'res1' });

  // Anyone reaching the finalize cascade has to read the reservation first.
  let reservationReads = 0;
  const origResv = prisma.reservation.findUnique;
  prisma.reservation.findUnique = async (args) => { reservationReads += 1; return origResv(args); };
  restore.push(() => { prisma.reservation.findUnique = origResv; });

  armRace('FINALIZING', () => viaKiosk({ id: 'cs1', toStep: 'CLOSED' }));
  const cascadeAfterWinner = () => reservationReads;

  const out = await viaWebWizard({ id: 'cs1', toStep: 'CLOSED' });
  const readsAfterBoth = reservationReads;

  assert.equal(out.currentStep, 'CLOSED');
  assert.equal(readEvents(row.events).filter((e) => e.kind === 'TRANSITION').length, 1);
  assert.equal(row.stateVersion, 1, 'the no-op did not bump the version');
  assert.ok(
    readsAfterBoth === cascadeAfterWinner(),
    'the idempotent answer returned BEFORE the finalize cascade — it ran once, for the winner',
  );
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

// ── 7. what H8 does NOT close ──────────────────────────────────────────────

test('RESIDUAL: a concurrent stampSideEffect still eats the TRANSITION event', async () => {
  const row = seedSession({ currentStep: 'TC_PENDING', tcCompletedAt: new Date() });

  // Same TEXT column, opposite order: the STAMP reads events, a transition
  // commits, then the stamp writes the string it computed before that. H8
  // guards transition-vs-transition (both move currentStep, so the CAS
  // serialises them). It cannot guard transition-vs-anything-else: a stamp
  // has no step to compare against — see the note on stampSideEffect.
  //
  // If this test ever fails, the lost-update was closed for real (row locking
  // or events moved off TEXT). Delete it and update M2-PLAN — do not "fix" it.
  armRace('TC_PENDING', () => viaKiosk({ id: 'cs1', toStep: 'TC_SIGNED' }));

  await checkoutSessionService.stampSideEffect({ id: 'cs1', field: 'paymentCompletedAt' });

  const kinds = readEvents(row.events).map((e) => e.kind);
  assert.deepEqual(kinds, ['SIDE_EFFECT'], 'the TRANSITION entry is gone — still lost');
  assert.equal(row.currentStep, 'TC_SIGNED', 'the STEP itself survived; only the log entry was lost');
  assert.equal(row.stateVersion, 2, 'both version bumps survived (increment is atomic)');
});
