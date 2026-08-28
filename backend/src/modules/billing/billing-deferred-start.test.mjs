/**
 * A DEFERRED START IS NOT A TRIAL.
 *
 * Ride's first real subscription — Rent & Go by VPH Motors — is authorised on 26
 * August 2026 with a first charge on 1 September, at a negotiated $1,650.00 per
 * month, with NO trial. They have been running on the software for months.
 *
 * That shape uses the same proven ARB mechanism a free trial does (design §5A:
 * deferred `startDate`, `trialOccurrences: 0`, card captured and validated at
 * enrollment), and reusing the TRIALING status for it would have been the
 * cheapest possible change. It is refused here for one reason that outlives the
 * code: TRIALING is a WORD, and it is the word the customer reads on their
 * enrollment page, the word the receipt repeats, and the word every future panel
 * and dunning email will inherit. Telling a paying customer of several months
 * that they are on a trial is wrong on the screen before it is wrong in a
 * column, and it is the kind of wrong that gets quoted back during a dispute.
 *
 * So this suite pins four things, and each one is a different way the mistake
 * could creep back:
 *
 *   1. ISSUANCE — an explicit startDate suppresses the catalog's trialDays and
 *      leaves `trialEndsAt` null.
 *   2. ACTIVATION — the return leg goes PENDING_AUTHORIZATION → ACTIVE directly,
 *      with the first charge date still in the future.
 *   3. THE RECONCILER — an ACTIVE row whose first charge has not happened yet
 *      must survive repeated daily sweeps between 26 August and 1 September with
 *      ZERO alerts and ZERO Authorize.Net calls beyond the cheap status poll.
 *      This is the regression that actually existed: Phase 2's webhook heartbeat
 *      armed on "anything is enrolled" and would have alarmed every day from 29
 *      August, on a subscription that was perfectly healthy.
 *   4. THE PRICE — a negotiated amount does not require, and does not touch, the
 *      catalog.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.BILLING_AUTHNET_ENV = 'sandbox';
process.env.BILLING_AUTHNET_LOGIN_ID = 'test-login';
process.env.BILLING_AUTHNET_TRANSACTION_KEY = 'test-key';
process.env.BILLING_BASE_URL = 'https://example.test';

const { makePrisma, makeAuditSpy, silentLogger } = await import('./billing-test-prisma.mjs');
const { saveTenantPlanCatalog, getTenantPlanCatalog } = await import('../../lib/tenant-plan-limits.js');
const {
  issueEnrollInvite,
  completeEnrollment,
  summariseTenantBilling,
  SUBSCRIPTION_STATUS,
  CHARGE_STATUS,
} = await import('./billing.service.js');
const { runBillingReconcile } = await import('./billing-reconcile.service.js');

/** The real facts of the first real subscription. */
const TODAY = new Date('2026-08-26T14:00:00Z');
const FIRST_CHARGE = '2026-09-01';
const PRICE = 1650;

/**
 * A catalog that would ADD A TRIAL if anything let it.
 *
 * ENTERPRISE carries trialDays: 14 on purpose. If an explicit startDate ever
 * stopped suppressing the catalog trial, the first charge would silently move to
 * 9 September and the row would read TRIALING — so the trap is baked into the
 * fixture rather than left to a reviewer to imagine.
 */
const CATALOG = [
  { code: 'BETA', name: 'Beta', billable: false },
  { code: 'ENTERPRISE', name: 'Enterprise', billable: true, priceMonthly: 499, trialDays: 14 },
  // No price, not billable — exactly the state Rent & Go's plan is in, because
  // the owner set a negotiated figure and asked that the catalog not be edited.
  { code: 'RENTGO', name: 'Rent & Go', billable: false },
];

const METHOD = { customerPaymentProfileId: 'pp_vph', maskedNumber: 'XXXX1881', cardType: 'Visa' };

async function world({ now = TODAY, arbStatus = 'active', transactions = [] } = {}) {
  const prisma = makePrisma();
  const audit = makeAuditSpy();
  const notify = { calls: [], notifyOwner: async (kind, sub, extra) => { notify.calls.push({ kind, extra, id: sub?.id }); } };
  const logger = (() => {
    const lines = [];
    const push = (level) => (message, meta) => lines.push({ level, message, meta });
    return {
      lines,
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
      debug: push('debug'),
      has(fragment) { return JSON.stringify(lines).includes(fragment); },
      errors() { return lines.filter((l) => l.level === 'error'); },
    };
  })();
  const arbCalls = { status: 0, detail: 0, create: [] };

  await prisma.tenant.create({ data: { id: 'tenant_vph', name: 'Rent & Go by VPH Motors', plan: 'RENTGO' } });
  await saveTenantPlanCatalog(CATALOG, prisma);

  const deps = {
    prisma,
    logger,
    now: () => now,
    recordAudit: audit.recordAudit,
    notifyOwner: notify.notifyOwner,
    ensureCustomerProfile: async () => 'cust_vph',
    getHostedProfilePageToken: async () => 'anet-hosted-token',
    getNewestPaymentMethod: async () => METHOD,
    createSubscription: async (args) => { arbCalls.create.push(args); return 'arb_vph_1'; },
    updateSubscriptionPaymentMethod: async () => {},
    hostedPageUrl: () => 'https://test.authorize.net/customer/addPayment',
    getSubscriptionStatus: async () => { arbCalls.status += 1; return arbStatus; },
    getSubscription: async () => { arbCalls.detail += 1; return { status: arbStatus, transactions }; },
  };

  return { prisma, audit, notify, logger, deps, arbCalls };
}

const RENTGO_INVITE = {
  tenantId: 'tenant_vph',
  planCode: 'RENTGO',
  cycle: 'monthly',
  email: 'facturacion@rentgo.test',
  amountOverride: PRICE,
  startDate: FIRST_CHARGE,
  actorUserId: 'user_super',
  actorRole: 'SUPER_ADMIN',
};

/** Issue, walk through the hosted page, and complete the return leg. */
async function enroll(w, input = RENTGO_INVITE) {
  const issued = await issueEnrollInvite(input, w.deps);
  await w.prisma.autopayInvite.update({
    where: { id: issued.invite.id },
    data: { customerProfileId: 'cust_vph' },
  });
  const result = await completeEnrollment(issued.token, { ip: '10.0.0.7', userAgent: 'UA/1' }, w.deps);
  return { ...issued, result };
}

// ═══ 1. ISSUANCE ════════════════════════════════════════════════════════════

test('an explicit first-charge date is a deferred start, and trialEndsAt stays null', async () => {
  const w = await world();
  const { subscription, invite } = await issueEnrollInvite(RENTGO_INVITE, w.deps);

  assert.equal(subscription.status, SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION);
  assert.equal(subscription.startDate, FIRST_CHARGE);
  assert.equal(subscription.nextChargeDate, FIRST_CHARGE);
  assert.equal(subscription.trialEndsAt, null, 'a deferred start was recorded as a trial');
  // Design §5A: the ARB-native trial fields stay off the exercised path.
  assert.equal(invite.trialOccurrences, 0);
  assert.equal(invite.trialAmount, null);
});

test("the catalog's trialDays cannot move a first-charge date the operator typed", async () => {
  // ENTERPRISE carries trialDays: 14. With an explicit startDate that must be
  // ignored outright — silently adding a fortnight to a date somebody typed is
  // how a customer is charged on a day nobody promised them.
  const w = await world();
  const { subscription } = await issueEnrollInvite(
    { ...RENTGO_INVITE, planCode: 'ENTERPRISE', startDate: FIRST_CHARGE },
    w.deps,
  );
  assert.equal(subscription.startDate, FIRST_CHARGE);
  assert.equal(subscription.trialEndsAt, null);
});

test('with NO explicit start date the catalog trial still applies and IS a trial', async () => {
  // The other half of the rule. Free days that were actually promised must still
  // produce TRIALING — this is not a blanket removal of trials.
  const w = await world();
  const { subscription } = await issueEnrollInvite(
    { tenantId: 'tenant_vph', planCode: 'ENTERPRISE', cycle: 'monthly', email: 'x@y.test' },
    w.deps,
  );
  assert.equal(subscription.startDate, '2026-09-09', '26 Aug + 14 days');
  assert.equal(subscription.trialEndsAt, '2026-09-09');
});

// ═══ 2. ACTIVATION ══════════════════════════════════════════════════════════

test('PENDING_AUTHORIZATION goes straight to ACTIVE, first charge still in the future', async () => {
  const w = await world();
  const { result } = await enroll(w);

  const sub = w.prisma.tenantSubscription.rows[0];
  assert.equal(sub.status, SUBSCRIPTION_STATUS.ACTIVE, 'a no-trial deferred start was parked in TRIALING');
  assert.equal(sub.nextChargeDate, FIRST_CHARGE);
  assert.equal(sub.trialEndsAt, null);
  assert.ok(sub.startDate > '2026-08-26', 'precondition: the first charge has not happened yet');

  // What the customer is told. `trialing: false` is what makes the receipt say
  // "Primer cargo" without ever putting the word "prueba" in front of someone
  // who is not on a trial.
  assert.equal(result.status, 'enrolled');
  assert.equal(result.trialing, false);
  assert.equal(result.firstChargeDate, FIRST_CHARGE);
  assert.equal(result.amount, '1650');
});

test('the ARB subscription is created with the exact calendar date, byte for byte', async () => {
  const w = await world();
  await enroll(w);
  const sent = w.arbCalls.create[0];
  // Not a Date, not reformatted: the string we stored, the string we send and the
  // string we render are the same bytes. That is the entire reason billing dates
  // are VARCHAR(10) — see billing-dates.js.
  assert.equal(sent.startDate, FIRST_CHARGE);
  assert.equal(sent.amount, PRICE);
  assert.equal(sent.trialOccurrences, 0);
  assert.equal(sent.trialAmount, null);
});

test('the scheduled charge row is PENDING and dated the first charge, not today', async () => {
  const w = await world();
  await enroll(w);
  const charges = w.prisma.tenantSubscriptionCharge.rows;
  assert.equal(charges.length, 1);
  assert.equal(charges[0].status, CHARGE_STATUS.PENDING, 'money was recorded before it moved');
  assert.equal(charges[0].chargeDate, FIRST_CHARGE);
  assert.equal(charges[0].amount, PRICE);
});

test('the consent archive says "primer cobro" with the real date, never "próximo"', async () => {
  const w = await world();
  await enroll(w);
  const sub = w.prisma.tenantSubscription.rows[0];

  assert.ok(sub.authorizedAt, 'consent was not archived');
  assert.equal(sub.authorizedIp, '10.0.0.7');
  assert.equal(sub.authorizedUserAgent, 'UA/1');
  assert.equal(sub.authorizedEmail, 'facturacion@rentgo.test');
  assert.ok(sub.authorizedDisclosureHash, 'the disclosure was archived without its hash');

  // THE SENTENCE THE CUSTOMER AGREED TO. Stored verbatim, because a dispute is
  // about what they saw and not about a template id that has since been edited.
  assert.match(sub.authorizedDisclosureText, /primer cobro corre el 1 de septiembre de 2026/);
  assert.ok(
    !/próximo cobro/i.test(sub.authorizedDisclosureText),
    '"próximo cobro" on a first charge is what produces the "why was I charged" call',
  );
  assert.match(sub.authorizedDisclosureText, /\$1,650\.00 USD/);
  assert.ok(
    !/prueba|trial|gratis/i.test(sub.authorizedDisclosureText),
    'a customer of several months was told they are on a trial',
  );
});

// ═══ 3. THE RECONCILER, 26 AUGUST → 1 SEPTEMBER ═════════════════════════════

test('an ACTIVE subscription whose first charge is in the future trips NOTHING', async () => {
  // THE REGRESSION THIS SUITE EXISTS FOR. Phase 2's heartbeat armed on "any live
  // subscription exists", so from 29 August — 72 hours after enrollment, with no
  // webhook traffic because nothing has been billed yet — it would have alarmed
  // every single day until the first charge. An alarm that fires on a healthy row
  // is an alarm people learn to close without reading.
  const w = await world();
  await enroll(w);
  assert.equal(w.prisma.tenantSubscriptionEvent.rows.length, 0, 'precondition: no webhook has ever arrived');

  const detailCallsBefore = w.arbCalls.detail;

  // Every day from the day after enrollment up to the day before the charge.
  for (const day of ['2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31']) {
    const counts = await runBillingReconcile({ ...w.deps, now: () => new Date(`${day}T06:15:00Z`) });
    assert.equal(counts.heartbeatAlert, 0, `heartbeat alarmed on ${day}`);
    assert.equal(counts.silenceChecked, 0, `the silence detector went looking on ${day}`);
    assert.equal(counts.noChargeObserved, 0, `NO_CHARGE_OBSERVED on ${day}`);
    assert.equal(counts.driftEscalated, 0, `status drift escalated on ${day}`);
    assert.equal(counts.driftRefused, 0, `status drift refused on ${day}`);
  }

  // ZERO ALERTS.
  assert.deepEqual(w.notify.calls, [], 'the owner was paged about a healthy subscription');
  assert.equal(w.logger.has('BILLING_WEBHOOK_SILENCE'), false);
  assert.equal(w.logger.has('NO_CHARGE_OBSERVED'), false);
  assert.equal(w.logger.errors().length, 0, 'something logged at ERROR about a healthy subscription');

  // ZERO EXPENSIVE CALLS. The cheap ARBGetSubscriptionStatus poll is expected
  // and is how detector 2 stays honest; what must NOT happen is the
  // includeTransactions read, which only fires when a charge looks missing.
  assert.equal(w.arbCalls.detail, detailCallsBefore, 'the silence detector spent an ARB call it did not need');

  // And the row is untouched — same status, same date, no delinquency clock.
  const after = w.prisma.tenantSubscription.rows[0];
  assert.equal(after.status, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(after.nextChargeDate, FIRST_CHARGE);
  assert.equal(after.pastDueSince, undefined);
  assert.equal(after.failedAttempts, 0);
});

test('ARB calling it "active" is agreement, not drift, for a deferred start', async () => {
  // A deferred-start subscription IS active at Authorize.Net from the moment it
  // is created. Since ours is ACTIVE too there is nothing to reconcile — and
  // unlike the TRIALING case this needs no special-casing, which is a small
  // argument in favour of the modelling choice.
  const w = await world({ arbStatus: 'active' });
  await enroll(w);
  const counts = await runBillingReconcile({ ...w.deps, now: () => new Date('2026-08-30T06:15:00Z') });
  assert.equal(counts.polled, 1, 'the cheap status poll should still run');
  assert.equal(counts.driftEscalated, 0);
  assert.equal(counts.driftRefused, 0);
});

test('the HEARTBEAT wakes the day after the charge date, ahead of the silence detector', async () => {
  // Quiet before the date must not mean deaf after it. The two detectors arm on
  // deliberately different clocks: the heartbeat the moment a charge date has
  // passed at all, the silence detector only after BILLING_SILENCE_GRACE_DAYS
  // (2), because ARB settles overnight and a webhook can be hours late. So 2
  // September asks "is the pipe alive?" without yet accusing the customer of
  // anything — one day of lead time, bought for free.
  const w = await world({ transactions: [] });
  await enroll(w);

  const counts = await runBillingReconcile({ ...w.deps, now: () => new Date('2026-09-02T06:15:00Z') });

  assert.equal(counts.heartbeatAlert, 1, 'a passed charge date did not arm the heartbeat');
  assert.equal(counts.silenceChecked, 0, 'the silence detector jumped the grace window');
  assert.equal(w.prisma.tenantSubscription.rows[0].status, SUBSCRIPTION_STATUS.ACTIVE,
    'a subscription was called delinquent inside its own grace window');
});

test('the SILENCE DETECTOR wakes once the grace window is spent', async () => {
  // 4 September: the charge date is more than two days gone, ARB reports no
  // transaction of any kind, and nothing has ever hit the webhook endpoint.
  const w = await world({ transactions: [] });
  await enroll(w);

  const counts = await runBillingReconcile({ ...w.deps, now: () => new Date('2026-09-04T06:15:00Z') });

  assert.equal(counts.silenceChecked, 1);
  assert.equal(counts.noChargeObserved, 1);
  assert.equal(w.prisma.tenantSubscription.rows[0].status, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.equal(w.prisma.tenantSubscription.rows[0].lastFailureCode, 'NO_CHARGE_OBSERVED');
  assert.ok(w.notify.calls.some((c) => c.kind === 'NO_CHARGE_OBSERVED'));

  // AND THE HEARTBEAT IS STILL AUDIBLE. The reconciler writes its own decisions
  // into the same event ledger; counting those as deliveries would have let it
  // reassure itself with its own alarm.
  assert.ok(
    w.prisma.tenantSubscriptionEvent.rows.some((r) => r.eventType.startsWith('reconcile.')),
    'precondition: the reconciler wrote a synthetic event this sweep',
  );
  assert.equal(counts.heartbeatAlert, 1, 'a synthetic reconciler row was read back as a live webhook');
});

// ═══ 4. THE NEGOTIATED PRICE ════════════════════════════════════════════════

test('a negotiated price needs no catalog price and changes no catalog row', async () => {
  const w = await world();
  const before = JSON.stringify(await getTenantPlanCatalog(w.prisma));

  const { subscription } = await issueEnrollInvite(RENTGO_INVITE, w.deps);
  assert.equal(subscription.amount, PRICE);
  // RENTGO is billable:false with no price. That would refuse a catalog-priced
  // invite — and must not refuse one whose amount was supplied explicitly, or
  // the operator is forced to edit the DEFAULT offered to every future tenant
  // just to bill this one.
  assert.equal(subscription.planCode, 'RENTGO');
  assert.equal(subscription.planNameSnapshot, 'Rent & Go');

  assert.equal(JSON.stringify(await getTenantPlanCatalog(w.prisma)), before, 'enrolling edited the catalog');
});

test('a plan with no price and no explicit amount is still refused', async () => {
  // The override loosens exactly one thing. Enrolling somebody at a price nobody
  // named stays impossible.
  const w = await world();
  await assert.rejects(
    () => issueEnrollInvite({ ...RENTGO_INVITE, amountOverride: null }, w.deps),
    /not marked billable/,
  );
  assert.equal(w.prisma.tenantSubscription.rows.length, 0);
});

test('a retired plan is refused even with an explicit amount', async () => {
  // isActive is NOT relaxed by the override: billing for a plan that has been
  // withdrawn is a different mistake and no price makes it right.
  const w = await world();
  await saveTenantPlanCatalog(
    CATALOG.map((p) => (p.code === 'RENTGO' ? { ...p, isActive: false } : p)),
    w.prisma,
  );
  await assert.rejects(() => issueEnrollInvite(RENTGO_INVITE, w.deps), /not active/);
});

// ═══ IDEMPOTENCY, ON THIS EXACT SHAPE ═══════════════════════════════════════

test('a double-clicked return leg produces ONE ARB subscription at $1,650', async () => {
  // The generic idempotency guards are proved in billing-enrollment.test.mjs.
  // This re-proves them on the deferred-start path specifically, because that is
  // the path the first real customer will actually walk, and a second ARB
  // subscription here means $3,300 a month with no visible cause.
  const w = await world();
  const issued = await issueEnrollInvite(RENTGO_INVITE, w.deps);
  await w.prisma.autopayInvite.update({
    where: { id: issued.invite.id },
    data: { customerProfileId: 'cust_vph' },
  });

  const [a, b] = await Promise.all([
    completeEnrollment(issued.token, {}, w.deps),
    completeEnrollment(issued.token, {}, w.deps),
  ]);
  const c = await completeEnrollment(issued.token, {}, w.deps); // and a reload

  assert.equal(w.arbCalls.create.length, 1, 'a second ARB subscription was created');
  assert.equal(w.prisma.tenantSubscriptionCharge.rows.length, 1, 'the ledger gained a phantom row');
  assert.equal(w.prisma.tenantSubscription.rows.length, 1);
  for (const r of [a, b, c]) assert.ok(['enrolled', 'in_progress'].includes(r.status), r.status);
  assert.equal(c.trialing, false, 'the re-rendered receipt drifted into calling it a trial');
});

// ═══ WHAT THE OPERATOR'S ROW SAYS ═══════════════════════════════════════════

test('the tenants row reports ACTIVE with a first charge, and no trial', async () => {
  const w = await world();
  await enroll(w);
  const summary = await summariseTenantBilling(['tenant_vph'], w.deps);
  const row = summary.get('tenant_vph');

  assert.equal(row.status, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(row.amount, '1650');
  assert.equal(row.nextChargeDate, FIRST_CHARGE);
  assert.equal(row.startDate, FIRST_CHARGE, 'startDate === nextChargeDate is how the row says "first"');
  assert.equal(row.trialEndsAt, null);
  assert.equal(row.cardLast4, '1881');
});

test('a tenant nobody enrolled reports NONE rather than going missing', async () => {
  // The most important row on the list: revenue nobody remembered to collect.
  const w = await world();
  const summary = await summariseTenantBilling(['tenant_vph', 'tenant_ghost'], w.deps);
  assert.equal(summary.get('tenant_vph').status, 'NONE');
  assert.equal(summary.get('tenant_ghost').status, 'NONE');
});
