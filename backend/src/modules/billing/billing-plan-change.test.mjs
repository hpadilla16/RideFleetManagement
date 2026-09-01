/**
 * Plan changes + proration — Phase 6.
 *
 * The suite pins, in order of cost-of-being-wrong:
 *
 *   1. THE BOUNDARY APPLY IS IDEMPOTENT. Two workers hitting the same due
 *      change apply it ONCE: both may call ARB (idempotent there — same
 *      amount twice is the same amount), but the database claim admits one,
 *      and one audit row + one synthetic event exist afterwards.
 *   2. THE DEFAULT MOVES NO MONEY. Scheduling writes three pending columns
 *      and speaks to nobody; the change is undoable until the boundary; a
 *      cancelled subscription's pending change dies with it.
 *   3. PRORATION IS OPT-IN, UPGRADES-ONLY, AND FAILS TOWARD "NOTHING
 *      HAPPENED" (§6.5): write-before-call proven behaviourally (the charge
 *      stub reads the DB and finds the PENDING row already there), a decline
 *      leaves the old plan standing, an unknown-state attempt is NEVER
 *      auto-retried, and a stale preview number refuses to charge.
 *   4. THE ARITHMETIC. Inclusive day counts, UTC-pinned, the §1.3 sentence
 *      stored once with the numbers actually used.
 *
 * DB-free, like every billing suite — the fake Prisma is the house harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.BILLING_AUTHNET_ENV = 'sandbox';
process.env.BILLING_AUTHNET_LOGIN_ID = 'test-login';
process.env.BILLING_AUTHNET_TRANSACTION_KEY = 'test-key';
process.env.BILLING_BASE_URL = 'https://example.test';

const { makePrisma, makeAuditSpy, silentLogger } = await import('./billing-test-prisma.mjs');
const { saveTenantPlanCatalog } = await import('../../lib/tenant-plan-limits.js');
const { SUBSCRIPTION_STATUS, CHARGE_STATUS, CHARGE_KIND } = await import('./billing.service.js');
const { AUDIT_ACTIONS, AUDIT_OUTCOME } = await import('../audit/audit.service.js');
const { BILLING_EVENT } = await import('./billing-events.js');
const {
  PRORATION_FLOOR,
  daysBetween,
  computeProration,
  buildProrationChargeDescription,
  nextPeriodBoundary,
  previewPlanChange,
  scheduleSubscriptionPlanChange,
  cancelPendingPlanChange,
  applyDuePlanChanges,
  changePlanWithProrationNow,
} = await import('./billing-plan-change.service.js');
const { runBillingReconcile } = await import('./billing-reconcile.service.js');
const { cancelSubscriptionForTenant, getTenantBillingDetail, CANCEL_CONFIRMATION } =
  await import('./billing-admin.service.js');

const NOW = new Date('2026-09-16T14:00:00Z');
const TODAY = '2026-09-16';

const CATALOG = [
  { code: 'STARTER', name: 'RFM Starter', billable: true, priceMonthly: 99, isActive: true },
  { code: 'PRO', name: 'RFM Pro', billable: true, priceMonthly: 199, priceAnnual: 1990, isActive: true },
  { code: 'RETIRED', name: 'Old Plan', billable: true, priceMonthly: 50, isActive: false },
  { code: 'NOPRICE', name: 'Negotiated Only', billable: false, isActive: true },
];

async function world({ now = NOW } = {}) {
  const prisma = makePrisma();
  const audit = makeAuditSpy();
  const calls = { arbUpdate: [], charge: [], notify: [] };
  await saveTenantPlanCatalog(CATALOG, prisma);
  await prisma.tenant.create({ data: { id: 'tenant_1', name: 'Corpusa Fleet', slug: 'corpusa', status: 'ACTIVE', plan: 'STARTER' } });

  const deps = {
    prisma,
    logger: silentLogger,
    now: () => now,
    recordAudit: audit.recordAudit,
    notifyOwner: async (kind, sub, extra) => { calls.notify.push({ kind, extra }); return { sent: true }; },
    updateSubscriptionAmount: async (arbId, amount) => { calls.arbUpdate.push({ arbId, amount }); },
    chargeCustomerProfile: async (args) => {
      calls.charge.push(args);
      return { approved: true, declined: false, held: false, transId: 'tx_777', authCode: 'A1', responseCode: '1', code: null };
    },
  };
  return { prisma, audit, deps, calls };
}

async function subscription(w, over = {}) {
  return w.prisma.tenantSubscription.create({
    data: {
      tenantId: 'tenant_1',
      planCode: 'STARTER',
      planNameSnapshot: 'RFM Starter',
      amount: 99,
      currency: 'USD',
      intervalUnit: 'months',
      intervalLength: 1,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      arbSubscriptionId: 'arb_1',
      customerProfileId: 'cust_1',
      customerPaymentProfileId: 'pay_1',
      startDate: '2026-04-01',
      // A 30-day September period: charged the 1st, covers the 1st–30th.
      currentPeriodStart: '2026-09-01',
      currentPeriodEnd: '2026-09-30',
      nextChargeDate: '2026-10-01',
      pendingPlanCode: null,
      pendingAmount: null,
      pendingEffectiveDate: null,
      ...over,
    },
  });
}

const ACTOR = { actorUserId: 'user_super', actorEmail: 'hp@ride.test', actorRole: 'SUPER_ADMIN' };

// ═══ THE ARITHMETIC (§6.1) ══════════════════════════════════════════════════

test('daysBetween is UTC-pinned and directional', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-30'), 29);
  assert.equal(daysBetween('2026-09-30', '2026-09-01'), -29);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1); // 2026 is not a leap year
  assert.equal(daysBetween('2026-01-01', '2026-01-01'), 0);
});

test('computeProration: inclusive day counts on a 30-day month', () => {
  // Period Sep 1–30 = 30 days. Change on the 16th → 15 days remain (16th–30th
  // inclusive: the day the operator clicks is the first day on the new plan).
  const p = computeProration({
    currentPeriodStart: '2026-09-01',
    currentPeriodEnd: '2026-09-30',
    today: '2026-09-16',
    oldAmount: 99,
    newAmount: 199,
  });
  assert.equal(p.periodDays, 30);
  assert.equal(p.remainingDays, 15);
  assert.equal(p.dailyDelta, Number((100 / 30).toFixed(4)));
  assert.equal(p.proration, 50); // (100/30) * 15 = 50.00
});

test('computeProration clamps: a change on the last day pays one day, never a negative count', () => {
  const last = computeProration({
    currentPeriodStart: '2026-09-01', currentPeriodEnd: '2026-09-30', today: '2026-09-30', oldAmount: 99, newAmount: 199,
  });
  assert.equal(last.remainingDays, 1);
  const past = computeProration({
    currentPeriodStart: '2026-09-01', currentPeriodEnd: '2026-09-30', today: '2026-10-02', oldAmount: 99, newAmount: 199,
  });
  assert.equal(past.remainingDays, 0);
  assert.equal(past.proration, 0);
});

test('the stored proration sentence carries the numbers actually used', () => {
  const s = buildProrationChargeDescription({
    fromPlanName: 'RFM Starter', toPlanName: 'RFM Pro', fromAmount: 99, toAmount: 199,
    remainingDays: 15, dailyDelta: 3.3333, periodStart: '2026-09-16', periodEnd: '2026-09-30',
  });
  assert.match(s, /15 día/);
  assert.match(s, /\$3\.33\/día/);
  assert.match(s, /RFM Starter \(\$99\.00\)/);
  assert.match(s, /RFM Pro \(\$199\.00\)/);
  assert.match(s, /16 de septiembre/);
  assert.match(s, /30 de septiembre/);
});

test('nextPeriodBoundary is the day BEFORE the charge — the last day an ARB update reliably lands', () => {
  assert.equal(nextPeriodBoundary({ currentPeriodEnd: '2026-09-30', nextChargeDate: '2026-10-01' }), '2026-09-30');
  // A deferred start has no period yet; the boundary derives from the charge.
  assert.equal(nextPeriodBoundary({ currentPeriodEnd: null, nextChargeDate: '2026-10-01' }), '2026-09-30');
  assert.equal(nextPeriodBoundary({ currentPeriodEnd: null, nextChargeDate: null }), null);
});

// ═══ SCHEDULING — THE DEFAULT MOVES NO MONEY ════════════════════════════════

test('scheduling writes the three pending columns and speaks to nobody', async () => {
  const w = await world();
  const sub = await subscription(w);

  const out = await scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'PRO', ...ACTOR }, w.deps);

  assert.equal(out.pendingPlanCode, 'PRO');
  assert.equal(out.pendingAmount, '199'); // catalog price for the monthly cycle
  assert.equal(out.pendingEffectiveDate, '2026-09-30'); // the boundary, not the charge date
  assert.equal(out.firstChargedOn, '2026-10-01'); // what the panel tells the operator

  // NOTHING moved: no ARB call, no charge row, and the live price is untouched.
  assert.equal(w.calls.arbUpdate.length, 0);
  assert.equal(w.calls.charge.length, 0);
  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(String(row.amount), '99');
  assert.equal(row.planCode, 'STARTER');

  const audit = w.audit.rows.find((r) => r.action === AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CHANGE_SCHEDULE);
  assert.ok(audit, 'scheduling is a money-affecting decision and must be audited');
  assert.equal(audit.actorUserId, 'user_super');
  assert.equal(audit.metadata.toAmount, '199');
  assert.equal(audit.metadata.effectiveDate, '2026-09-30');
});

test('a negotiated amount skips the catalog price and never edits the catalog', async () => {
  const w = await world();
  const sub = await subscription(w);
  const out = await scheduleSubscriptionPlanChange(
    { subscriptionId: sub.id, planCode: 'NOPRICE', amount: 1650, ...ACTOR }, w.deps,
  );
  assert.equal(out.pendingAmount, '1650');
});

test('an amount-only change keeps the plan and still schedules', async () => {
  const w = await world();
  const sub = await subscription(w);
  const out = await scheduleSubscriptionPlanChange({ subscriptionId: sub.id, amount: 120, ...ACTOR }, w.deps);
  assert.equal(out.pendingPlanCode, 'STARTER');
  assert.equal(out.pendingAmount, '120');
});

test('refusals: no-op, double-schedule, retired plan, missing price, bad dates', async () => {
  const w = await world();
  const sub = await subscription(w);

  await assert.rejects(
    scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'STARTER', amount: 99, ...ACTOR }, w.deps),
    /Nothing would change/,
  );
  await assert.rejects(
    scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'RETIRED', ...ACTOR }, w.deps),
    /not active in the plan catalog/,
  );
  await assert.rejects(
    scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'NOPRICE', ...ACTOR }, w.deps),
    /no monthly price/,
  );
  await assert.rejects(
    scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'PRO', effectiveDate: '2026-09-01', ...ACTOR }, w.deps),
    /cannot be in the past/,
  );
  await assert.rejects(
    scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'PRO', effectiveDate: 'mañana', ...ACTOR }, w.deps),
    /calendar date/,
  );

  await scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'PRO', ...ACTOR }, w.deps);
  await assert.rejects(
    scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'PRO', ...ACTOR }, w.deps),
    /already scheduled/,
  );
});

test('refusals: the statuses a change cannot be scheduled against', async () => {
  const w = await world();
  const pending = await subscription(w, {
    id: 'sub_pend', status: SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION, arbSubscriptionId: null, tenantId: 'tenant_1',
  });
  await assert.rejects(
    scheduleSubscriptionPlanChange({ subscriptionId: pending.id, planCode: 'PRO', ...ACTOR }, w.deps),
    /PENDING_AUTHORIZATION/,
  );

  const w2 = await world();
  const susp = await subscription(w2, { status: SUBSCRIPTION_STATUS.SUSPENDED });
  await assert.rejects(
    scheduleSubscriptionPlanChange({ subscriptionId: susp.id, planCode: 'PRO', ...ACTOR }, w2.deps),
    /SUSPENDED/,
  );
});

test('a subscription with no upcoming charge has no boundary to land on', async () => {
  const w = await world();
  const sub = await subscription(w, { currentPeriodEnd: null, nextChargeDate: null, currentPeriodStart: null });
  await assert.rejects(
    scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'PRO', ...ACTOR }, w.deps),
    /no upcoming charge/,
  );
});

// ═══ CANCEL-PENDING — THE UNDO ══════════════════════════════════════════════

test('cancel-pending clears the change, audits what was discarded AND what was kept', async () => {
  const w = await world();
  const sub = await subscription(w);
  await scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'PRO', ...ACTOR }, w.deps);

  const out = await cancelPendingPlanChange({ subscriptionId: sub.id, ...ACTOR }, w.deps);
  assert.equal(out.cancelled, true);

  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.pendingPlanCode, null);
  assert.equal(row.pendingAmount, null);
  assert.equal(row.pendingEffectiveDate, null);
  assert.equal(row.planCode, 'STARTER');

  const audit = w.audit.rows.find((r) => r.action === AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CHANGE_CANCEL);
  assert.equal(audit.metadata.cancelledPlanCode, 'PRO');
  assert.equal(audit.metadata.keptPlanCode, 'STARTER');
});

test('cancel-pending refuses when nothing is scheduled', async () => {
  const w = await world();
  const sub = await subscription(w);
  await assert.rejects(cancelPendingPlanChange({ subscriptionId: sub.id, ...ACTOR }, w.deps), /nothing to cancel/i);
});

test('cancelling the SUBSCRIPTION kills its scheduled change with it', async () => {
  const w = await world();
  const sub = await subscription(w);
  await scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'PRO', ...ACTOR }, w.deps);

  await cancelSubscriptionForTenant({
    subscriptionId: sub.id, confirm: CANCEL_CONFIRMATION, reason: '30 days notice.', ...ACTOR,
  }, { ...w.deps, cancelSubscription: async () => {} });

  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.status, SUBSCRIPTION_STATUS.CANCELLED);
  assert.equal(row.pendingPlanCode, null, 'a pending change on a cancelled row waits for a boundary that can never come');
  assert.equal(row.pendingEffectiveDate, null);
});

// ═══ THE BOUNDARY APPLY ═════════════════════════════════════════════════════

async function scheduled(w, over = {}) {
  const sub = await subscription(w, over);
  await scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'PRO', ...ACTOR }, w.deps);
  return sub;
}

test('a due change applies: ARB first, then the row, then one audit and one event', async () => {
  const w = await world({ now: new Date('2026-09-30T10:00:00Z') });
  const sub = await scheduled(w);

  const counts = {};
  await applyDuePlanChanges(new Date('2026-09-30T10:00:00Z'), counts, w.deps);

  assert.equal(counts.planChangesApplied, 1);
  assert.deepEqual(w.calls.arbUpdate, [{ arbId: 'arb_1', amount: 199 }]);

  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.planCode, 'PRO');
  assert.equal(row.planNameSnapshot, 'RFM Pro'); // the snapshot moved with the plan
  assert.equal(String(row.amount), '199');
  assert.equal(row.pendingPlanCode, null);
  assert.equal(row.pendingEffectiveDate, null);

  const applies = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CHANGE_APPLY);
  assert.equal(applies.length, 1);
  assert.equal(applies[0].actorUserId, undefined, 'the sweep is unattended; the actor lives on the SCHEDULE row');
  assert.equal(applies[0].metadata.source, 'RECONCILE');

  const events = await w.prisma.tenantSubscriptionEvent.findMany({
    where: { eventType: BILLING_EVENT.RECONCILE_PLAN_CHANGE_APPLIED },
  });
  assert.equal(events.length, 1);
  assert.match(events[0].notificationId, /reconcile:reconcile\.plan-change-applied:.*:2026-09-30/);
});

test('a change whose day has not arrived is untouched', async () => {
  const w = await world({ now: new Date('2026-09-20T10:00:00Z') });
  const sub = await scheduled(w);
  const counts = {};
  await applyDuePlanChanges(new Date('2026-09-20T10:00:00Z'), counts, w.deps);
  assert.equal(counts.planChangesApplied || 0, 0);
  assert.equal(w.calls.arbUpdate.length, 0);
  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.planCode, 'STARTER');
  assert.equal(row.pendingPlanCode, 'PRO');
});

test('TWO WORKERS, ONE APPLY: the claim admits exactly one recorder', async () => {
  const w = await world({ now: new Date('2026-09-30T10:00:00Z') });
  const sub = await scheduled(w);

  // Both workers pause inside the ARB call, so both are past the read and
  // racing the claim — the worst interleaving available.
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    ...w.deps,
    updateSubscriptionAmount: async (arbId, amount) => { w.calls.arbUpdate.push({ arbId, amount }); await gate; },
  };

  const now = new Date('2026-09-30T10:00:00Z');
  const a = applyDuePlanChanges(now, {}, deps);
  const b = applyDuePlanChanges(now, {}, deps);
  release();
  await Promise.all([a, b]);

  // ARB may be called twice — updating the amount to 199 twice is 199. The
  // RECORD happens once.
  assert.ok(w.calls.arbUpdate.length >= 1);
  const applies = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CHANGE_APPLY);
  assert.equal(applies.length, 1, 'two workers recorded the same apply twice');
  const events = await w.prisma.tenantSubscriptionEvent.findMany({
    where: { eventType: BILLING_EVENT.RECONCILE_PLAN_CHANGE_APPLIED },
  });
  assert.equal(events.length, 1);
  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(String(row.amount), '199');
});

test('a second sweep after a clean apply is a no-op', async () => {
  const w = await world({ now: new Date('2026-09-30T10:00:00Z') });
  await scheduled(w);
  const now = new Date('2026-09-30T10:00:00Z');
  await applyDuePlanChanges(now, {}, w.deps);
  const counts = {};
  await applyDuePlanChanges(now, counts, w.deps);
  assert.equal(counts.planChangesApplied || 0, 0);
  assert.equal(w.calls.arbUpdate.length, 1, 'the pending fields were cleared; nothing re-queried ARB');
});

test('a change cancelled while the ARB call is in flight is NOT applied over', async () => {
  const w = await world({ now: new Date('2026-09-30T10:00:00Z') });
  const sub = await scheduled(w);

  const deps = {
    ...w.deps,
    updateSubscriptionAmount: async () => {
      // The operator cancels between the read and the claim.
      await cancelPendingPlanChange({ subscriptionId: sub.id, ...ACTOR }, w.deps);
    },
  };
  const counts = {};
  await applyDuePlanChanges(new Date('2026-09-30T10:00:00Z'), counts, deps);

  assert.equal(counts.planChangesApplied || 0, 0, 'the claim must fail against cleared pending fields');
  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.planCode, 'STARTER');
  assert.equal(String(row.amount), '99');
});

test('ARB failure leaves the pending change standing, stamps the failure, alerts once', async () => {
  const w = await world({ now: new Date('2026-09-30T10:00:00Z') });
  const sub = await scheduled(w);
  const deps = {
    ...w.deps,
    updateSubscriptionAmount: async () => { throw new Error('E00003 something'); },
  };
  const now = new Date('2026-09-30T10:00:00Z');

  const counts = {};
  await applyDuePlanChanges(now, counts, deps);
  assert.equal(counts.planChangeErrors, 1);

  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.planCode, 'STARTER', 'the customer keeps being charged the price they agreed to');
  assert.equal(row.pendingPlanCode, 'PRO', 'the retry vehicle survives');
  assert.equal(row.lastFailureCode, 'ARB_AMOUNT_UPDATE_FAILED');
  assert.equal(w.calls.notify.length, 1);

  // The next day's sweep retries but does NOT re-alert — one alarm per stretch
  // of failure, not one per day (the markPastDue rule).
  await applyDuePlanChanges(new Date('2026-10-01T10:00:00Z'), {}, deps);
  assert.equal(w.calls.notify.length, 1);
});

test('a SUSPENDED subscription is skipped by the sweep; the change waits for restore', async () => {
  const w = await world({ now: new Date('2026-09-30T10:00:00Z') });
  const sub = await scheduled(w);
  await w.prisma.tenantSubscription.update({ where: { id: sub.id }, data: { status: SUBSCRIPTION_STATUS.SUSPENDED } });
  const counts = {};
  await applyDuePlanChanges(new Date('2026-09-30T10:00:00Z'), counts, w.deps);
  assert.equal(counts.planChangesApplied || 0, 0);
  assert.equal(w.calls.arbUpdate.length, 0);
});

test('runBillingReconcile drives the pass and reports its counts', async () => {
  const w = await world({ now: new Date('2026-09-30T10:00:00Z') });
  await scheduled(w);
  const deps = {
    ...w.deps,
    now: () => new Date('2026-09-30T10:00:00Z'),
    getSubscriptionStatus: async () => 'active',
    getSubscription: async () => ({ status: 'active', transactions: [] }),
    processStoredEvent: async () => {},
  };
  const counts = await runBillingReconcile(deps);
  assert.equal(counts.planChangesApplied, 1);
  assert.equal(counts.planChangeErrors, 0);
});

// ═══ PREVIEW — THE NUMBER BEFORE THE COMMIT ═════════════════════════════════

test('preview names the boundary, the charge it first reaches, and the proration on offer', async () => {
  const w = await world();
  const sub = await subscription(w);
  const p = await previewPlanChange({ subscriptionId: sub.id, planCode: 'PRO' }, w.deps);

  assert.equal(p.noChange, false);
  assert.equal(p.upgrade, true);
  assert.equal(p.effectiveDate, '2026-09-30');
  assert.equal(p.firstChargedOn, '2026-10-01');
  assert.equal(p.prorationAvailable, true);
  assert.equal(p.proration.proration, 50);
  assert.equal(p.proration.remainingDays, 15);
  assert.match(p.proration.description, /RFM Pro/);
  // Preview writes NOTHING and calls NOBODY.
  assert.equal(w.calls.arbUpdate.length, 0);
  assert.equal(w.calls.charge.length, 0);
  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.pendingPlanCode, null);
});

test('preview offers no proration on a downgrade — that shape never moves money', async () => {
  const w = await world();
  const sub = await subscription(w, { planCode: 'PRO', planNameSnapshot: 'RFM Pro', amount: 199 });
  const p = await previewPlanChange({ subscriptionId: sub.id, planCode: 'STARTER' }, w.deps);
  assert.equal(p.upgrade, false);
  assert.equal(p.prorationAvailable, false);
  assert.equal(p.proration, null);
});

// ═══ PRORATION — OPT-IN, UPGRADES ONLY, FAILS TOWARD NOTHING (§6.2, §6.5) ═══

const PRORATE = {
  planCode: 'PRO', prorateNow: true, expectedProration: 50, ...ACTOR,
};

test('the happy path: write-before-call, settle, ARB amount, row — in that order', async () => {
  const w = await world();
  const sub = await subscription(w);

  // WRITE-BEFORE-CALL, proven behaviourally: at the moment Authorize.Net is
  // spoken to, the PENDING row with our refId already exists. A process death
  // mid-call leaves a findable row, not a mystery on a statement.
  const seenAtCallTime = [];
  const deps = {
    ...w.deps,
    chargeCustomerProfile: async (args) => {
      const rows = await w.prisma.tenantSubscriptionCharge.findMany({ where: { refId: args.refId } });
      seenAtCallTime.push(...rows.map((r) => ({ status: r.status, amount: String(r.amount) })));
      return { approved: true, declined: false, held: false, transId: 'tx_777', authCode: 'A1', responseCode: '1', code: null };
    },
  };

  const out = await changePlanWithProrationNow({ subscriptionId: sub.id, ...PRORATE }, deps);

  assert.deepEqual(seenAtCallTime, [{ status: CHARGE_STATUS.PENDING, amount: '50' }]);
  assert.equal(out.planCode, 'PRO');
  assert.equal(out.arbAmountUpdatePending, false);

  const charge = await w.prisma.tenantSubscriptionCharge.findFirst({ where: { subscriptionId: sub.id } });
  assert.equal(charge.kind, CHARGE_KIND.PRORATION);
  assert.equal(charge.status, CHARGE_STATUS.SETTLED);
  assert.equal(charge.transId, 'tx_777');
  assert.equal(String(charge.amount), '50');
  assert.equal(charge.prorationDays, 15);
  assert.equal(charge.fromPlanCode, 'STARTER');
  assert.equal(charge.toPlanCode, 'PRO');
  assert.match(charge.description, /RFM Starter \(\$99\.00\) y RFM Pro \(\$199\.00\)/);

  assert.deepEqual(w.calls.arbUpdate, [{ arbId: 'arb_1', amount: 199 }]);
  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.planCode, 'PRO');
  assert.equal(String(row.amount), '199');
  assert.equal(row.pendingPlanCode, null, 'nothing left pending on a clean immediate apply');

  const chargeAudit = w.audit.rows.find((r) => r.action === AUDIT_ACTIONS.SUBSCRIPTION_PRORATION_CHARGE);
  assert.equal(chargeAudit.outcome, AUDIT_OUTCOME.SUCCESS);
  assert.equal(chargeAudit.metadata.transId, 'tx_777');
  const applyAudit = w.audit.rows.find((r) => r.action === AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CHANGE_APPLY);
  assert.equal(applyAudit.metadata.source, 'ADMIN');
  assert.equal(applyAudit.actorUserId, 'user_super');
});

test('proration is OPT-IN: without the flag the same input schedules instead', async () => {
  const w = await world();
  const sub = await subscription(w);
  await assert.rejects(
    changePlanWithProrationNow({ subscriptionId: sub.id, planCode: 'PRO', expectedProration: 50, ...ACTOR }, w.deps),
    /opt-in/,
  );
  assert.equal(w.calls.charge.length, 0);
});

test('a stale preview number refuses to charge', async () => {
  const w = await world();
  const sub = await subscription(w);
  await assert.rejects(
    changePlanWithProrationNow({ subscriptionId: sub.id, ...PRORATE, expectedProration: 47.5 }, w.deps),
    /now \$50\.00, not the \$47\.50 previewed/,
  );
  assert.equal(w.calls.charge.length, 0, 'nothing may charge until the operator has read the current number');
});

test('downgrades never prorate; delinquent and trialing rows never prorate', async () => {
  const w = await world();
  const pro = await subscription(w, { id: 's_pro', tenantId: 'tenant_1', planCode: 'PRO', planNameSnapshot: 'RFM Pro', amount: 199 });
  await assert.rejects(
    changePlanWithProrationNow({ subscriptionId: pro.id, planCode: 'STARTER', prorateNow: true, expectedProration: -50, ...ACTOR }, w.deps),
    /only applies to an upgrade/,
  );

  const w2 = await world();
  const late = await subscription(w2, { status: SUBSCRIPTION_STATUS.PAST_DUE });
  await assert.rejects(
    changePlanWithProrationNow({ subscriptionId: late.id, ...PRORATE }, w2.deps),
    /only offered on an ACTIVE subscription/,
  );
  assert.equal(w.calls.charge.length + w2.calls.charge.length, 0);
});

test('DECLINE: the plan change does not happen — the whole compensating behaviour (§6.5)', async () => {
  const w = await world();
  const sub = await subscription(w);
  const deps = {
    ...w.deps,
    chargeCustomerProfile: async (args) => {
      w.calls.charge.push(args);
      return { approved: false, declined: true, held: false, transId: null, authCode: null, responseCode: '2', code: null };
    },
  };

  await assert.rejects(
    changePlanWithProrationNow({ subscriptionId: sub.id, ...PRORATE }, deps),
    /declined the proration charge, so the plan was not changed/i,
  );

  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.planCode, 'STARTER');
  assert.equal(String(row.amount), '99');
  assert.equal(w.calls.arbUpdate.length, 0, 'no ARB update after a decline — §6.2 step 4 never runs');

  const charge = await w.prisma.tenantSubscriptionCharge.findFirst({ where: { subscriptionId: sub.id } });
  assert.equal(charge.status, CHARGE_STATUS.DECLINED);
  const audit = w.audit.rows.find((r) => r.action === AUDIT_ACTIONS.SUBSCRIPTION_PRORATION_CHARGE);
  assert.equal(audit.outcome, AUDIT_OUTCOME.FAILURE);
  assert.equal(audit.metadata.planChangeApplied, false);
});

test('UNKNOWN STATE: ERROR row, loud alert, NO automatic retry, plan untouched (§6.5)', async () => {
  const w = await world();
  const sub = await subscription(w);
  const deps = {
    ...w.deps,
    chargeCustomerProfile: async () => { throw new Error('authorize-net createTransactionRequest timed out after 20000ms'); },
  };

  await assert.rejects(
    changePlanWithProrationNow({ subscriptionId: sub.id, ...PRORATE }, deps),
    /unknown whether the card was charged.*NOT be retried automatically/s,
  );

  const charge = await w.prisma.tenantSubscriptionCharge.findFirst({ where: { subscriptionId: sub.id } });
  assert.equal(charge.status, CHARGE_STATUS.ERROR);
  assert.ok(charge.refId, 'the refId is what makes the attempt findable at Authorize.Net');
  assert.equal(charge.transId ?? null, null);

  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.planCode, 'STARTER');
  assert.equal(w.calls.arbUpdate.length, 0);
  assert.equal(w.calls.notify.length, 1, 'a human must know today, not at the next reconcile');
  assert.match(w.calls.notify[0].extra.detectedBy, /UNKNOWN state/);

  // The reconciler does NOT retry it: the sweep only reads pending fields, and
  // none were written.
  await applyDuePlanChanges(NOW, {}, w.deps);
  const after = await w.prisma.tenantSubscriptionCharge.findFirst({ where: { subscriptionId: sub.id } });
  assert.equal(after.status, CHARGE_STATUS.ERROR);
});

test('a retry after a decline mints a NEW refId — a spent attempt is never reused', async () => {
  const w = await world();
  const sub = await subscription(w);
  const declineOnce = {
    ...w.deps,
    chargeCustomerProfile: async (args) => {
      w.calls.charge.push(args);
      return { approved: false, declined: true, held: false, transId: null, authCode: null, responseCode: '2', code: null };
    },
  };
  await assert.rejects(changePlanWithProrationNow({ subscriptionId: sub.id, ...PRORATE }, declineOnce));
  await changePlanWithProrationNow({ subscriptionId: sub.id, ...PRORATE }, w.deps);

  const refs = w.calls.charge.map((c) => c.refId);
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0], refs[1]);
  const rows = await w.prisma.tenantSubscriptionCharge.findMany({ where: { subscriptionId: sub.id } });
  assert.equal(rows.length, 2, 'each attempt is its own ledger row');
});

test('BELOW THE FLOOR: the charge is skipped entirely and the plan just changes', async () => {
  const w = await world({ now: new Date('2026-09-30T14:00:00Z') });
  // One day left at a small delta: (100/30)*1 = 3.33 → floor it with a $0.60 delta.
  const sub = await subscription(w, { amount: 199, planCode: 'PRO', planNameSnapshot: 'RFM Pro' });
  const out = await changePlanWithProrationNow({
    subscriptionId: sub.id, planCode: 'PRO', amount: 199.5, prorateNow: true, expectedProration: 0.02, ...ACTOR,
  }, w.deps);

  assert.equal(out.prorationSkipped, true);
  assert.equal(w.calls.charge.length, 0, `a charge under $${PRORATION_FLOOR} costs more in disputes than it earns`);
  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(String(row.amount), '199.5');
  const charges = await w.prisma.tenantSubscriptionCharge.findMany({ where: { subscriptionId: sub.id } });
  assert.equal(charges.length, 0);
});

test('REVERSE AMBIGUITY: money settled, ARB update fails → row adopts the paid plan, sweep retries (§6.5 rewritten)', async () => {
  const w = await world();
  const sub = await subscription(w);
  const deps = {
    ...w.deps,
    updateSubscriptionAmount: async () => { throw new Error('ARB down'); },
  };

  const out = await changePlanWithProrationNow({ subscriptionId: sub.id, ...PRORATE }, deps);
  assert.equal(out.arbAmountUpdatePending, true);

  const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(row.planCode, 'PRO', 'the customer paid for this plan; our record says so');
  assert.equal(String(row.amount), '199');
  assert.equal(row.pendingPlanCode, 'PRO', 'the retry vehicle: the daily sweep re-runs the idempotent ARB update');
  assert.equal(row.pendingEffectiveDate, TODAY);
  assert.equal(w.calls.notify.length, 1);

  const charge = await w.prisma.tenantSubscriptionCharge.findFirst({ where: { subscriptionId: sub.id } });
  assert.equal(charge.status, CHARGE_STATUS.SETTLED, 'the money really moved and the ledger says so');

  // The next sweep lands the update and clears the pending fields — no refund
  // path ever runs.
  await applyDuePlanChanges(NOW, {}, w.deps);
  const after = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(after.pendingPlanCode, null);
  assert.deepEqual(w.calls.arbUpdate, [{ arbId: 'arb_1', amount: 199 }]);
});

// ═══ THE VIEWS CARRY THE PENDING CHANGE ═════════════════════════════════════

test('the detail payload surfaces the scheduled change for the panel card', async () => {
  const w = await world();
  const sub = await subscription(w);
  await scheduleSubscriptionPlanChange({ subscriptionId: sub.id, planCode: 'PRO', ...ACTOR }, w.deps);

  const detail = await getTenantBillingDetail('tenant_1', w.deps);
  assert.equal(detail.subscription.pendingPlanCode, 'PRO');
  assert.equal(detail.subscription.pendingAmount, '199');
  assert.equal(detail.subscription.pendingEffectiveDate, '2026-09-30');
});

// ═══ SOURCE FENCES ══════════════════════════════════════════════════════════

test('the scheduled path physically cannot charge: schedule/cancel never reference the charge call', () => {
  // The default shape moves no money BY CONSTRUCTION, not by discipline: the
  // only chargeCustomerProfile call sites in the module are the proration
  // function. Grep-pinned the same way the enrollment services fence CANCELLED.
  const src = readFileSync(new URL('./billing-plan-change.service.js', import.meta.url), 'utf8');
  const scheduleBody = src.slice(src.indexOf('export async function scheduleSubscriptionPlanChange'), src.indexOf('export async function cancelPendingPlanChange'));
  const cancelBody = src.slice(src.indexOf('export async function cancelPendingPlanChange'), src.indexOf('export async function applyDuePlanChanges'));
  const applyBody = src.slice(src.indexOf('export async function applyDuePlanChanges'), src.indexOf('function mintRefId'));
  for (const [name, body] of [['schedule', scheduleBody], ['cancel-pending', cancelBody], ['boundary apply', applyBody]]) {
    assert.ok(!/chargeCustomerProfile/.test(body), `${name} must never be able to move money`);
    assert.ok(body.length > 100, `source slice for ${name} came back empty — the fence is not fencing`);
  }
});

test('no automatic retry of an unknown-state charge exists anywhere in the module', () => {
  // §6.5: "Automatic retry as the resolution path for an unknown-state card
  // charge is how you charge somebody twice. It is banned here." The ERROR
  // status is written and displayed, never queried as work to redo.
  const src = readFileSync(new URL('./billing-plan-change.service.js', import.meta.url), 'utf8');
  // The banned shape is a READ of ERROR rows (find… whose argument mentions
  // the ERROR status) — that is what a retry sweep would be built on. Writes
  // of the status are exactly what SHOULD exist.
  for (const m of src.matchAll(/\.find(?:Many|First|Unique)\(([\s\S]*?)\)\s*;/g)) {
    assert.ok(
      !/ERROR/.test(m[1]),
      'something in the plan-change service queries ERROR charges — the banned retry shape',
    );
  }
});
