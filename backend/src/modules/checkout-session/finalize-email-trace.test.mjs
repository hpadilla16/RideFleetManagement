/**
 * The finalize auto-email must never lie about itself.
 *
 * WHAT WENT WRONG (verified against production, 2026-08-18): 33 closed
 * checkouts across two tenants carried autoEmailedAt — the marker the kiosk
 * summary reads as `contractEmail.sent` — while no mail had ever been sent.
 * 28 in one tenant since 2026-06-09, 5 in another since 2026-08-10. The
 * marker was stamped BEFORE the send was attempted, and the scheduler was
 * called with neither `await` nor `.catch()`, so a rejection went nowhere:
 * no log, no alarm, no way to find the rows short of hand-joining AuditLog.
 *
 * The stamp cannot just move after the send — it IS the mutual exclusion
 * against two concurrent transitions mailing the contract twice. So the
 * three properties under test here are the ones that have to hold together:
 *
 *   (a) the customer never gets the contract twice
 *   (b) a stamped row really means the send was accepted
 *   (c) a failure is written somewhere findable
 *
 * WHY THESE FIXTURES LOOK LIKE THIS. maybeSendFinalizeEmail has two early
 * returns before the line under test (no agreementId, already stamped). A
 * suite whose fixture trips one of them passes while testing nothing, so the
 * fake store below RECORDS every claim attempt and every value the marker
 * ever held, and the tests assert on that history — a test that never
 * reached the compare-and-set fails loudly instead of quietly.
 *
 * The real rentalAgreementsService.scheduleEmailDelivery runs in every test
 * here; only its terminal `emailAgreement` (Puppeteer + SMTP) is stubbed.
 * That is deliberate: the failure this suite exists for lives in WHERE that
 * function rejects — before the background job starts, so its own audit
 * catch never runs — and a hand-written fake of it would have been free to
 * be wrong about exactly that.
 *
 * Run: node --test src/modules/checkout-session/finalize-email-trace.test.mjs
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { rentalAgreementsService } from '../rental-agreements/rental-agreements.service.js';
import { maybeSendFinalizeEmail } from './checkout-session.service.js';

// setImmediate callbacks (scheduleEmailDelivery's background job) plus the
// microtasks its chained .then/.catch schedule. Same helper, same reason, as
// rental-agreements-email-async.test.mjs.
async function drainEventLoop(ticks = 5) {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
}

const SESSION = {
  id: 'cs-finalize-1',
  agreementId: 'ag-1',
  reservationId: 'res-1',
  tenantId: 'ten-1',
  autoEmailedAt: null,
};

let store;            // { [id]: Date|null } — the CheckoutSession.autoEmailedAt column
let claimAttempts;    // every updateMany aimed at autoEmailedAt: null
let markerHistory;    // every value the marker was set to, in order
let audits;           // prisma.auditLog.create payloads
let scheduleCalls;    // scheduleEmailDelivery invocations
let emailAttempts;    // background emailAgreement invocations (= real mails)
let agreementRow;     // what the tenant-filtered findFirst returns

const saved = {};

function installPrismaFakes() {
  saved.updateMany = prisma.checkoutSession.updateMany;
  saved.auditCreate = prisma.auditLog.create;
  saved.findFirst = prisma.rentalAgreement.findFirst;
  saved.emailAgreement = rentalAgreementsService.emailAgreement;
  saved.scheduleEmailDelivery = rentalAgreementsService.scheduleEmailDelivery;

  // A single-statement `UPDATE ... WHERE autoEmailedAt IS NULL` is atomic in
  // Postgres, so this mock is atomic too: no await between the read and the
  // write. Faking it as non-atomic would test a database we do not run.
  prisma.checkoutSession.updateMany = async ({ where, data }) => {
    const current = store[where.id] ?? null;
    const wants = where.autoEmailedAt;
    if (wants === null) claimAttempts.push(where.id);
    const matches = wants === null
      ? current === null
      : current !== null && current.getTime() === wants.getTime();
    if (!matches) return { count: 0 };
    store[where.id] = data.autoEmailedAt;
    markerHistory.push(data.autoEmailedAt);
    return { count: 1 };
  };

  prisma.auditLog.create = async ({ data }) => { audits.push(data); return { id: `al-${audits.length}` }; };

  // scheduleEmailDelivery's default findAgreement dep. Returning a row with
  // no reachable email is what makes the REAL function reject before it ever
  // schedules the background job.
  prisma.rentalAgreement.findFirst = async () => agreementRow;

  rentalAgreementsService.emailAgreement = async () => {
    emailAttempts.push(Date.now());
    return { ok: true, to: 'renter@example.com' };
  };

  // Spy that DELEGATES: the production code path stays the real one, we only
  // count trips through it.
  rentalAgreementsService.scheduleEmailDelivery = function spy(...args) {
    scheduleCalls.push(args);
    return saved.scheduleEmailDelivery.apply(this, args);
  };
}

beforeEach(() => {
  store = { [SESSION.id]: null };
  claimAttempts = [];
  markerHistory = [];
  audits = [];
  scheduleCalls = [];
  emailAttempts = [];
  agreementRow = {
    reservationId: SESSION.reservationId,
    tenantId: SESSION.tenantId,
    customerEmail: 'renter@example.com',
    reservation: { customer: { email: 'renter@example.com' } },
  };
  installPrismaFakes();
});

afterEach(() => {
  prisma.checkoutSession.updateMany = saved.updateMany;
  prisma.auditLog.create = saved.auditCreate;
  prisma.rentalAgreement.findFirst = saved.findFirst;
  rentalAgreementsService.emailAgreement = saved.emailAgreement;
  rentalAgreementsService.scheduleEmailDelivery = saved.scheduleEmailDelivery;
});

// ---------------------------------------------------------------------------
// (b) + (c): a send that is never accepted leaves the row honest and a trace
// ---------------------------------------------------------------------------

test('agreement with no customer email: the row does NOT claim "sent", and the failure is audited', async () => {
  // The exact production sub-case behind 4 of the 5 rows in the newer tenant.
  // scheduleEmailDelivery rejects here BEFORE startJob, so its own background
  // audit catch never runs — nothing but this code writes the trace.
  agreementRow = {
    reservationId: SESSION.reservationId, tenantId: SESSION.tenantId,
    customerEmail: null, reservation: { customer: { email: null } },
  };

  // Rejects on purpose: the caller (transition()) is what logs it. The
  // cleanup this suite is about has already happened by then.
  await assert.rejects(() => maybeSendFinalizeEmail({ ...SESSION }, 'user-9'));
  await drainEventLoop();

  // Fixture reachability — without these, everything below is satisfiable by
  // a function that returned on line one.
  assert.equal(claimAttempts.length, 1, 'the compare-and-set must actually have been reached');
  assert.equal(scheduleCalls.length, 1, 'the send must actually have been attempted');
  assert.ok(markerHistory.some((v) => v instanceof Date), 'the marker must have been claimed before release');

  assert.equal(store[SESSION.id], null, 'autoEmailedAt must be released — no mail was ever queued');
  assert.equal(emailAttempts.length, 0, 'no background send should have started');

  assert.equal(audits.length, 1, 'the failure must be findable in AuditLog');
  const row = audits[0];
  assert.equal(row.reservationId, SESSION.reservationId, 'AuditLog.reservationId is NOT NULL in the schema');
  assert.equal(row.tenantId, SESSION.tenantId);
  assert.equal(row.actorUserId, 'user-9');
  assert.equal(row.action, 'UPDATE');
  // Same prefix scheduleEmailDelivery's own failure row uses, so ONE search
  // over AuditLog.reason finds both kinds of failure.
  assert.match(row.reason, /^Agreement email FAILED/);
  assert.match(row.reason, /Customer email is required/);
  assert.match(row.reason, new RegExp(SESSION.id));
});

test('a lookup that throws is released and audited too, not just the missing-email case', async () => {
  prisma.rentalAgreement.findFirst = async () => { throw new Error('connection terminated'); };

  await assert.rejects(() => maybeSendFinalizeEmail({ ...SESSION }, null));
  await drainEventLoop();

  assert.equal(claimAttempts.length, 1);
  assert.equal(store[SESSION.id], null, 'autoEmailedAt must be released');
  assert.equal(audits.length, 1);
  assert.match(audits[0].reason, /^Agreement email FAILED/);
  assert.match(audits[0].reason, /connection terminated/);
  assert.equal(audits[0].actorUserId, null);
});

test('the release and the trace happen BEFORE the error is handed back to the caller', async () => {
  agreementRow = { reservationId: SESSION.reservationId, tenantId: SESSION.tenantId, customerEmail: null };
  // transition() detaches this call and catches, which is where the warn line
  // comes from. What must not happen is the throw jumping over the cleanup —
  // so the caller's view of the error is only allowed to exist once the row
  // has been released and the audit written.
  await assert.rejects(
    () => maybeSendFinalizeEmail({ ...SESSION }, 'user-1'),
    (err) => {
      assert.match(String(err?.message), /Customer email is required/);
      assert.equal(store[SESSION.id], null, 'released before the caller sees the error');
      assert.equal(audits.length, 1, 'audited before the caller sees the error');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (b): an accepted send stays stamped, and stays quiet
// ---------------------------------------------------------------------------

test('accepted send: the row keeps its stamp and nothing is written to AuditLog', async () => {
  await maybeSendFinalizeEmail({ ...SESSION }, 'user-9');
  await drainEventLoop();

  assert.equal(claimAttempts.length, 1, 'the compare-and-set must actually have been reached');
  assert.ok(store[SESSION.id] instanceof Date, 'autoEmailedAt must remain stamped after an accepted send');
  assert.equal(emailAttempts.length, 1, 'the background send must have run');
  assert.deepEqual(audits, [], 'a successful send must leave no failure trace');
});

// ---------------------------------------------------------------------------
// (a): concurrency — the customer is never mailed twice
// ---------------------------------------------------------------------------

test('two concurrent finalize transitions produce exactly ONE send', async () => {
  await Promise.all([
    maybeSendFinalizeEmail({ ...SESSION }, 'user-a'),
    maybeSendFinalizeEmail({ ...SESSION }, 'user-b'),
  ]);
  await drainEventLoop();

  assert.equal(claimAttempts.length, 2, 'both callers must have raced for the claim, not returned early');
  assert.equal(scheduleCalls.length, 1, 'only the claim winner may schedule');
  assert.equal(emailAttempts.length, 1, 'the customer must receive the contract exactly once');
  assert.ok(store[SESSION.id] instanceof Date, 'the winner keeps the stamp');
  assert.deepEqual(audits, []);
});

test('the release retracts only OUR claim, never a stamp somebody else put there', async () => {
  // A release keyed on anything looser than "the exact timestamp I wrote"
  // would clear a marker that is legitimately held, and the next transition
  // would then be free to mail the contract a second time — trading this bug
  // for a worse one. Simulate a foreign re-stamp landing between our claim
  // and our failure.
  const foreignStamp = new Date('2026-09-01T00:00:00.000Z');
  prisma.rentalAgreement.findFirst = async () => {
    store[SESSION.id] = foreignStamp;
    throw new Error('boom');
  };

  await assert.rejects(() => maybeSendFinalizeEmail({ ...SESSION }, 'user-a'));
  await drainEventLoop();

  assert.equal(claimAttempts.length, 1, 'we did claim first');
  assert.equal(store[SESSION.id], foreignStamp, 'the foreign stamp survives our release');
  assert.equal(audits.length, 1, 'the failure is still traced even when the release cannot apply');
});

// ---------------------------------------------------------------------------
// The guards that were already there, still there
// ---------------------------------------------------------------------------

test('an already-stamped session is not re-sent and not re-claimed', async () => {
  const stampedAt = new Date('2026-06-09T12:00:00.000Z');
  store[SESSION.id] = stampedAt;

  await maybeSendFinalizeEmail({ ...SESSION, autoEmailedAt: stampedAt }, 'user-9');
  await drainEventLoop();

  assert.deepEqual(claimAttempts, [], 'no second claim');
  assert.deepEqual(scheduleCalls, [], 'no second send');
  assert.equal(store[SESSION.id], stampedAt, 'the original stamp is untouched');
  assert.deepEqual(audits, []);
});

test('a session with no agreement never claims and never sends', async () => {
  await maybeSendFinalizeEmail({ ...SESSION, agreementId: null }, 'user-9');
  await drainEventLoop();

  assert.deepEqual(claimAttempts, []);
  assert.deepEqual(scheduleCalls, []);
  assert.equal(store[SESSION.id], null);
  assert.deepEqual(audits, []);
});
