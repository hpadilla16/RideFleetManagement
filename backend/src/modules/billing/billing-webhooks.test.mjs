/**
 * The billing webhook receiver.
 *
 * This endpoint is reachable by anyone on the internet and it writes to the
 * tables that say who paid Ride. The signature is the only thing standing
 * between those two facts, so the first block below is about nothing else.
 *
 * DB-free by construction (billing-test-prisma.mjs), because the `npm test`
 * chain has to stay runnable on a laptop with no Postgres.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Env BEFORE the imports, then dynamic import — the same bootstrap
// billing-enrollment.test.mjs uses. lib/prisma.js constructs a PrismaClient at
// module load and throws without a DATABASE_URL, so a static import would fail
// before a single test ran. Nothing here ever reaches a database: every suite
// injects the fake from billing-test-prisma.mjs.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.BILLING_AUTHNET_ENV = 'sandbox';
process.env.BILLING_AUTHNET_LOGIN_ID = 'test-login';
process.env.BILLING_AUTHNET_TRANSACTION_KEY = 'test-key';

const { signAuthnetWebhookBody } = await import('../../lib/authnet-webhook-signature.js');
const { makePrisma, makeAuditSpy } = await import('./billing-test-prisma.mjs');
const { ingestBillingWebhook } = await import('./billing-webhooks.service.js');
const { SUBSCRIPTION_STATUS, CHARGE_STATUS, CHARGE_SOURCE } = await import('./billing.service.js');
const { BILLING_EVENT } = await import('./billing-events.js');
const { buildOwnerNotification, notifyOwner, ownerNotificationRecipient } = await import('./billing-notify.js');

const KEY = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';
const ARB_SUB = '9471226';

/** A logger that keeps everything, so a test can assert on what was NOT said. */
function makeLogSpy() {
  const lines = [];
  const push = (level) => (message, meta) => lines.push({ level, message, meta });
  return {
    lines,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    /** Everything ever logged, flattened, for substring assertions. */
    dump() { return JSON.stringify(lines); },
  };
}

function makeNotifySpy() {
  const calls = [];
  return { calls, notifyOwner: async (kind, sub, extra) => { calls.push({ kind, subscriptionId: sub?.id, extra }); } };
}

/** An express-ish request carrying RAW BYTES, exactly as main.js's verify hook leaves them. */
function makeReq(bodyString, { key = KEY, encoding = 'hex-bytes', header } = {}) {
  const raw = Buffer.from(bodyString, 'utf8');
  const sig = header === undefined ? signAuthnetWebhookBody(raw, key, { encoding }) : header;
  return {
    rawBodyBuffer: raw,
    rawBody: bodyString,
    body: (() => { try { return JSON.parse(bodyString); } catch { return {}; } })(),
    headers: sig == null ? {} : { 'x-anet-signature': sig },
    get(name) { return this.headers[String(name).toLowerCase()] || null; },
  };
}

function envelope(eventType, { notificationId, eventDate, payload }) {
  return JSON.stringify({
    notificationId,
    eventType,
    eventDate,
    webhookId: 'wh-billing-1',
    payload,
  });
}

function subEvent(eventType, notificationId, eventDate, extra = {}) {
  return envelope(eventType, {
    notificationId,
    eventDate,
    payload: { id: ARB_SUB, entityName: 'subscription', ...extra },
  });
}

function paymentEvent(notificationId, eventDate, { transId, responseCode = 1, amount = 199 } = {}) {
  return envelope(BILLING_EVENT.PAYMENT_AUTHCAPTURE, {
    notificationId,
    eventDate,
    payload: {
      id: transId,
      entityName: 'transaction',
      // Authorize.Net's payment payload does not always carry a subscription
      // reference; when it does, it is here. Attribution without it is
      // detector 3's job, and there is a test for that below.
      subscription: { id: ARB_SUB },
      responseCode,
      authAmount: amount,
      authCode: 'ABC123',
    },
  });
}

/** A world with one ACTIVE subscription, wired for injection. */
async function makeWorld({ status = SUBSCRIPTION_STATUS.ACTIVE, nextChargeDate = '2026-09-01' } = {}) {
  const prisma = makePrisma();
  const audit = makeAuditSpy();
  const notify = makeNotifySpy();
  const logger = makeLogSpy();

  await prisma.tenant.create({ data: { id: 'tenant_1', name: 'Isla Verde Rentals' } });
  const subscription = await prisma.tenantSubscription.create({
    data: {
      id: 'sub_1',
      tenantId: 'tenant_1',
      planCode: 'PRO',
      planNameSnapshot: 'Pro',
      amount: 199,
      currency: 'USD',
      intervalUnit: 'months',
      intervalLength: 1,
      status,
      arbSubscriptionId: ARB_SUB,
      customerProfileId: 'cp_1',
      customerPaymentProfileId: 'pp_1',
      cardBrand: 'Visa',
      cardLast4: '1111',
      startDate: '2026-08-01',
      nextChargeDate,
      currentPeriodStart: '2026-08-01',
      currentPeriodEnd: '2026-08-31',
      failedAttempts: 0,
      pastDueSince: null,
      suspendedAt: null,
    },
  });

  const overrides = {
    prisma,
    logger,
    signatureKey: KEY,
    recordAudit: audit.recordAudit,
    notifyOwner: notify.notifyOwner,
    now: () => new Date('2026-09-05T12:00:00Z'),
  };
  const reload = () => prisma.tenantSubscription.findUnique({ where: { id: 'sub_1' } });
  return { prisma, audit, notify, logger, overrides, subscription, reload };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Signature verification — the only authentication this route has
// ═══════════════════════════════════════════════════════════════════════════

test('a validly signed event is accepted and stored', async () => {
  const w = await makeWorld();
  const body = subEvent(BILLING_EVENT.SUB_EXPIRING, 'n-1', '2026-09-05T10:00:00.0000000Z');
  const res = await ingestBillingWebhook(makeReq(body), w.overrides);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { received: true });
  assert.equal(w.prisma.tenantSubscriptionEvent.rows.length, 1);
  assert.equal(w.prisma.tenantSubscriptionEvent.rows[0].signatureOk, true);
  assert.equal(w.prisma.tenantSubscriptionEvent.rows[0].subscriptionId, 'sub_1');
});

test('BOTH Signature Key encodings are accepted', async () => {
  // The documented reading and the one some real accounts behave like. Dropping
  // either presents as "works in sandbox, silently fails in production".
  for (const encoding of ['hex-bytes', 'latin1-text']) {
    const w = await makeWorld();
    const body = subEvent(BILLING_EVENT.SUB_EXPIRING, `n-${encoding}`, '2026-09-05T10:00:00Z');
    const res = await ingestBillingWebhook(makeReq(body, { encoding }), w.overrides);
    assert.equal(res.status, 200, `${encoding} rejected`);
    assert.equal(w.prisma.tenantSubscriptionEvent.rows.length, 1);
  }
});

test('an INVALID signature is 401 and PERSISTS NOTHING', async () => {
  const w = await makeWorld();
  const body = subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-bad', '2026-09-05T10:00:00Z');
  const wrongKey = 'FFEEDDCCBBAA99887766554433221100FFEEDDCCBBAA99887766554433221100';
  const res = await ingestBillingWebhook(makeReq(body, { key: wrongKey }), w.overrides);

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Unauthorized' });
  // Storing unverified bodies would make this URL a free write primitive.
  assert.equal(w.prisma.tenantSubscriptionEvent.rows.length, 0);
  // And absolutely no state change from an unauthenticated caller.
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.ACTIVE);
});

test('a MISSING signature header is 401 and persists nothing', async () => {
  const w = await makeWorld();
  const body = subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-nohdr', '2026-09-05T10:00:00Z');
  const res = await ingestBillingWebhook(makeReq(body, { header: null }), w.overrides);
  assert.equal(res.status, 401);
  assert.equal(w.prisma.tenantSubscriptionEvent.rows.length, 0);
});

test('a server with NO signature key configured rejects everything — fails CLOSED', async () => {
  const w = await makeWorld();
  const body = subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-nokey', '2026-09-05T10:00:00Z');
  const res = await ingestBillingWebhook(makeReq(body), { ...w.overrides, signatureKey: '' });
  assert.equal(res.status, 401);
  assert.equal(w.prisma.tenantSubscriptionEvent.rows.length, 0);
});

test('the HMAC is over RAW BYTES — a re-serialised body does not verify', async () => {
  // The single most expensive way to get this endpoint wrong: verify against
  // JSON.stringify(req.body) and every genuine event is rejected, silently.
  const w = await makeWorld();
  const spaced = `{\n  "eventType": "${BILLING_EVENT.SUB_EXPIRING}",\n  "notificationId": "n-raw",\n  "payload": { "id": "${ARB_SUB}", "entityName": "subscription" }\n}`;
  const compact = JSON.stringify(JSON.parse(spaced));
  assert.notEqual(compact, spaced, 'precondition: the encodings must differ');

  // Signed over the pretty bytes, delivered as the pretty bytes → accepted.
  const good = await ingestBillingWebhook(makeReq(spaced), w.overrides);
  assert.equal(good.status, 200);

  // Signed over the pretty bytes, delivered as the compact ones → rejected.
  const req = makeReq(compact);
  req.headers['x-anet-signature'] = signAuthnetWebhookBody(Buffer.from(spaced, 'utf8'), KEY);
  const bad = await ingestBillingWebhook(req, w.overrides);
  assert.equal(bad.status, 401);
});

test('a bad signature and an unknown event are indistinguishable in shape', async () => {
  // An attacker learns nothing from the body of a rejection: one 401 shape for
  // every failure mode, and no reason code anywhere.
  const w = await makeWorld();
  const bodies = [
    subEvent(BILLING_EVENT.SUB_SUSPENDED, 'x-1', '2026-09-05T10:00:00Z'),
    'not json at all',
    '{}',
    '',
  ];
  const seen = new Set();
  for (const body of bodies) {
    const res = await ingestBillingWebhook(makeReq(body, { key: 'DEADBEEF' }), w.overrides);
    seen.add(JSON.stringify({ status: res.status, body: res.body }));
  }
  assert.equal(seen.size, 1, 'every unverified request must get a byte-identical answer');
  assert.equal([...seen][0], JSON.stringify({ status: 401, body: { error: 'Unauthorized' } }));
});

test('NO SECRETS IN LOGS — a rejected delivery leaks neither the key nor an HMAC', async () => {
  const w = await makeWorld();
  const body = subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-leak', '2026-09-05T10:00:00Z');
  const req = makeReq(body, { key: KEY });
  const realHeader = req.headers['x-anet-signature'];
  // Deliver it to a server holding a DIFFERENT key, so the failure path runs.
  await ingestBillingWebhook(req, { ...w.overrides, signatureKey: 'FFEE' + KEY.slice(4) });

  const dumped = w.logger.dump();
  assert.ok(dumped.length > 0, 'precondition: something was logged');
  assert.equal(dumped.includes(KEY), false, 'the signature key appeared in a log line');
  assert.equal(dumped.includes(KEY.toLowerCase()), false, 'the signature key (lowercased) appeared in a log line');
  assert.equal(dumped.includes(realHeader), false, 'the full signature header appeared in a log line');
  // Not even a prefix of the HMAC: the rental endpoint logs those and it is a
  // bad idea there too.
  assert.equal(dumped.includes(realHeader.slice(7, 31)), false, 'an HMAC prefix appeared in a log line');
  // And nothing parsed out of the untrusted body, either.
  assert.equal(dumped.includes('n-leak'), false, 'a field from the UNVERIFIED body was logged');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Idempotency and replay
// ═══════════════════════════════════════════════════════════════════════════

test('REPLAY of the same notificationId mutates exactly once', async () => {
  const w = await makeWorld();
  const body = subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-replay', '2026-09-05T10:00:00Z');

  const first = await ingestBillingWebhook(makeReq(body), w.overrides);
  const after1 = await w.reload();
  assert.equal(first.outcome, 'applied');
  assert.equal(after1.status, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.equal(after1.failedAttempts, 1);

  // Byte-identical redelivery, five more times.
  for (let i = 0; i < 5; i += 1) {
    const again = await ingestBillingWebhook(makeReq(body), w.overrides);
    assert.equal(again.status, 200);
    assert.equal(again.outcome, 'duplicate');
  }

  const after2 = await w.reload();
  assert.equal(w.prisma.tenantSubscriptionEvent.rows.length, 1, 'the event row must exist exactly once');
  assert.equal(after2.failedAttempts, 1, 'a replay must not re-increment the failure counter');
  assert.equal(
    after2.pastDueSince.getTime(), after1.pastDueSince.getTime(),
    'a replay must not restart the delinquency clock',
  );
});

test('a REPLAYED payment event cannot double-count revenue', async () => {
  const w = await makeWorld({ status: SUBSCRIPTION_STATUS.PAST_DUE });
  const body = paymentEvent('n-pay', '2026-09-05T10:00:00Z', { transId: 'T-1000' });

  await ingestBillingWebhook(makeReq(body), w.overrides);
  for (let i = 0; i < 3; i += 1) await ingestBillingWebhook(makeReq(body), w.overrides);

  const charges = w.prisma.tenantSubscriptionCharge.rows;
  assert.equal(charges.length, 1, 'one transaction must produce exactly one ledger row');
  assert.equal(charges[0].transId, 'T-1000');
  assert.equal(charges[0].status, CHARGE_STATUS.SETTLED);
  assert.equal(charges[0].source, CHARGE_SOURCE.WEBHOOK);
});

test('an event older than the staleness window is refused and stored nowhere', async () => {
  const w = await makeWorld();
  // Captured months ago and replayed by someone who kept the bytes.
  const body = subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-old', '2026-01-01T00:00:00Z');
  const res = await ingestBillingWebhook(makeReq(body), w.overrides);

  assert.equal(res.status, 200);
  assert.equal(res.outcome, 'stale');
  assert.equal(w.prisma.tenantSubscriptionEvent.rows.length, 0);
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.ACTIVE);
});

test('a verified event for an UNKNOWN subscription is stored unlinked and answered 200', async () => {
  const w = await makeWorld();
  const body = envelope(BILLING_EVENT.SUB_SUSPENDED, {
    notificationId: 'n-unlinked',
    eventDate: '2026-09-05T10:00:00Z',
    payload: { id: '000000', entityName: 'subscription' },
  });
  const res = await ingestBillingWebhook(makeReq(body), w.overrides);

  assert.equal(res.status, 200);
  const row = w.prisma.tenantSubscriptionEvent.rows[0];
  assert.equal(row.subscriptionId, null);
  assert.ok(row.processedAt, 'an unlinked event is finished, not left pending forever');
  // Our subscription is untouched.
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.ACTIVE);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Ordering — out-of-order events must not regress state
// ═══════════════════════════════════════════════════════════════════════════

test('a LATE settled payment does NOT clear a newer suspension — but its ledger row is still written', async () => {
  // The dangerous shape. A payment that settled BEFORE the decline that
  // suspended the subscription arrives AFTER it. Replaying "they paid" over
  // "their card was declined" would quietly bring a delinquent account back.
  const w = await makeWorld();

  await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-susp', '2026-09-04T10:00:00Z')),
    w.overrides,
  );
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.PAST_DUE);

  const late = await ingestBillingWebhook(
    makeReq(paymentEvent('n-late-pay', '2026-09-03T09:00:00Z', { transId: 'T-EARLY' })),
    w.overrides,
  );

  assert.equal(late.outcome, 'late-suppressed');
  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.PAST_DUE, 'a late payment must not un-suspend');
  assert.ok(after.pastDueSince, 'and must not clear the delinquency clock');

  // MONEY THAT MOVED, MOVED. The conclusion is suppressed; the ledger is not.
  const charge = w.prisma.tenantSubscriptionCharge.rows.find((c) => c.transId === 'T-EARLY');
  assert.ok(charge, 'the late transaction must still reach the ledger');
  assert.equal(charge.status, CHARGE_STATUS.SETTLED);
});

test('a LATE subscription.created cannot revive a suspended subscription', async () => {
  const w = await makeWorld();
  await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-s2', '2026-09-04T10:00:00Z')),
    w.overrides,
  );
  const res = await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_CREATED, 'n-c2', '2026-09-01T08:00:00Z')),
    w.overrides,
  );
  assert.equal(res.status, 200);
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.PAST_DUE);
});

test('an IN-ORDER settled payment after a suspension DOES restore ACTIVE', async () => {
  // The control for the two tests above: the guard must suppress late events,
  // not all recovery. A test suite that only proves things are blocked cannot
  // tell "correctly ordered" from "broken".
  const w = await makeWorld();
  await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-s3', '2026-09-04T10:00:00Z')),
    w.overrides,
  );
  const res = await ingestBillingWebhook(
    makeReq(paymentEvent('n-p3', '2026-09-05T10:00:00Z', { transId: 'T-LATER' })),
    w.overrides,
  );

  assert.equal(res.outcome, 'applied');
  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(after.pastDueSince, null);
  assert.equal(after.failedAttempts, 0);
  assert.equal(after.nextChargeDate, '2026-10-01', 'the billing period must roll off nextChargeDate');
});

test('an UNDATED event cannot disable the ordering guard', async () => {
  // Postgres sorts NULLs first on ORDER BY ... DESC, so an event with an
  // unparseable eventDate could become the watermark, read back as null, and
  // switch the guard off for everything after it.
  const w = await makeWorld();
  await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-s4', '2026-09-04T10:00:00Z')),
    w.overrides,
  );
  // An event with no usable date at all.
  await ingestBillingWebhook(
    makeReq(envelope(BILLING_EVENT.SUB_CREATED, {
      notificationId: 'n-undated',
      eventDate: 'not-a-date',
      payload: { id: ARB_SUB, entityName: 'subscription' },
    })),
    w.overrides,
  );
  // The guard must still be armed.
  const late = await ingestBillingWebhook(
    makeReq(paymentEvent('n-p4', '2026-09-03T09:00:00Z', { transId: 'T-EARLY2' })),
    w.overrides,
  );
  assert.equal(late.outcome, 'late-suppressed');
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.PAST_DUE);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. State transitions
// ═══════════════════════════════════════════════════════════════════════════

test('DETECTOR 1: subscription.suspended → PAST_DUE with the clock started', async () => {
  const w = await makeWorld();
  await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-d1', '2026-09-05T10:00:00Z')),
    w.overrides,
  );

  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.equal(after.failedAttempts, 1);
  assert.equal(after.lastFailureCode, 'ARB_SUSPENDED');
  assert.equal(after.arbStatusSnapshot, 'suspended');
  assert.ok(after.pastDueSince);
  // A CODE, never Authorize.Net's prose — the provider echoes offending values
  // back inside message text.
  assert.equal(after.lastFailureText, null);
});

test('ARB suspended maps to PAST_DUE, never to our SUSPENDED', async () => {
  // The words collide and the meanings do not: ARB suspended = "the money
  // stopped"; our SUSPENDED = "we cut their access". Mapping one onto the other
  // would cut a customer off the instant a card expired.
  const w = await makeWorld();
  await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-map', '2026-09-05T10:00:00Z')),
    w.overrides,
  );
  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.notEqual(after.status, SUBSCRIPTION_STATUS.SUSPENDED);
  assert.equal(after.suspendedAt, null, 'nothing in this phase may cut access');
});

test('a repeat suspension against an already-SUSPENDED row does not downgrade it', async () => {
  const w = await makeWorld({ status: SUBSCRIPTION_STATUS.SUSPENDED });
  await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-rep', '2026-09-05T10:00:00Z')),
    w.overrides,
  );
  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.SUSPENDED, 'SUSPENDED is stronger than PAST_DUE');
  assert.equal(after.failedAttempts, 1, 'but the signal is still counted');
});

test('subscription.terminated → CANCELLED, with the next charge date cleared', async () => {
  const w = await makeWorld();
  await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_TERMINATED, 'n-term', '2026-09-05T10:00:00Z')),
    w.overrides,
  );
  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.CANCELLED);
  assert.equal(after.cancelReason, 'ARB_TERMINATED');
  assert.ok(after.cancelledAt);
  // Leaving a stale nextChargeDate would feed the silence detector a charge to
  // hunt for that can never happen.
  assert.equal(after.nextChargeDate, null);
});

test('a terminal subscription ignores further state events', async () => {
  const w = await makeWorld();
  await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_CANCELLED, 'n-can', '2026-09-04T10:00:00Z')),
    w.overrides,
  );
  await ingestBillingWebhook(
    makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-after', '2026-09-05T10:00:00Z')),
    w.overrides,
  );
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.CANCELLED);
});

test('DETECTOR 2: a payment event reporting a decline also reaches PAST_DUE', async () => {
  const w = await makeWorld();
  await ingestBillingWebhook(
    makeReq(paymentEvent('n-dec', '2026-09-05T10:00:00Z', { transId: 'T-DEC', responseCode: 2 })),
    w.overrides,
  );

  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.ok(String(after.lastFailureCode).startsWith('AUTHNET_') || after.lastFailureCode === 'PAYMENT_DECLINED');
  const charge = w.prisma.tenantSubscriptionCharge.rows.find((c) => c.transId === 'T-DEC');
  assert.equal(charge.status, CHARGE_STATUS.DECLINED);
  assert.equal(charge.settledAt, null, 'a decline is not settled money');
});

test('a HELD transaction is never treated as settled', async () => {
  const w = await makeWorld({ status: SUBSCRIPTION_STATUS.PAST_DUE });
  const body = envelope(BILLING_EVENT.PAYMENT_FRAUD_HELD, {
    notificationId: 'n-held',
    eventDate: '2026-09-05T10:00:00Z',
    payload: { id: 'T-HELD', entityName: 'transaction', subscription: { id: ARB_SUB }, authAmount: 199 },
  });
  await ingestBillingWebhook(makeReq(body), w.overrides);

  const charge = w.prisma.tenantSubscriptionCharge.rows.find((c) => c.transId === 'T-HELD');
  assert.equal(charge.status, CHARGE_STATUS.PENDING);
  assert.equal(charge.settledAt, null);
  // The money is not ours yet, so it cannot clear a delinquency.
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.PAST_DUE);
});

test('a payment event with NO response code is recorded PENDING, not guessed as approved', async () => {
  const w = await makeWorld({ status: SUBSCRIPTION_STATUS.PAST_DUE });
  const body = envelope(BILLING_EVENT.PAYMENT_AUTHCAPTURE, {
    notificationId: 'n-nocode',
    eventDate: '2026-09-05T10:00:00Z',
    payload: { id: 'T-UNK', entityName: 'transaction', subscription: { id: ARB_SUB }, authAmount: 199 },
  });
  await ingestBillingWebhook(makeReq(body), w.overrides);

  assert.equal(
    w.prisma.tenantSubscriptionCharge.rows.find((c) => c.transId === 'T-UNK').status,
    CHARGE_STATUS.PENDING,
  );
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.PAST_DUE);
});

test('an unhandled event type is stored and acted on by nothing', async () => {
  const w = await makeWorld();
  const body = envelope('net.authorize.something.we.have.never.seen', {
    notificationId: 'n-weird',
    eventDate: '2026-09-05T10:00:00Z',
    payload: { id: ARB_SUB, entityName: 'subscription' },
  });
  const res = await ingestBillingWebhook(makeReq(body), w.overrides);

  assert.equal(res.status, 200);
  assert.equal(w.prisma.tenantSubscriptionEvent.rows.length, 1, 'discoverable in the panel, not lost');
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.ACTIVE);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Notifications and audit
// ═══════════════════════════════════════════════════════════════════════════

test('the owner is notified ONCE PER TRANSITION, not once per event', async () => {
  const w = await makeWorld();

  // Three DISTINCT suspension events (distinct notificationIds, so replay
  // protection is not what is being tested here) against the same subscription.
  for (const [i, date] of [['a', '2026-09-05T10:00:00Z'], ['b', '2026-09-05T11:00:00Z'], ['c', '2026-09-05T12:00:00Z']]) {
    await ingestBillingWebhook(makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, `n-multi-${i}`, date)), w.overrides);
  }

  const pastDueMails = w.notify.calls.filter((c) => c.kind === 'PAST_DUE');
  assert.equal(pastDueMails.length, 1, 'one delinquency is one email, however many signals arrive');
  // The signals are all still counted — the count is real, the alarm is once.
  assert.equal((await w.reload()).failedAttempts, 3);

  const auditRows = w.audit.rows.filter((r) => r.action === 'SUBSCRIPTION_STATE_CHANGE');
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].metadata.from, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(auditRows[0].metadata.to, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.equal(auditRows[0].metadata.source, 'WEBHOOK');
});

test('recovery notifies too, and the audit records both directions', async () => {
  const w = await makeWorld();
  await ingestBillingWebhook(makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-r1', '2026-09-04T10:00:00Z')), w.overrides);
  await ingestBillingWebhook(makeReq(paymentEvent('n-r2', '2026-09-05T10:00:00Z', { transId: 'T-R' })), w.overrides);

  assert.deepEqual(w.notify.calls.map((c) => c.kind), ['PAST_DUE', 'RECOVERED']);
  const transitions = w.audit.rows
    .filter((r) => r.action === 'SUBSCRIPTION_STATE_CHANGE')
    .map((r) => `${r.metadata.from}->${r.metadata.to}`);
  assert.deepEqual(transitions, ['ACTIVE->PAST_DUE', 'PAST_DUE->ACTIVE']);
});

test('an event that changes nothing sends no mail at all', async () => {
  const w = await makeWorld();
  await ingestBillingWebhook(makeReq(subEvent(BILLING_EVENT.SUB_EXPIRING, 'n-info', '2026-09-05T10:00:00Z')), w.overrides);
  assert.equal(w.notify.calls.length, 0);
  assert.equal(w.audit.rows.length, 0);
});

test('the audit metadata carries ids and codes, never a card number or a key', async () => {
  const w = await makeWorld();
  await ingestBillingWebhook(makeReq(subEvent(BILLING_EVENT.SUB_SUSPENDED, 'n-audit', '2026-09-05T10:00:00Z')), w.overrides);
  const dumped = JSON.stringify(w.audit.rows);
  assert.equal(dumped.includes(KEY), false);
  assert.ok(dumped.includes(ARB_SUB), 'the ARB reference IS wanted — support looks customers up by it');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Liveness bookkeeping and the PAN assertion
// ═══════════════════════════════════════════════════════════════════════════

test('EVERY verified event stamps lastWebhookAt, even one that changes nothing', async () => {
  // lastWebhookAt feeds the 72-hour heartbeat. If only state-changing events
  // stamped it, a perfectly healthy pipe delivering only informational events
  // would look dead.
  const w = await makeWorld();
  await ingestBillingWebhook(makeReq(subEvent(BILLING_EVENT.SUB_EXPIRING, 'n-hb', '2026-09-05T10:00:00Z')), w.overrides);
  assert.ok((await w.reload()).lastWebhookAt, 'an informational event still proves the pipe is alive');
});

test('a payload that looks like it contains a PAN is WITHHELD, and the event still lands', async () => {
  const w = await makeWorld();
  // 4111111111111111 is the canonical Visa test number: Luhn-valid, Visa prefix.
  const body = envelope(BILLING_EVENT.SUB_EXPIRING, {
    notificationId: 'n-pan',
    eventDate: '2026-09-05T10:00:00Z',
    payload: { id: ARB_SUB, entityName: 'subscription', oops: '4111111111111111' },
  });
  const res = await ingestBillingWebhook(makeReq(body), w.overrides);

  assert.equal(res.status, 200);
  const row = w.prisma.tenantSubscriptionEvent.rows[0];
  assert.equal(row.payload._redacted, true, 'the payload must not be persisted');
  assert.equal(JSON.stringify(row.payload).includes('4111111111111111'), false);
  // And the alarm must not quote the value it found.
  assert.equal(w.logger.dump().includes('4111111111111111'), false);
});

test('an ordinary payload with long numeric ids is NOT flagged as a PAN', async () => {
  // A check that cries wolf gets switched off. Timestamps, transaction ids and
  // amounts are full of long digit runs; only Luhn + a real issuer prefix counts.
  const w = await makeWorld();
  const body = envelope(BILLING_EVENT.SUB_EXPIRING, {
    notificationId: 'n-nopan',
    eventDate: '2026-09-05T10:00:00Z',
    payload: { id: ARB_SUB, entityName: 'subscription', ref: '120041234567890', ts: '20260905120000000' },
  });
  await ingestBillingWebhook(makeReq(body), w.overrides);
  assert.notEqual(w.prisma.tenantSubscriptionEvent.rows[0].payload._redacted, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. The notification itself
// ═══════════════════════════════════════════════════════════════════════════

test('every alarm says WHAT THE TENANT MUST DO, because there is only one remedy', async () => {
  const sub = {
    id: 'sub_1', tenantId: 'tenant_1', authorizedName: 'Isla Verde Rentals',
    planNameSnapshot: 'Pro', amount: 199, currency: 'USD',
    arbSubscriptionId: ARB_SUB, cardBrand: 'Visa', cardLast4: '1111',
    nextChargeDate: '2026-09-01',
  };
  for (const kind of ['PAST_DUE', 'SUSPENDED']) {
    const msg = buildOwnerNotification(kind, sub);
    assert.ok(msg.subject.includes('Isla Verde Rentals'), `${kind}: subject must name the tenant`);
    assert.ok(/ACTUALIZAR SU MÉTODO DE PAGO/.test(msg.text), `${kind}: must state the remedy`);
    // The Automatic Retry fact, in the message, because "wait and see" is the
    // wrong instinct and it is the one people have: ARB retries nightly, but
    // ONLY after the payment method is updated.
    assert.ok(/SOLO después de que se actualice/.test(msg.text), `${kind}: must say waiting does not help`);
  }
});

test('a notification carries brand + last4 and never a full card number or a key', () => {
  const msg = buildOwnerNotification('PAST_DUE', {
    id: 's', authorizedName: 'X', amount: 199, currency: 'USD',
    cardBrand: 'Visa', cardLast4: '1111', arbSubscriptionId: ARB_SUB,
  });
  assert.ok(msg.text.includes('····1111'));
  assert.equal(msg.text.includes(KEY), false);
  assert.equal(/\d{13,19}/.test(msg.text.replace(ARB_SUB, '')), false, 'no long digit run that could be a PAN');
});

test('a missing recipient WARNS and returns — it never throws into a webhook handler', async () => {
  // The event is already durable by the time mail is attempted. Losing the row
  // to a mailer misconfiguration would trade a durable record for a notification.
  const logger = makeLogSpy();
  const result = await notifyOwner('PAST_DUE', { id: 'sub_1' }, {}, { logger, recipient: '' });
  assert.deepEqual(result, { sent: false, reason: 'no-recipient' });
  // And it says which variable to set, so the fix does not need a code read.
  assert.ok(logger.dump().includes('BILLING_OWNER_NOTIFICATION_EMAIL'));
});

test('a mailer that throws is swallowed, not propagated', async () => {
  const logger = makeLogSpy();
  const result = await notifyOwner('PAST_DUE', { id: 'sub_1' }, {}, {
    logger,
    recipient: 'owner@example.test',
    sendEmail: async () => { throw new Error('SMTP down'); },
  });
  assert.deepEqual(result, { sent: false, reason: 'send-failed' });
});

test('the recipient env chain is purpose-specific first, ops address second', () => {
  const before = { a: process.env.BILLING_OWNER_NOTIFICATION_EMAIL, b: process.env.OPS_NOTIFICATION_EMAIL };
  try {
    delete process.env.BILLING_OWNER_NOTIFICATION_EMAIL;
    process.env.OPS_NOTIFICATION_EMAIL = 'ops@example.test';
    assert.equal(ownerNotificationRecipient(), 'ops@example.test');
    process.env.BILLING_OWNER_NOTIFICATION_EMAIL = 'billing@example.test';
    assert.equal(ownerNotificationRecipient(), 'billing@example.test');
  } finally {
    if (before.a === undefined) delete process.env.BILLING_OWNER_NOTIFICATION_EMAIL;
    else process.env.BILLING_OWNER_NOTIFICATION_EMAIL = before.a;
    if (before.b === undefined) delete process.env.OPS_NOTIFICATION_EMAIL;
    else process.env.OPS_NOTIFICATION_EMAIL = before.b;
  }
});

test('the owner notification goes out as THE PLATFORM, not as the tenant whose bill bounced', async () => {
  const sent = [];
  await notifyOwner('PAST_DUE', { id: 'sub_1', tenantId: 'tenant_1', authorizedName: 'X' }, {}, {
    logger: makeLogSpy(),
    recipient: 'owner@example.test',
    sendEmail: async (payload) => { sent.push(payload); },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.test');
  // No tenantId — passing one would resolve the TENANT's branding as the
  // sender, so Ride's own dunning alarm would arrive looking like it came from
  // the customer who is not paying.
  assert.equal(sent[0].tenantId, undefined);
});
