/**
 * Ride Kiosk — Fase B5 PHASE 1 tests (the defensive half, 2026-07-24).
 * Run: npm run test:kiosk  (node --test --test-force-exit)
 *
 * ⚠️ These cover ONLY the inert/defensive layer: guards, single-flight, intent
 * reuse, late-payment binding, the staff queue, and the P2002 collapse. There
 * is deliberately NO gateway code to test — the iPOS/HPP layer is blocked on
 * rep answers.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { KioskError } from './kiosk-device.service.js';
import {
  assertKioskPaymentAllowed,
  withKioskPaymentGuard,
  isKioskPaymentDryRun,
  kioskPaymentMaxAmount,
  DEFAULT_MAX_AMOUNT,
} from './kiosk-payment-guards.js';
import {
  kioskPaymentIntentService,
  generateIntentRef,
  PAYMENT_REFERENCE_PREFIX,
} from './kiosk-payment-intent.service.js';
import { paymentOpsQueue } from '../payment-gateway/payment-ops-queue.service.js';
import { singleFlight, singleFlightSize } from '../../lib/single-flight.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let db;

function matches(row, where) {
  return Object.entries(where || {}).every(([key, val]) => {
    if (val === undefined) return true;
    if (key === 'OR') return val.some((c) => matches(row, c));
    if (val === null) return row[key] == null;
    if (val && typeof val === 'object' && !(val instanceof Date)) {
      if ('not' in val) return val.not === null ? row[key] != null : row[key] !== val.not;
      if ('in' in val) return val.in.includes(row[key]);
      if ('has' in val) return Array.isArray(row[key]) && row[key].includes(val.has);
      if ('gt' in val) return row[key] != null && row[key] > val.gt;
      if ('gte' in val) return row[key] != null && row[key] >= val.gte;
      if ('lt' in val) return row[key] != null && row[key] < val.lt;
      if ('lte' in val) return row[key] != null && row[key] <= val.lte;
      // 2026-08-17: was `return true`, i.e. "any operator I don't model
      // matches". In a PAYMENTS suite that means a guard the database would
      // refuse reads here as satisfied. Fail loudly instead — an unmodelled
      // operator is a gap in the stub, not a pass.
      throw new Error(`stub matcher: unmodelled operator on "${key}": ${JSON.stringify(val)}`);
    }
    return row[key] === val;
  });
}

function delegateStub(rows) {
  let seq = 0;
  return {
    findFirst: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findUnique: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findMany: async ({ where, take } = {}) => {
      const out = rows().filter((r) => matches(r, where));
      return typeof take === 'number' ? out.slice(0, take) : out;
    },
    count: async ({ where } = {}) => rows().filter((r) => matches(r, where)).length,
    create: async ({ data } = {}) => {
      const row = { id: `row_${++seq}`, createdAt: new Date(), ...data };
      rows().push(row);
      return row;
    },
    updateMany: async ({ where, data } = {}) => {
      // Models the real semantics this code depends on: a CONDITIONAL write that
      // reports how many rows it actually claimed. Returning `{count}` is the
      // whole point — the intent mint decides the winner of a race from it, so a
      // stub that always claimed would prove the opposite of what the test says.
      const hit = rows().filter((r) => matches(r, where));
      for (const row of hit) {
        for (const [k, v] of Object.entries(data || {})) {
          if (v && typeof v === 'object' && !(v instanceof Date) && 'push' in v) {
            row[k] = [...(row[k] || []), ...[].concat(v.push)];
          } else {
            row[k] = v;
          }
        }
      }
      return { count: hit.length };
    },
    update: async ({ where, data } = {}) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error('stub update: no match');
      for (const [k, v] of Object.entries(data || {})) {
        if (v && typeof v === 'object' && !(v instanceof Date) && 'push' in v) {
          row[k] = [...(row[k] || []), ...[].concat(v.push)];
        } else {
          row[k] = v;
        }
      }
      return row;
    },
    groupBy: async ({ by, where } = {}) => {
      const key = (Array.isArray(by) ? by : [by])[0];
      const buckets = new Map();
      rows().filter((r) => matches(r, where)).forEach((r) => {
        buckets.set(r[key], (buckets.get(r[key]) || 0) + 1);
      });
      return [...buckets].map(([v, c]) => ({ [key]: v, _count: { _all: c } }));
    },
  };
}

const DEVICE = { id: 'dev1', tenantId: 't1', locationId: 'loc1', name: 'Lobby 1', walkupEnabled: true };

function installStubs() {
  db = { sessions: [], flags: [], payments: [] };
  Object.assign(prisma.kioskSession, delegateStub(() => db.sessions));
  Object.assign(prisma.paymentOpsFlag, delegateStub(() => db.flags));
  Object.assign(prisma.reservationPayment, delegateStub(() => db.payments));
}

function seedSession(overrides = {}) {
  const s = {
    id: 'ks1', tenantId: 't1', deviceId: 'dev1', kind: 'PICKUP',
    reservationId: 'res1', outcome: 'IN_PROGRESS', endedAt: null,
    paymentIntentRef: null, paymentIntentState: null, paymentIntentCreatedAt: null,
    paymentIntentPriorRefs: [],
    lastActivityAt: new Date(), eventsJson: [],
    ...overrides,
  };
  db.sessions.push(s);
  return s;
}

const GUARD_ENV = [
  'KIOSK_PAYMENT_LIVE', 'KIOSK_PAYMENT_LIVE_ALLOW_PROD', 'KIOSK_PAYMENT_LIVE_UNTIL',
  'KIOSK_PAYMENT_MAX_AMOUNT', 'KIOSK_PAYMENT_RESERVATION_ALLOWLIST',
  'KIOSK_PAYMENT_DEVICE_ALLOWLIST', 'KIOSK_PAYMENT_LOCATION_ALLOWLIST',
  'KIOSK_PAYMENT_DRY_RUN', 'SPIN_DRY_RUN', 'IPOS_TRANSACT_DRY_RUN', 'NODE_ENV',
];
let savedEnv;

function armGuards() {
  process.env.KIOSK_PAYMENT_LIVE = 'true';
  process.env.KIOSK_PAYMENT_LIVE_UNTIL = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  process.env.KIOSK_PAYMENT_RESERVATION_ALLOWLIST = 'res1';
  process.env.KIOSK_PAYMENT_DEVICE_ALLOWLIST = 'dev1';
  process.env.KIOSK_PAYMENT_LOCATION_ALLOWLIST = 'loc1';
}
const OK_CTX = { amount: 1, reservationId: 'res1', deviceId: 'dev1', locationId: 'loc1' };

async function rejects(promise, { status, code, reason } = {}) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof KioskError, `expected KioskError, got ${err?.name}: ${err?.message}`);
    if (status) assert.equal(err.status, status);
    if (code) assert.equal(err.code, code);
    if (reason) assert.equal(err.details?.reason, reason);
    return err;
  }
  throw new Error('expected rejection, promise resolved');
}

beforeEach(() => {
  installStubs();
  savedEnv = Object.fromEntries(GUARD_ENV.map((k) => [k, process.env[k]]));
  GUARD_ENV.forEach((k) => delete process.env[k]);
});

function restoreEnv() {
  GUARD_ENV.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
}

// ---------------------------------------------------------------------------
// Guards (item 3)
// ---------------------------------------------------------------------------

test('guards: fail-closed by default — flag OFF blocks everything', async (t) => {
  t.after(restoreEnv);
  await rejects(
    Promise.resolve().then(() => assertKioskPaymentAllowed(OK_CTX)),
    { status: 403, code: 'KIOSK_PAYMENT_BLOCKED', reason: 'FLAG_OFF' },
  );
});

test('guards: every gate rejects independently with the flag ON', async (t) => {
  t.after(restoreEnv);
  armGuards();
  // baseline passes
  assert.deepEqual(assertKioskPaymentAllowed(OK_CTX), { allowed: true, dryRun: false, amount: 1 });

  const cases = [
    ['AMOUNT_OVER_CEILING', { ...OK_CTX, amount: 999 }],
    ['BAD_AMOUNT', { ...OK_CTX, amount: 0 }],
    ['RESERVATION_NOT_ALLOWLISTED', { ...OK_CTX, reservationId: 'resOTHER' }],
    ['DEVICE_NOT_ALLOWLISTED', { ...OK_CTX, deviceId: 'devOTHER' }],
    ['LOCATION_NOT_ALLOWLISTED', { ...OK_CTX, locationId: 'locOTHER' }],
  ];
  for (const [reason, ctx] of cases) {
    // eslint-disable-next-line no-await-in-loop
    await rejects(Promise.resolve().then(() => assertKioskPaymentAllowed(ctx)), { status: 403, reason });
  }

  // ceiling default is $5 and is enforced on the amount actually sent
  assert.equal(kioskPaymentMaxAmount(), DEFAULT_MAX_AMOUNT);
  process.env.KIOSK_PAYMENT_MAX_AMOUNT = '2';
  await rejects(
    Promise.resolve().then(() => assertKioskPaymentAllowed({ ...OK_CTX, amount: 3 })),
    { reason: 'AMOUNT_OVER_CEILING' },
  );
});

test('guards: auto-expiring flag — missing and past expiry both block', async (t) => {
  t.after(restoreEnv);
  armGuards();
  delete process.env.KIOSK_PAYMENT_LIVE_UNTIL;
  await rejects(Promise.resolve().then(() => assertKioskPaymentAllowed(OK_CTX)), { reason: 'NO_EXPIRY_SET' });

  process.env.KIOSK_PAYMENT_LIVE_UNTIL = new Date(Date.now() - 1000).toISOString();
  await rejects(Promise.resolve().then(() => assertKioskPaymentAllowed(OK_CTX)), { reason: 'WINDOW_EXPIRED' });
});

test('guards: production needs the double key (B3a pattern)', async (t) => {
  t.after(restoreEnv);
  armGuards();
  process.env.NODE_ENV = 'production';
  await rejects(
    Promise.resolve().then(() => assertKioskPaymentAllowed(OK_CTX)),
    { reason: 'PROD_DOUBLE_KEY_MISSING' },
  );
  process.env.KIOSK_PAYMENT_LIVE_ALLOW_PROD = 'true';
  assert.equal(assertKioskPaymentAllowed(OK_CTX).allowed, true);
});

test('withKioskPaymentGuard: the gateway callback is unreachable unless every guard passed', async (t) => {
  t.after(restoreEnv);
  let called = 0;
  const gatewayCall = async () => { called += 1; return { ok: true }; };

  // blocked → callback never runs
  await rejects(withKioskPaymentGuard(OK_CTX, gatewayCall), { reason: 'FLAG_OFF' });
  assert.equal(called, 0);

  // armed → callback runs
  armGuards();
  assert.deepEqual(await withKioskPaymentGuard(OK_CTX, gatewayCall), { ok: true });
  assert.equal(called, 1);
});

test('dry-run short-circuits: guards pass but the gateway callback is NOT invoked', async (t) => {
  t.after(restoreEnv);
  armGuards();
  let called = 0;
  for (const flag of ['KIOSK_PAYMENT_DRY_RUN', 'SPIN_DRY_RUN', 'IPOS_TRANSACT_DRY_RUN']) {
    process.env[flag] = 'true';
    assert.equal(isKioskPaymentDryRun(), true);
    // eslint-disable-next-line no-await-in-loop
    const out = await withKioskPaymentGuard(OK_CTX, async () => { called += 1; return { live: true }; });
    assert.deepEqual(out, { dryRun: true, skipped: true });
    delete process.env[flag];
  }
  assert.equal(called, 0, 'no gateway call in dry-run — CI can walk the state machine without money');
});

// ---------------------------------------------------------------------------
// Payment intent (item 4)
// ---------------------------------------------------------------------------

test('intent generator: strictly alphanumeric, <= 20 chars, no hyphens (the 904 lesson)', () => {
  for (let i = 0; i < 200; i += 1) {
    const ref = generateIntentRef('K', Date.now() + i);
    assert.ok(/^[A-Za-z0-9]+$/.test(ref), `non-alphanumeric ref: ${ref}`);
    assert.ok(!ref.includes('-'), `hyphen in ref: ${ref}`);
    assert.ok(ref.length > 0 && ref.length <= 20, `bad length: ${ref}`);
  }
  // a hyphen-bearing prefix is sanitized, never passed through
  assert.ok(!generateIntentRef('K-RA-').includes('-'));
});

test('intent generator: 500 refs, no collisions', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(generateIntentRef());
  assert.equal(seen.size, 500);
});

test('intent: one per session — a retry REUSES the ref, never mints a second', async () => {
  const session = seedSession();

  const first = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);
  assert.equal(first.reused, false);
  assert.equal(first.state, 'PENDING');
  assert.equal(first.reference, `${PAYMENT_REFERENCE_PREFIX}:${first.paymentIntentRef}`);
  assert.equal(session.paymentIntentRef, first.paymentIntentRef);

  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const retry = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);
    assert.equal(retry.reused, true);
    assert.equal(retry.paymentIntentRef, first.paymentIntentRef, 'never a second live intent');
  }
  assert.equal(db.sessions.length, 1);
});

test('intent: an already-PAID session refuses a new link; state transitions persist', async () => {
  seedSession();
  const { paymentIntentRef } = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);

  await kioskPaymentIntentService.setIntentState('ks1', DEVICE, 'PAID');
  assert.equal(db.sessions[0].paymentIntentState, 'PAID');
  await rejects(kioskPaymentIntentService.ensureIntent('ks1', DEVICE), { status: 409, code: 'INTENT_ALREADY_PAID' });

  // M4: TERMINAL is NOT a trapdoor — it supersedes and mints a payable ref,
  // retaining the dead one for late-payment binding.
  db.sessions[0].paymentIntentState = 'TERMINAL';
  const after = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);
  assert.notEqual(after.paymentIntentRef, paymentIntentRef);
  assert.equal(after.supersededRef, paymentIntentRef);
  assert.ok(db.sessions[0].paymentIntentPriorRefs.includes(paymentIntentRef));
});

test('intent: requires an attached reservation', async () => {
  seedSession({ reservationId: null });
  await rejects(kioskPaymentIntentService.ensureIntent('ks1', DEVICE), { status: 422, code: 'NO_RESERVATION_ATTACHED' });
});

// ---------------------------------------------------------------------------
// Late-payment binding (item 5)
// ---------------------------------------------------------------------------

test('late payment: the binding survives the session wipe and resolves the reservation', async () => {
  const session = seedSession();
  const { paymentIntentRef, reference } = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);

  // guest walks away; session completes/wipes hours later
  session.outcome = 'COMPLETED';
  session.endedAt = new Date();

  // the payment finally arrives — bare ref AND prefixed form both resolve
  for (const inbound of [paymentIntentRef, reference]) {
    // eslint-disable-next-line no-await-in-loop
    const bound = await kioskPaymentIntentService.resolveByReference(inbound);
    assert.equal(bound.reservationId, 'res1');
    assert.equal(bound.kioskSessionId, 'ks1');
    assert.equal(bound.tenantId, 't1');
    assert.equal(bound.sessionLive, false, 'session is gone — this is the §6A orphan case');
  }

  assert.equal(await kioskPaymentIntentService.resolveByReference('IPOS:NOSUCHREF'), null);
});

test('late payment: an orphan raises a staff-queue row bound to the reservation', async () => {
  const session = seedSession();
  const { reference } = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);
  session.outcome = 'ABANDONED';
  session.endedAt = new Date();

  const flag = await kioskPaymentIntentService.flagOrphanPayment({ reference, amount: 42.5 });
  assert.equal(flag.kind, 'ORPHAN_PAYMENT');
  assert.equal(flag.status, 'NOT_ATTEMPTED', 'no gateway call was attempted — that is Phase 2');
  assert.equal(flag.reservationId, 'res1');
  assert.equal(flag.kioskSessionId, 'ks1');
  assert.equal(flag.reference, reference);
  assert.equal(Number(flag.amount), 42.5);

  // a totally unknown reference still gets recorded when a tenant is supplied
  const unknown = await kioskPaymentIntentService.flagOrphanPayment({
    reference: 'IPOS:GHOST', tenantId: 't1',
  });
  assert.equal(unknown.reservationId, null);
  assert.match(unknown.note, /manual investigation/i);
});

// ---------------------------------------------------------------------------
// Staff queue (item 7)
// ---------------------------------------------------------------------------

test('staff queue: distinct states, idempotent raise, resolve, tenant-scoped list', async () => {
  const first = await paymentOpsQueue.raise({
    tenantId: 't1', kind: 'STRANDED_DEPOSIT_HOLD',
    rentalAgreementId: 'ra1', gatewayRef: 'RRN123', amount: 250,
    note: 'hold still live',
  });
  assert.equal(first.status, 'NOT_ATTEMPTED');
  assert.equal(first.attempts, 0);

  // re-running the sweep must NOT pile up duplicate rows for the same hold
  const again = await paymentOpsQueue.raise({
    tenantId: 't1', kind: 'STRANDED_DEPOSIT_HOLD', rentalAgreementId: 'ra1', gatewayRef: 'RRN123',
  });
  assert.equal(again.id, first.id);
  assert.equal(db.flags.length, 1);

  // "gateway call failed" is a DIFFERENT state from "not yet attempted"
  const failed = await paymentOpsQueue.raise({
    tenantId: 't1', kind: 'STRANDED_DEPOSIT_HOLD', rentalAgreementId: 'ra1', gatewayRef: 'RRN123',
    status: 'GATEWAY_FAILED', lastError: 'void rejected: already settled',
  });
  assert.equal(failed.id, first.id);
  assert.equal(failed.status, 'GATEWAY_FAILED');
  assert.equal(failed.attempts, 1);
  assert.match(failed.lastError, /already settled/);

  const listed = await paymentOpsQueue.list({ tenantId: 't1' });
  assert.equal(listed.flags.length, 1);
  assert.equal(listed.openCount, 1);

  const resolved = await paymentOpsQueue.resolve(first.id, { actorUserId: 'u1', note: 'released by hand' }, { tenantId: 't1' });
  assert.equal(resolved.status, 'RESOLVED');
  assert.ok(resolved.resolvedAt instanceof Date);
  assert.equal(resolved.resolvedByUserId, 'u1');

  // cross-tenant resolve is a 404
  await assert.rejects(
    paymentOpsQueue.resolve(first.id, {}, { tenantId: 't2' }),
    (e) => e.status === 404,
  );
  // unknown kind is rejected outright
  await assert.rejects(paymentOpsQueue.raise({ tenantId: 't1', kind: 'NONSENSE' }), /unknown payment ops kind/);
});

// ---------------------------------------------------------------------------
// Single-flight (item 2)
// ---------------------------------------------------------------------------

test('single-flight: concurrent verify→post on one reference runs ONCE, all callers share it', async () => {
  let executions = 0;
  const work = async () => {
    executions += 1;
    await new Promise((r) => setTimeout(r, 20));
    return `posted:${executions}`;
  };

  const results = await Promise.all(
    Array.from({ length: 8 }, () => singleFlight('IPOS:REF1', work)),
  );
  assert.equal(executions, 1, 'webhook + poll collapse onto a single execution');
  assert.deepEqual(new Set(results), new Set(['posted:1']));
  assert.equal(singleFlightSize(), 0, 'key released after settle');

  // a DIFFERENT reference is independent
  await Promise.all([singleFlight('IPOS:REF2', work), singleFlight('IPOS:REF3', work)]);
  assert.equal(executions, 3);

  // the key is re-armable after completion, and rejections propagate to all
  await assert.rejects(
    Promise.all([
      singleFlight('IPOS:BOOM', async () => { throw new Error('gateway down'); }),
      singleFlight('IPOS:BOOM', async () => { throw new Error('never runs'); }),
    ]),
    /gateway down/,
  );
  assert.equal(singleFlightSize(), 0);
});

// ---------------------------------------------------------------------------
// Review batch: M4 supersede lifecycle, R1 validated amount
// ---------------------------------------------------------------------------

test('M4: a TERMINAL intent is superseded, not a trapdoor — the guest can pay again', async () => {
  seedSession();
  const first = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);

  // the guest's card declines → the poll marks the intent TERMINAL
  await kioskPaymentIntentService.setIntentState('ks1', DEVICE, 'TERMINAL');

  const retry = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);
  assert.equal(retry.reused, false, 'a dead intent must not be handed back forever');
  assert.notEqual(retry.paymentIntentRef, first.paymentIntentRef);
  assert.equal(retry.state, 'PENDING');
  assert.equal(retry.supersededRef, first.paymentIntentRef);

  // the OLD ref is retained — a superseded iPOS link may still be payable
  assert.deepEqual(db.sessions[0].paymentIntentPriorRefs, [first.paymentIntentRef]);
});

test('M4: an explicit supersede retains the old ref and both refs still resolve', async () => {
  const session = seedSession();
  const first = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);
  const second = await kioskPaymentIntentService.supersedeIntent('ks1', DEVICE);

  assert.notEqual(second.paymentIntentRef, first.paymentIntentRef);
  assert.equal(session.paymentIntentRef, second.paymentIntentRef);
  assert.deepEqual(session.paymentIntentPriorRefs, [first.paymentIntentRef]);

  // the CURRENT ref resolves as live
  const live = await kioskPaymentIntentService.resolveByReference(second.reference);
  assert.equal(live.reservationId, 'res1');
  assert.equal(live.superseded, false);
  assert.equal(live.sessionLive, true);

  // the RETIRED ref still resolves — a guest paying the old QR is detected,
  // never orphaned (iPOS publishes no way to cancel an unpaid link)
  const retired = await kioskPaymentIntentService.resolveByReference(first.reference);
  assert.equal(retired.reservationId, 'res1');
  assert.equal(retired.kioskSessionId, 'ks1');
  assert.equal(retired.superseded, true);
  assert.equal(retired.matchedRef, first.paymentIntentRef);
  assert.equal(retired.sessionLive, false, 'a payment on a retired link is always staff-queue material');
});

test('M4: a payment on a superseded link raises an ORPHAN_PAYMENT flag naming the cause', async () => {
  seedSession();
  const first = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);
  await kioskPaymentIntentService.supersedeIntent('ks1', DEVICE);

  const flag = await kioskPaymentIntentService.flagOrphanPayment({ reference: first.reference, amount: 12 });
  assert.equal(flag.kind, 'ORPHAN_PAYMENT');
  assert.equal(flag.reservationId, 'res1');
  assert.match(flag.note, /SUPERSEDED/i);
});

test('M4: supersede refuses on a PAID session; multiple supersedes accumulate refs', async () => {
  const session = seedSession();
  const a = await kioskPaymentIntentService.ensureIntent('ks1', DEVICE);
  const b = await kioskPaymentIntentService.supersedeIntent('ks1', DEVICE);
  await kioskPaymentIntentService.supersedeIntent('ks1', DEVICE);
  assert.deepEqual(session.paymentIntentPriorRefs, [a.paymentIntentRef, b.paymentIntentRef]);

  await kioskPaymentIntentService.setIntentState('ks1', DEVICE, 'PAID');
  await rejects(kioskPaymentIntentService.supersedeIntent('ks1', DEVICE), { status: 409, code: 'INTENT_ALREADY_PAID' });
});

test('R1: the guard hands the VALIDATED amount to the gateway callback', async (t) => {
  t.after(restoreEnv);
  armGuards();
  let seen = null;
  await withKioskPaymentGuard({ ...OK_CTX, amount: '3' }, async (arg) => { seen = arg; return 'ok'; });
  assert.deepEqual(seen, { amount: 3 }, 'callback receives the coerced, ceiling-checked number');
});

test('QA minor 1: a later NOT_ATTEMPTED raise NEVER downgrades a GATEWAY_FAILED row', async () => {
  // sweep 1: nothing tried yet
  const a = await paymentOpsQueue.raise({
    tenantId: 't1', kind: 'STRANDED_DEPOSIT_HOLD', rentalAgreementId: 'ra1', gatewayRef: 'RRN1',
  });
  assert.equal(a.status, 'NOT_ATTEMPTED');

  // a real gateway attempt fails — this is the severe state we must not lose
  const b = await paymentOpsQueue.raise({
    tenantId: 't1', kind: 'STRANDED_DEPOSIT_HOLD', rentalAgreementId: 'ra1', gatewayRef: 'RRN1',
    status: 'GATEWAY_FAILED', lastError: 'void rejected: already settled',
  });
  assert.equal(b.id, a.id);
  assert.equal(b.status, 'GATEWAY_FAILED');
  assert.equal(b.attempts, 1);

  // the NEXT nightly sweep re-raises with the default status — the row must
  // STAY gateway-failed, or "we tried and it refused" silently becomes
  // "nobody has tried yet" and triage by severity misses it.
  const c = await paymentOpsQueue.raise({
    tenantId: 't1', kind: 'STRANDED_DEPOSIT_HOLD', rentalAgreementId: 'ra1', gatewayRef: 'RRN1',
    note: 'still live next night',
  });
  assert.equal(c.id, a.id);
  assert.equal(c.status, 'GATEWAY_FAILED', 'NOT_ATTEMPTED must never overwrite GATEWAY_FAILED');
  assert.equal(c.attempts, 1, 'a non-attempt does not inflate the attempt count');
  assert.match(c.note, /still live next night/, 'context still refreshes');
  assert.match(c.lastError, /already settled/, 'the failure reason survives');

  // an explicit RESOLVE is still allowed to move it forward
  const resolved = await paymentOpsQueue.resolve(a.id, { actorUserId: 'u1' }, { tenantId: 't1' });
  assert.equal(resolved.status, 'RESOLVED');
});
