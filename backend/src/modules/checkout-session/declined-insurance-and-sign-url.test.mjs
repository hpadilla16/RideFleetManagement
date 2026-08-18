/**
 * Three guards around the declined-insurance flag and the T&C signing link.
 *
 * DB-FREE by design: these stub the prisma singleton's methods the same way
 * terms-signing.test.mjs does, so the suite runs in the `npm test` chain on a
 * laptop with no reachable Postgres (CI points DATABASE_URL at ci_unit_only).
 * The real round-trip against Postgres lives in the companion suite
 * src/modules/reservations/declined-insurance-getbyid.embedded.test.mjs.
 *
 * Run: node --test --test-force-exit \
 *        src/modules/checkout-session/declined-insurance-and-sign-url.test.mjs
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { checkoutSessionService } from './checkout-session.service.js';
import { assertInsuranceSelectionEditable, messageFor, INSURANCE_LOCK } from './insurance-selection-gate.js';
import { reservationsService } from '../reservations/reservations.service.js';
import { readEvents } from './state-machine.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const FUTURE = new Date(Date.now() + 15 * 60_000);

// ---------------------------------------------------------------------------
// MC-1 — reservationsService.getById must ASK for declinedInsurance.
//
// The bug was invisible to every stub-level test because it lived in the shape
// of the Prisma query, not in the code around it: getById's explicit
// rentalAgreement `select` simply had no declinedInsurance line, so Prisma
// returned the field as undefined and the wizard's `!!undefined` rendered the
// switch OFF for a customer who HAD declined. Asserting on the args getById
// hands to Prisma is the DB-free way to pin that down.
// ---------------------------------------------------------------------------

test('getById asks Prisma for rentalAgreement.declinedInsurance', async () => {
  const realFindFirst = prisma.reservation.findFirst;
  let captured = null;
  prisma.reservation.findFirst = async (args) => {
    captured = args;
    return { id: 'r1', customer: null, rentalAgreement: null };
  };
  try {
    await reservationsService.getById('r1', {});
  } finally {
    prisma.reservation.findFirst = realFindFirst;
  }

  const agSelect = captured?.include?.rentalAgreement?.select;
  assert.ok(agSelect, 'getById should use an explicit rentalAgreement select');
  assert.equal(
    agSelect.declinedInsurance, true,
    'declinedInsurance must be selected — without it the field arrives undefined '
    + 'and the checkout wizard seeds its decline switch to OFF regardless of what is stored',
  );
});

// ---------------------------------------------------------------------------
// MC-2 — setDeclinedInsurance step guard.
// ---------------------------------------------------------------------------

let session;
let agreement;
let agreementUpdates;
let sessionUpdates;
let liveToken;
let existingInitial;
let writeCount;

const STUBBED = [
  'checkoutSession.findUnique', 'checkoutSession.update',
  'handoffToken.findFirst', 'handoffToken.create',
  'agreementSectionInitial.findFirst',
  'rentalAgreement.findUnique', 'rentalAgreement.update', 'rentalAgreement.updateMany',
];
const realFns = {};

beforeEach(() => {
  session = {
    id: 's1',
    reservationId: 'r1',
    agreementId: 'a1',
    events: '[]',
    tcCompletedAt: null,
  };
  // The agreement is the document of record the gate reads first.
  agreement = {
    id: 'a1', reservationId: 'r1', tcSignedAt: null, declinedInsurance: false,
  };
  agreementUpdates = [];
  sessionUpdates = [];
  writeCount = 1;          // rows matched by the optimistic-guard updateMany
  liveToken = null;        // handoffToken.findFirst result
  existingInitial = null;  // agreementSectionInitial.findFirst result

  for (const key of STUBBED) {
    const [model, fn] = key.split('.');
    realFns[key] = prisma[model][fn];
  }

  prisma.checkoutSession.findUnique = async () => session;
  prisma.checkoutSession.update = async (op) => { sessionUpdates.push(op); return { ...session, ...op.data }; };
  prisma.handoffToken.findFirst = async () => liveToken;
  prisma.agreementSectionInitial.findFirst = async () => existingInitial;
  prisma.rentalAgreement.findUnique = async () => agreement;
  prisma.rentalAgreement.update = async (op) => { agreementUpdates.push(op); return {}; };
  // The agent write is an updateMany carrying `tcSignedAt: null` in its WHERE —
  // the optimistic guard. `writeCount` stands in for what that predicate would
  // match, so a test can simulate the signature landing mid-request.
  prisma.rentalAgreement.updateMany = async (op) => {
    agreementUpdates.push(op);
    return { count: writeCount };
  };
});

afterEach(() => {
  for (const key of Object.keys(realFns)) {
    const [model, fn] = key.split('.');
    prisma[model][fn] = realFns[key];
  }
});

test('setDeclinedInsurance writes the flag when nothing is signed or in flight', async () => {
  await checkoutSessionService.setDeclinedInsurance({ id: 's1', declined: true, actorUserId: 'u1' });
  assert.equal(agreementUpdates.length, 1);
  assert.deepEqual(agreementUpdates[0].data, { declinedInsurance: true });
  const events = readEvents(sessionUpdates[0].data.events);
  assert.equal(events.at(-1).kind, 'DECLINED_INSURANCE');
  assert.equal(events.at(-1).declined, true);
});

test('refuses with TC_ALREADY_COMPLETED once the customer has signed', async () => {
  session.tcCompletedAt = new Date();
  await assert.rejects(
    () => checkoutSessionService.setDeclinedInsurance({ id: 's1', declined: true }),
    (err) => {
      assert.equal(err.status, 409);
      // A bare 409 with no code is unactionable for the caller — the agent UI
      // has to tell "already signed" apart from "signing right now".
      assert.equal(err.code, 'TC_ALREADY_COMPLETED');
      return true;
    },
  );
  assert.equal(agreementUpdates.length, 0, 'must not touch the agreement');
  assert.equal(sessionUpdates.length, 0, 'must not log an event either');
});

test('refuses with TC_SIGNING_IN_PROGRESS while a live token has initials against it', async () => {
  // This is the window the guard exists for: tcCompletedAt is still null
  // (it is only stamped inside complete()), yet the customer is on the signing
  // page with ink already down. Flipping the flag here changes `expected`
  // between loadSession and complete, and complete() answers the CUSTOMER with
  // 400 INITIALS_INCOMPLETE for a signature they have already drawn.
  liveToken = { id: 't1' };
  existingInitial = { id: 'i1' };
  await assert.rejects(
    () => checkoutSessionService.setDeclinedInsurance({ id: 's1', declined: true }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'TC_SIGNING_IN_PROGRESS');
      return true;
    },
  );
  assert.equal(agreementUpdates.length, 0);
});

test('ALLOWS the correction when the token is minted but untouched', async () => {
  // Deliberate: the agent who realises the mistake right after handing over
  // the QR is doing something legitimate, and the customer's next page load
  // picks up the new section set on its own. Closing this too would trap a
  // real correction for no safety gain.
  liveToken = { id: 't1' };
  existingInitial = null;
  await checkoutSessionService.setDeclinedInsurance({ id: 's1', declined: true });
  assert.equal(agreementUpdates.length, 1);
  assert.deepEqual(agreementUpdates[0].data, { declinedInsurance: true });
});

test('ALLOWS the correction when no signing token is live, even with old initials', async () => {
  // Expired/consumed token: a fresh loadSession recomputes the section set
  // from the current flag, so there is no stale `expected` to desync.
  liveToken = null;
  existingInitial = { id: 'i1' };
  agreement.declinedInsurance = true; // so `declined: false` is a real flip
  await checkoutSessionService.setDeclinedInsurance({ id: 's1', declined: false });
  assert.equal(agreementUpdates.length, 1);
  assert.deepEqual(agreementUpdates[0].data, { declinedInsurance: false });
});

// ---------------------------------------------------------------------------
// The shared gate: writer-agnostic behaviour that both surfaces depend on.
// ---------------------------------------------------------------------------

test('a write that does not FLIP the flag is not locked, but reports signed', async () => {
  // Asserted at the gate, because this rule exists for the PORTAL: without it a
  // customer who declined earlier and re-submits pre-check-in to fix an address
  // would be refused over a field they never touched. `signed` still comes back
  // true so the caller knows to leave the decline-signature columns alone.
  // (The agent path is stricter — see the optimistic-guard test below.)
  agreement.declinedInsurance = true;
  agreement.tcSignedAt = new Date();
  const verdict = await assertInsuranceSelectionEditable({
    agreementId: 'a1', reservationId: 'r1', nextValue: true,
  });
  assert.equal(verdict.locked, false, 'no-op write must not be locked');
  assert.equal(verdict.signed, true, 'caller must still learn the contract is sealed');
});

test('the agent write is an updateMany fenced on tcSignedAt: null', async () => {
  await checkoutSessionService.setDeclinedInsurance({ id: 's1', declined: true });
  const op = agreementUpdates[0];
  assert.deepEqual(op.where, { id: 'a1', tcSignedAt: null },
    'the WHERE must carry the fence, or the check-then-act window stays open');
});

test('optimistic guard: a signature landing mid-request refuses the write', async () => {
  // The gate passes (nothing is signed when it reads), then the customer
  // completes signing before the UPDATE lands. The fence makes the database
  // settle it: zero rows matched, so nobody wrote and the agent is told why.
  writeCount = 0;
  await assert.rejects(
    () => checkoutSessionService.setDeclinedInsurance({ id: 's1', declined: true }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, INSURANCE_LOCK.SIGNED);
      return true;
    },
  );
  assert.equal(sessionUpdates.length, 0, 'no DECLINED_INSURANCE event for a write that did not happen');
});

test('the gate accepts an injected client (transaction handle)', async () => {
  // Without this, a writer that later moves into $transaction would have the
  // gate reading OUTSIDE the transaction and the check-then-act go invisible.
  const calls = [];
  const tx = {
    rentalAgreement: { findUnique: async () => { calls.push('agreement'); return agreement; } },
    checkoutSession: { findUnique: async () => { calls.push('session'); return null; } },
    handoffToken: { findFirst: async () => { calls.push('token'); return null; } },
    agreementSectionInitial: { findFirst: async () => null },
  };
  prisma.rentalAgreement.findUnique = async () => { throw new Error('gate must not touch the global client'); };
  const verdict = await assertInsuranceSelectionEditable({
    agreementId: 'a1', reservationId: 'r1', nextValue: true, client: tx,
  });
  assert.equal(verdict.locked, false);
  assert.deepEqual(calls, ['agreement', 'session', 'token']);
});

test('agreement.tcSignedAt locks the flag even when NO checkout session exists', async () => {
  // The hole a session-only guard leaves: pre-check-in normally runs before any
  // CheckoutSession row is created, so keying solely on session.tcCompletedAt
  // would let the customer surface write straight through.
  agreement.tcSignedAt = new Date();
  session = null; // no session for this reservation
  await assert.rejects(
    () => assertInsuranceSelectionEditable({ agreementId: 'a1', reservationId: 'r1', nextValue: true }),
    (err) => err.status === 409 && err.code === INSURANCE_LOCK.SIGNED,
  );
});

test('the gate resolves the agreement from reservationId alone', async () => {
  // How the portal calls it — it has not looked the agreement up yet.
  let where = null;
  prisma.rentalAgreement.findUnique = async (op) => { where = op.where; return agreement; };
  agreement.tcSignedAt = new Date();
  await assert.rejects(
    () => assertInsuranceSelectionEditable({ reservationId: 'r1', nextValue: true }),
    (err) => err.code === INSURANCE_LOCK.SIGNED,
  );
  assert.deepEqual(where, { reservationId: 'r1' });
});

test('the gate is a no-op when there is no agreement at all', async () => {
  prisma.rentalAgreement.findUnique = async () => null;
  await assertInsuranceSelectionEditable({ reservationId: 'r1', nextValue: true });
});

test('customer wording differs from staff wording for the same code', async () => {
  // Same machine code across surfaces (one rule, one vocabulary); different
  // sentence, because nobody is standing next to the customer to interpret it.
  const staff = messageFor(INSURANCE_LOCK.SIGNED, 'staff');
  const customer = messageFor(INSURANCE_LOCK.SIGNED, 'customer');
  assert.notEqual(staff, customer);
  assert.match(customer, /counter/i, 'customer copy must say what to do next');
  // No internal vocabulary leaking into customer-facing copy.
  for (const jargon of ['Terms & Conditions can no longer be changed here', 'session', 'flag', '409']) {
    assert.ok(!customer.includes(jargon), `customer copy leaks "${jargon}"`);
  }
});

test('the guard only counts TERMS_SIGNING tokens that are unconsumed and unexpired', async () => {
  let where = null;
  prisma.handoffToken.findFirst = async (op) => { where = op.where; return null; };
  await checkoutSessionService.setDeclinedInsurance({ id: 's1', declined: true });
  assert.equal(where.kind, 'TERMS_SIGNING');
  assert.equal(where.reservationId, 'r1');
  assert.equal(where.consumedAt, null);
  assert.ok(where.expiresAt?.gt instanceof Date, 'must filter out expired tokens');
});

// ---------------------------------------------------------------------------
// P5 — mintHandoffToken returns the absolute signing URL.
// ---------------------------------------------------------------------------

const BASE_VARS = ['APP_BASE_URL', 'FRONTEND_BASE_URL', 'CUSTOMER_PORTAL_BASE_URL'];

function withBaseEnv(vars, fn) {
  const saved = Object.fromEntries(BASE_VARS.map((k) => [k, process.env[k]]));
  for (const k of BASE_VARS) delete process.env[k];
  Object.assign(process.env, vars);
  return (async () => {
    try { return await fn(); } finally {
      for (const k of BASE_VARS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  })();
}

function stubFreshMint() {
  prisma.handoffToken.findFirst = async () => null; // no reusable token
  prisma.handoffToken.create = async ({ data }) => ({ id: 'tok-row', ...data });
}

test('terms-token mint returns an absolute signUrl alongside the existing fields', async () => {
  stubFreshMint();
  const out = await withBaseEnv({ APP_BASE_URL: 'https://ops.example.com' }, () =>
    checkoutSessionService.mintHandoffToken({ sessionId: 's1', kind: 'TERMS_SIGNING' }));

  assert.equal(out.signUrl, `https://ops.example.com/sign/${out.token}`);
  // Additive: the pre-existing contract must be untouched so old clients
  // (and the web wizard, which this branch does not change) keep working.
  assert.ok(out.token);
  assert.ok(out.expiresAt instanceof Date);
  assert.equal(out.kind, 'TERMS_SIGNING');
});

test('the reused-token path returns signUrl too', async () => {
  // mintHandoffToken is idempotent inside the TTL window and returns early.
  // That second return statement is easy to forget and would hand RideOps an
  // undefined URL for exactly the tokens it reuses most.
  prisma.handoffToken.findFirst = async () => ({
    token: 'REUSED', expiresAt: FUTURE, kind: 'TERMS_SIGNING', consumedAt: null,
  });
  const out = await withBaseEnv({ APP_BASE_URL: 'https://ops.example.com' }, () =>
    checkoutSessionService.mintHandoffToken({ sessionId: 's1', kind: 'TERMS_SIGNING' }));
  assert.equal(out.reused, true);
  assert.equal(out.signUrl, 'https://ops.example.com/sign/REUSED');
});

test('signUrl prefers the app origin over CUSTOMER_PORTAL_BASE_URL', async () => {
  // /sign/[token] is served by the MAIN Next app, not the customer portal. If
  // a tenant ever splits the portal onto its own host, taking the portal var
  // first would point customers at a deployment with no /sign route.
  stubFreshMint();
  const out = await withBaseEnv({
    APP_BASE_URL: 'https://ops.example.com',
    CUSTOMER_PORTAL_BASE_URL: 'https://portal.example.com',
  }, () => checkoutSessionService.mintHandoffToken({ sessionId: 's1', kind: 'TERMS_SIGNING' }));
  assert.ok(out.signUrl.startsWith('https://ops.example.com/sign/'));
});

test('signUrl falls back to FRONTEND_BASE_URL then CUSTOMER_PORTAL_BASE_URL', async () => {
  stubFreshMint();
  const viaFrontend = await withBaseEnv({
    FRONTEND_BASE_URL: 'https://front.example.com',
    CUSTOMER_PORTAL_BASE_URL: 'https://portal.example.com',
  }, () => checkoutSessionService.mintHandoffToken({ sessionId: 's1', kind: 'TERMS_SIGNING' }));
  assert.ok(viaFrontend.signUrl.startsWith('https://front.example.com/sign/'));

  // Most tenants today set only the portal var; it must still yield a usable
  // link rather than localhost.
  const viaPortal = await withBaseEnv({
    CUSTOMER_PORTAL_BASE_URL: 'https://portal.example.com',
  }, () => checkoutSessionService.mintHandoffToken({ sessionId: 's1', kind: 'TERMS_SIGNING' }));
  assert.ok(viaPortal.signUrl.startsWith('https://portal.example.com/sign/'));
});

test('signUrl tolerates a trailing slash on the configured base', async () => {
  stubFreshMint();
  const out = await withBaseEnv({ APP_BASE_URL: 'https://ops.example.com/' }, () =>
    checkoutSessionService.mintHandoffToken({ sessionId: 's1', kind: 'TERMS_SIGNING' }));
  assert.ok(!out.signUrl.includes('//sign/'), 'must not double the slash');
  assert.equal(out.signUrl, `https://ops.example.com/sign/${out.token}`);
});

test('non-signing kinds get signUrl null rather than a guessed path', async () => {
  // MOBILE_INSPECTION is exchanged through /api/public/checkout-handoff and no
  // frontend builds a URL from its token; CUSTOMER_INSPECTION already gets its
  // /inspect/:token link from customer-inspection.service.js. Emitting a
  // fabricated path for either would be worse than emitting nothing.
  stubFreshMint();
  const out = await withBaseEnv({ APP_BASE_URL: 'https://ops.example.com' }, () =>
    checkoutSessionService.mintHandoffToken({ sessionId: 's1', kind: 'MOBILE_INSPECTION' }));
  assert.equal(out.signUrl, null);
  assert.equal(out.kind, 'MOBILE_INSPECTION');
});

// ---------------------------------------------------------------------------
// Writer ratchet.
// ---------------------------------------------------------------------------

test('the set of files naming declinedInsurance is a ratchet', () => {
  // The gate's header carries a writer inventory, and a comment cannot keep
  // itself honest — the whole premise of that module is that a rule enforced on
  // SOME writers is not a control. This fails the build when a file starts
  // touching the column, so whoever adds it has to decide whether it is a
  // reader (add it here) or a writer (route it through the gate first).
  //
  // Deliberately matches READS as well as writes: telling them apart from text
  // is unreliable (`declinedInsurance: true` is both a select and a write), and
  // a ratchet that under-matches is the failure mode being guarded against.
  const KNOWN = new Set([
    // Writers — both go through assertInsuranceSelectionEditable().
    'src/modules/checkout-session/checkout-session.service.js',
    'src/modules/customer-portal/customer-portal.routes.js',
    // Route comment only.
    'src/modules/checkout-session/checkout-session.routes.js',
    // The gate itself.
    'src/modules/checkout-session/insurance-selection-gate.js',
    // Readers.
    'src/modules/checkout-session/terms-content.js',
    'src/modules/checkout-session/terms-signing.service.js',
    'src/modules/kiosk/kiosk-checkout.service.js',
    'src/modules/rental-agreements/rental-agreements.service.js',
    'src/modules/reservations/reservations.service.js',
    // Tests.
    // Never touches the column: passes the name to the pure sectionsForAgreement()
    // to derive MAX_SECTIONS. Listed because the ratchet matches on the NAME.
    'src/modules/checkout-session/terms-signing.routes.test.mjs',
    'src/modules/checkout-session/declined-insurance-and-sign-url.test.mjs',
    'src/modules/checkout-session/terms-section-overrides.test.mjs',
    'src/modules/checkout-session/terms-signing.test.mjs',
    'src/modules/customer-portal/precheckin-insurance-gate.test.mjs',
    'src/modules/kiosk/kiosk-checkout.test.mjs',
    'src/modules/kiosk/kiosk-staff-assist.test.mjs',
    'src/modules/reservations/declined-insurance-getbyid.embedded.test.mjs',
  ]);

  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      if (readFileSync(p, 'utf8').includes('declinedInsurance')) {
        found.push(p.split(sep).join('/'));
      }
    }
  };
  walk('src');

  const added = found.filter((f) => !KNOWN.has(f)).sort();
  assert.deepEqual(added, [], `File(s) now touching declinedInsurance — classify them in insurance-selection-gate.js's inventory, and route any WRITER through the gate: ${added.join(', ')}`);

  const stale = [...KNOWN].filter((f) => !found.includes(f)).sort();
  assert.deepEqual(stale, [], `Inventory entries that no longer touch the column — delete them: ${stale.join(', ')}`);
});
