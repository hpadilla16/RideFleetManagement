/**
 * Reconciliation — the net under a webhook that never arrives.
 *
 * THE CENTRAL PROPERTY THIS SUITE EXISTS TO PROVE: every detector below works
 * with ZERO webhooks ever having been delivered. No suite here inserts an event
 * row to set the stage, because the failure being defended against is precisely
 * the one where no event row is ever written — the endpoint unreachable, the
 * portal subscription switched off, the Signature Key rotated so every genuine
 * delivery is rejected. In all three the webhook path reports perfect health.
 *
 * The second property, and it is the one that keeps the alerts usable: the
 * reconciler runs every day forever, so an unpaid bill must produce ONE alarm,
 * not one alarm per day until someone mutes the channel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.BILLING_AUTHNET_ENV = 'sandbox';
process.env.BILLING_AUTHNET_LOGIN_ID = 'test-login';
process.env.BILLING_AUTHNET_TRANSACTION_KEY = 'test-key';

const { makePrisma, makeAuditSpy } = await import('./billing-test-prisma.mjs');
const { runBillingReconcile, isEscalation } = await import('./billing-reconcile.service.js');
const { SUBSCRIPTION_STATUS, CHARGE_STATUS, CHARGE_SOURCE } = await import('./billing.service.js');
const { BILLING_EVENT } = await import('./billing-events.js');

const ARB_SUB = '9471226';
const NOW = new Date('2026-09-10T06:15:00Z');

function makeLogSpy() {
  const lines = [];
  const push = (level) => (message, meta) => lines.push({ level, message, meta });
  return {
    lines,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    dump() { return JSON.stringify(lines); },
    has(fragment) { return this.dump().includes(fragment); },
  };
}

function makeNotifySpy() {
  const calls = [];
  return { calls, notifyOwner: async (kind, sub, extra) => { calls.push({ kind, extra, id: sub?.id }); } };
}

/**
 * @param status          our stored status
 * @param nextChargeDate  the date ARB was supposed to bill
 * @param arbStatus       what ARBGetSubscriptionStatus will answer
 * @param transactions    what ARBGetSubscription(includeTransactions) will answer
 */
async function makeWorld({
  status = SUBSCRIPTION_STATUS.ACTIVE,
  nextChargeDate = '2026-09-01',
  arbStatus = 'active',
  transactions = [],
  pastDueSince = null,
  cancelledAt = null,
} = {}) {
  const prisma = makePrisma();
  const audit = makeAuditSpy();
  const notify = makeNotifySpy();
  const logger = makeLogSpy();
  const arbCalls = { status: 0, detail: 0 };

  await prisma.tenant.create({ data: { id: 'tenant_1', name: 'Corpusa Fleet' } });
  await prisma.tenantSubscription.create({
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
      cardBrand: 'Visa',
      cardLast4: '1111',
      startDate: '2026-07-01',
      nextChargeDate,
      currentPeriodStart: '2026-08-01',
      currentPeriodEnd: '2026-08-31',
      failedAttempts: 0,
      pastDueSince,
      suspendedAt: null,
      cancelledAt,
      cancelReason: null,
      arbStatusSnapshot: null,
      lastReconciledAt: null,
    },
  });

  const overrides = {
    prisma,
    logger,
    recordAudit: audit.recordAudit,
    notifyOwner: notify.notifyOwner,
    now: () => NOW,
    getSubscriptionStatus: async () => { arbCalls.status += 1; return arbStatus; },
    getSubscription: async () => { arbCalls.detail += 1; return { status: arbStatus, transactions }; },
  };
  const reload = () => prisma.tenantSubscription.findUnique({ where: { id: 'sub_1' } });
  return { prisma, audit, notify, logger, overrides, reload, arbCalls };
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECTOR 3 — the silence detector. Zero webhooks, start to finish.
// ═══════════════════════════════════════════════════════════════════════════

test('SILENCE DETECTOR fires with ZERO webhooks ever received', async () => {
  // A charge date came and went. Our ledger is empty. Authorize.Net reports no
  // transaction of any kind. Nothing has ever hit the webhook endpoint.
  const w = await makeWorld({ nextChargeDate: '2026-09-01', transactions: [] });
  assert.equal(w.prisma.tenantSubscriptionEvent.rows.length, 0, 'precondition: no events exist');

  const counts = await runBillingReconcile(w.overrides);

  assert.equal(counts.noChargeObserved, 1);
  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.equal(after.lastFailureCode, 'NO_CHARGE_OBSERVED');
  assert.ok(after.pastDueSince, 'the delinquency clock starts here too');

  // Loud, and named so it can be alerted on.
  assert.ok(w.logger.has('NO_CHARGE_OBSERVED'));
  assert.deepEqual(w.notify.calls.map((c) => c.kind), ['PAST_DUE', 'NO_CHARGE_OBSERVED']);

  // And the decision is in the same ledger a webhook would have landed in.
  const synthetic = w.prisma.tenantSubscriptionEvent.rows.find(
    (r) => r.eventType === BILLING_EVENT.RECONCILE_NO_CHARGE_OBSERVED,
  );
  assert.ok(synthetic, 'the correction must be visible next to the events it compensates for');
  assert.equal(synthetic.payload.synthetic, true);
});

test('SILENCE DETECTOR recovers a charge whose webhook never arrived', async () => {
  const w = await makeWorld({
    status: SUBSCRIPTION_STATUS.PAST_DUE,
    pastDueSince: new Date('2026-09-05T00:00:00Z'),
    nextChargeDate: '2026-09-01',
    transactions: [{
      transId: 'T-REAL', payNum: 2, responseCode: 1, responseReasonCode: 1,
      submitTimeUTC: '2026-09-01T04:11:02Z',
    }],
  });

  const counts = await runBillingReconcile(w.overrides);

  assert.equal(counts.chargesMaterialised, 1);
  const charge = w.prisma.tenantSubscriptionCharge.rows[0];
  assert.equal(charge.transId, 'T-REAL');
  assert.equal(charge.status, CHARGE_STATUS.SETTLED);
  assert.equal(charge.source, CHARGE_SOURCE.RECONCILE);
  assert.equal(charge.arbPaymentNum, 2);
  // The AMOUNT comes from the subscription's own snapshot, never from a catalog
  // that may have been edited since.
  assert.equal(charge.amount, 199);

  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.ACTIVE, 'money in hand is what clears a delinquency');
  assert.equal(after.pastDueSince, null);
  assert.equal(after.failedAttempts, 0);
  assert.equal(after.nextChargeDate, '2026-10-01');
  assert.equal(after.currentPeriodEnd, '2026-09-30', 'the period ends the day BEFORE the next charge');
  assert.deepEqual(w.notify.calls.map((c) => c.kind), ['RECOVERED']);
});

test('SILENCE DETECTOR reads a decline at ARB as PAST_DUE with the issuer code', async () => {
  const w = await makeWorld({
    nextChargeDate: '2026-09-01',
    transactions: [{
      transId: 'T-DECL', payNum: 2, responseCode: 2, responseReasonCode:
      // 2 = "This transaction has been declined." The NUMBER is kept; the text
      // is not, because provider prose is where an echoed value would ride in.
      2,
      submitTimeUTC: '2026-09-01T04:11:02Z',
    }],
  });

  const counts = await runBillingReconcile(w.overrides);
  assert.equal(counts.declinesFound, 1);
  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.equal(after.lastFailureCode, 'AUTHNET_2');
  assert.equal(after.lastFailureText, null);
  assert.equal(w.prisma.tenantSubscriptionCharge.rows.length, 0, 'a decline is not a ledger entry of money');
});

test('a subscription with a covering settled charge costs ZERO Authorize.Net calls', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-01' });
  await w.prisma.tenantSubscriptionCharge.create({
    data: {
      subscriptionId: 'sub_1', tenantId: 'tenant_1', kind: 'RECURRING',
      status: CHARGE_STATUS.SETTLED, amount: 199, currency: 'USD',
      transId: 'T-OK', chargeDate: '2026-09-01', description: 'ok', source: 'WEBHOOK',
    },
  });

  await runBillingReconcile(w.overrides);
  assert.equal(w.arbCalls.detail, 0, 'no detail call for a subscription that is demonstrably fine');
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.ACTIVE);
});

test('a charge date still inside the grace window is not yet suspicious', async () => {
  // Two days, per the design. A shorter window cries wolf on every ordinary
  // billing day, and an alert that fires on healthy rows gets muted.
  const w = await makeWorld({ nextChargeDate: '2026-09-09' }); // "today" is the 10th
  await runBillingReconcile(w.overrides);
  assert.equal(w.arbCalls.detail, 0);
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.ACTIVE);
});

// ═══════════════════════════════════════════════════════════════════════════
// DETECTOR 2 — status drift, and the asymmetry rule
// ═══════════════════════════════════════════════════════════════════════════

test('DRIFT ESCALATION: ARB says suspended while we said ACTIVE → adopt, audit, notify', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-20', arbStatus: 'suspended' });

  const counts = await runBillingReconcile(w.overrides);

  assert.equal(counts.driftEscalated, 1);
  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.equal(after.arbStatusSnapshot, 'suspended');
  assert.ok(after.lastReconciledAt);
  assert.ok(after.pastDueSince);

  assert.ok(w.logger.has('STATUS DRIFT'), 'a correction must be logged loudly');
  const drift = w.audit.rows.find((r) => r.action === 'SUBSCRIPTION_RECONCILE_DRIFT');
  assert.ok(drift);
  assert.equal(drift.metadata.arbStatus, 'suspended');
  assert.equal(drift.metadata.from, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(drift.metadata.to, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.ok(w.notify.calls.some((c) => c.kind === 'DRIFT'));

  const synthetic = w.prisma.tenantSubscriptionEvent.rows.find(
    (r) => r.eventType === BILLING_EVENT.RECONCILE_STATUS_DRIFT,
  );
  assert.ok(synthetic);
  assert.equal(synthetic.payload.adopted, true);
});

test('DRIFT ESCALATION: ARB says canceled while we were charging → CANCELLED', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-20', arbStatus: 'canceled' });
  await runBillingReconcile(w.overrides);
  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.CANCELLED);
  assert.equal(after.cancelReason, 'ARB_CANCELED');
  assert.equal(after.nextChargeDate, null, 'no next charge is coming, so stop hunting for one');
});

test('DE-ESCALATION IS REFUSED: ARB says active while we had PAST_DUE', async () => {
  // A status is not a payment. Clearing a delinquency on the strength of a word
  // would wipe pastDueSince and destroy the record of how long they were late.
  const w = await makeWorld({
    status: SUBSCRIPTION_STATUS.PAST_DUE,
    pastDueSince: new Date('2026-09-02T00:00:00Z'),
    nextChargeDate: '2026-09-20',
    arbStatus: 'active',
  });

  const counts = await runBillingReconcile(w.overrides);

  assert.equal(counts.driftRefused, 1);
  assert.equal(counts.driftEscalated, 0);
  const after = await w.reload();
  assert.equal(after.status, SUBSCRIPTION_STATUS.PAST_DUE, 'not adopted');
  assert.equal(after.pastDueSince.toISOString(), '2026-09-02T00:00:00.000Z', 'the clock is preserved');
  // But it IS recorded and alerted, so nobody has to notice it by accident.
  assert.ok(w.logger.has('drift NOT adopted'));
  const synthetic = w.prisma.tenantSubscriptionEvent.rows.find(
    (r) => r.eventType === BILLING_EVENT.RECONCILE_STATUS_DRIFT,
  );
  assert.equal(synthetic.payload.adopted, false);
});

test('TRIALING is not "corrected" to ACTIVE just because ARB calls it active', async () => {
  // A deferred-start subscription IS active at ARB from creation. TRIALING is
  // our refinement of that, which ARB has no word for. Treating it as drift
  // would raise an alert for every trialing customer on day one.
  const w = await makeWorld({
    status: SUBSCRIPTION_STATUS.TRIALING,
    nextChargeDate: '2026-09-20',
    arbStatus: 'active',
  });
  const counts = await runBillingReconcile(w.overrides);
  assert.equal(counts.driftEscalated, 0);
  assert.equal(counts.driftRefused, 0);
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.TRIALING);
  // Specifically no DRIFT alarm. (The heartbeat still fires in this world —
  // no event has ever arrived — and that is a different, correct alarm.)
  assert.equal(w.notify.calls.filter((c) => c.kind === 'DRIFT').length, 0);
});

test('THE WORST BUG: cancelled here, still live at Authorize.Net — surfaced, not adopted', async () => {
  // Cancelled in our database and still charging the customer every month.
  // Nothing else in the system would ever look at this row again, which is
  // exactly why the poll pulls recently-stopped rows back in.
  const w = await makeWorld({
    status: SUBSCRIPTION_STATUS.CANCELLED,
    cancelledAt: new Date('2026-09-01T00:00:00Z'),
    nextChargeDate: null,
    arbStatus: 'active',
  });

  const counts = await runBillingReconcile(w.overrides);

  assert.equal(counts.polled, 1, 'a recently-cancelled row must still be polled');
  assert.equal(counts.driftRefused, 1);
  assert.ok(w.logger.has('drift NOT adopted'));
  // Deliberately NOT auto-revived: resurrecting a cancelled subscription by
  // automation would be a worse mistake than the one it is reporting.
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.CANCELLED);
});

test('an ARB status this build does not know is surfaced, never silently ignored', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-20', arbStatus: 'quantum-superposed' });
  await runBillingReconcile(w.overrides);
  assert.ok(w.logger.has('UNMAPPED ARB status'));
  assert.equal((await w.reload()).status, SUBSCRIPTION_STATUS.ACTIVE);
});

test('one subscription failing at Authorize.Net does not stop the pass', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-20', arbStatus: 'suspended' });
  // A SECOND TENANT, not a second row on the same one: at most one live
  // subscription per tenant is a partial unique index, and the DB-free fake
  // models it — so a two-subscription fixture has to be two tenants or it
  // fails at the same place production would.
  await w.prisma.tenant.create({ data: { id: 'tenant_2', name: 'Cabo Rojo' } });
  await w.prisma.tenantSubscription.create({
    data: {
      id: 'sub_2', tenantId: 'tenant_2', planCode: 'PRO', planNameSnapshot: 'Pro',
      amount: 99, currency: 'USD', intervalUnit: 'months', intervalLength: 1,
      status: SUBSCRIPTION_STATUS.ACTIVE, arbSubscriptionId: 'BROKEN',
      startDate: '2026-07-01', nextChargeDate: '2026-09-20', failedAttempts: 0,
    },
  });

  let calls = 0;
  const counts = await runBillingReconcile({
    ...w.overrides,
    getSubscriptionStatus: async (id) => {
      calls += 1;
      if (id === 'BROKEN') throw new Error('Authorize.Net HTTP 503');
      return 'suspended';
    },
  });

  assert.equal(calls, 2, 'both subscriptions were attempted');
  assert.equal(counts.pollErrors, 1);
  assert.equal(counts.driftEscalated, 1, 'the healthy one was still corrected');
});

// ═══════════════════════════════════════════════════════════════════════════
// Alert hygiene — the reconciler runs every day forever
// ═══════════════════════════════════════════════════════════════════════════

test('the same unpaid bill alerts ONCE, not once per daily sweep', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-01', transactions: [] });

  await runBillingReconcile(w.overrides);
  const afterFirst = w.notify.calls.length;
  assert.ok(afterFirst > 0, 'precondition: the first sweep alerted');

  // Four more days of the same unpaid bill.
  for (let i = 0; i < 4; i += 1) await runBillingReconcile(w.overrides);

  const pastDue = w.notify.calls.filter((c) => c.kind === 'PAST_DUE');
  assert.equal(pastDue.length, 1, 'one delinquency is one PAST_DUE alarm, forever');
  const transitions = w.audit.rows.filter((r) => r.action === 'SUBSCRIPTION_STATE_CHANGE');
  assert.equal(transitions.length, 1, 'and one audit row — the state changed once');
});

test('a synthetic event is written once per day, not once per sweep', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-20', arbStatus: 'suspended' });
  await runBillingReconcile(w.overrides);
  await runBillingReconcile(w.overrides);
  await runBillingReconcile(w.overrides);

  const drift = w.prisma.tenantSubscriptionEvent.rows.filter(
    (r) => r.eventType === BILLING_EVENT.RECONCILE_STATUS_DRIFT,
  );
  // The deterministic notificationId `reconcile:<kind>:<sub>:<date>` gives the
  // reconciler the same replay safety the webhook path gets, from the same
  // unique index.
  assert.equal(drift.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// The heartbeat — the only thing that notices the pipe itself is dead
// ═══════════════════════════════════════════════════════════════════════════

test('HEARTBEAT alarms when zero verified webhooks have arrived in 72 hours', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-20', arbStatus: 'active' });
  await runBillingReconcile(w.overrides);

  assert.ok(w.logger.has('BILLING_WEBHOOK_SILENCE'));
  const alarm = w.notify.calls.find((c) => c.kind === 'WEBHOOK_SILENCE');
  assert.ok(alarm);
  assert.equal(alarm.extra.liveSubscriptions, 1);
  assert.equal(alarm.extra.lastEventAt, null);
});

test('HEARTBEAT stays quiet when a webhook arrived inside the window', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-20', arbStatus: 'active' });
  await w.prisma.tenantSubscriptionEvent.create({
    data: {
      notificationId: 'n-recent', eventType: BILLING_EVENT.SUB_EXPIRING,
      payload: {}, signatureOk: true,
      receivedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      processedAt: NOW, attempts: 1,
    },
  });

  await runBillingReconcile(w.overrides);
  assert.equal(w.logger.has('BILLING_WEBHOOK_SILENCE'), false);
});

test('HEARTBEAT stays quiet when there is nothing enrolled to hear from', async () => {
  // Phase 2 ships before anyone is enrolled. An alarm that fires every day of
  // that period would be muted long before the first real customer.
  const w = await makeWorld({ nextChargeDate: '2026-09-20', arbStatus: 'active' });
  await w.prisma.tenantSubscription.update({
    where: { id: 'sub_1' },
    data: { status: SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION, arbSubscriptionId: null },
  });

  await runBillingReconcile(w.overrides);
  assert.equal(w.logger.has('BILLING_WEBHOOK_SILENCE'), false);
  assert.equal(w.notify.calls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Pass 1 — events the webhook handler stored but could not apply
// ═══════════════════════════════════════════════════════════════════════════

test('an event left unprocessed by the webhook handler is retried', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-20', arbStatus: 'active' });
  await w.prisma.tenantSubscriptionEvent.create({
    data: {
      notificationId: 'n-stuck', eventType: BILLING_EVENT.SUB_SUSPENDED,
      eventDate: new Date('2026-09-09T10:00:00Z'),
      arbSubscriptionId: ARB_SUB, subscriptionId: 'sub_1',
      payload: {}, signatureOk: true, processedAt: null, attempts: 1,
      processingError: 'database was unreachable',
    },
  });

  const retried = [];
  const counts = await runBillingReconcile({
    ...w.overrides,
    processStoredEvent: async (row) => { retried.push(row.notificationId); },
  });

  assert.deepEqual(retried, ['n-stuck']);
  assert.equal(counts.eventsRetried, 1);
});

test('an event that has failed ten times stops being retried and becomes a staff alert', async () => {
  const w = await makeWorld({ nextChargeDate: '2026-09-20', arbStatus: 'active' });
  await w.prisma.tenantSubscriptionEvent.create({
    data: {
      notificationId: 'n-dead', eventType: BILLING_EVENT.SUB_SUSPENDED,
      payload: {}, signatureOk: true, processedAt: null, attempts: 10,
    },
  });

  const retried = [];
  const counts = await runBillingReconcile({
    ...w.overrides,
    processStoredEvent: async (row) => { retried.push(row.notificationId); },
  });

  assert.deepEqual(retried, [], 'ten failures is not a transient fault');
  assert.equal(counts.eventsExhausted, 1);
  assert.ok(w.logger.has('BILLING_EVENTS_STUCK'));
});

// ═══════════════════════════════════════════════════════════════════════════

test('isEscalation ranks statuses so a new one cannot read as an improvement', () => {
  assert.equal(isEscalation(SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE), true);
  assert.equal(isEscalation(SUBSCRIPTION_STATUS.TRIALING, SUBSCRIPTION_STATUS.CANCELLED), true);
  assert.equal(isEscalation(SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.SUSPENDED), true);
  assert.equal(isEscalation(SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.ACTIVE), false);
  assert.equal(isEscalation(SUBSCRIPTION_STATUS.CANCELLED, SUBSCRIPTION_STATUS.ACTIVE), false);
  assert.equal(isEscalation(SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIALING), false);
});

test('NOTHING in the reconciler charges anybody', async () => {
  // The endpoint and the sweep only observe and record. If a call that moves
  // money ever appears in the injected surface, this fails on purpose.
  const w = await makeWorld({ nextChargeDate: '2026-09-01', transactions: [] });
  const forbidden = ['chargeCustomerProfile', 'createSubscription', 'refundTransaction'];
  const tripwire = {};
  for (const name of forbidden) {
    tripwire[name] = async () => { throw new Error(`${name} must never be called from reconciliation`); };
  }
  await runBillingReconcile({ ...w.overrides, ...tripwire });
  assert.equal(w.prisma.tenantSubscriptionCharge.rows.length, 0);
});
