/**
 * The SUPER_ADMIN billing panel — Phase 4.
 *
 * THE TEST THIS FILE EXISTS FOR is the first one under THE CANCEL INVARIANT
 * below. Phase 3 pinned §2.2's worst outcome by ABSENCE — a grep proving no code
 * path wrote CANCELLED, because no cancel action existed yet — and left written
 * instructions that when Phase 4 added the real cancel, that test be replaced by
 * one asserting ARBCancelSubscriptionRequest is called FIRST and that a throw or
 * a timeout leaves the row uncancelled. That replacement is here, done
 * behaviourally: the ARB stub inspects the database AT THE MOMENT IT IS CALLED
 * and fails if our row has already been marked. Ordering is asserted, not hoped
 * for, and a future refactor that moved the DB write above the ARB call would
 * fail this suite rather than quietly start charging people who cancelled.
 *
 * The narrowed grep that remains in billing-enroll-link.test.mjs still fences
 * the two ENROLLMENT services, which must never write CANCELLED by any path.
 *
 * DB-free, like every billing suite: the fake Prisma is the house harness and
 * the `npm test` chain has to run on a laptop with no Postgres.
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
const { SUBSCRIPTION_STATUS } = await import('./billing.service.js');
const { AUDIT_ACTIONS, AUDIT_OUTCOME } = await import('../audit/audit.service.js');
const {
  getBillingOverview,
  getTenantBillingDetail,
  getBillingHealth,
  cancelSubscriptionForTenant,
  suspendTenantAccess,
  restoreTenantAccess,
  applyPlanToEntitlements,
  sendUpdatePaymentLink,
  revokeOutstandingInvites,
  refreshFromAuthorizeNet,
  monthlyValue,
  sortBySeverity,
  cardExpiryWarning,
  CANCEL_CONFIRMATION,
} = await import('./billing-admin.service.js');

const NOW = new Date('2026-08-26T14:00:00Z');
const TODAY = '2026-08-26';

const CATALOG = [
  { code: 'STARTER', name: 'RFM Starter', billable: true, priceMonthly: 99, maxUsers: 5, isActive: true },
  { code: 'PRO', name: 'RFM Pro', billable: true, priceMonthly: 199, maxUsers: 25, isActive: true },
  { code: 'LEGACY', name: 'Legacy', billable: false, isActive: false },
];

async function world() {
  const prisma = makePrisma();
  const audit = makeAuditSpy();
  const calls = { cancel: [], status: [], notify: [] };
  await saveTenantPlanCatalog(CATALOG, prisma);

  const deps = {
    prisma,
    logger: silentLogger,
    now: () => NOW,
    recordAudit: audit.recordAudit,
    cancelSubscription: async (id) => { calls.cancel.push(id); },
    getSubscriptionStatus: async (id) => { calls.status.push(id); return 'active'; },
    notifyOwner: async (kind, sub, extra) => { calls.notify.push({ kind, extra }); return { sent: true }; },
  };
  return { prisma, audit, deps, calls };
}

async function tenant(w, over = {}) {
  return w.prisma.tenant.create({
    data: {
      id: over.id || 'tenant_1',
      name: over.name || 'Corpusa Fleet',
      slug: over.slug || 'corpusa-fleet',
      status: over.status || 'ACTIVE',
      plan: over.plan || 'PRO',
      billingSuspendedAt: over.billingSuspendedAt ?? null,
      ...over,
    },
  });
}

async function subscription(w, over = {}) {
  return w.prisma.tenantSubscription.create({
    data: {
      tenantId: over.tenantId || 'tenant_1',
      planCode: over.planCode || 'PRO',
      planNameSnapshot: over.planNameSnapshot || 'RFM Pro',
      amount: over.amount ?? 199,
      currency: 'USD',
      intervalUnit: over.intervalUnit || 'months',
      intervalLength: over.intervalLength ?? 1,
      status: over.status || SUBSCRIPTION_STATUS.ACTIVE,
      arbSubscriptionId: over.arbSubscriptionId === undefined ? 'arb_9471226' : over.arbSubscriptionId,
      customerProfileId: over.customerProfileId === undefined ? 'cust_1' : over.customerProfileId,
      startDate: over.startDate || '2026-04-19',
      nextChargeDate: over.nextChargeDate === undefined ? '2026-09-19' : over.nextChargeDate,
      authorizedEmail: over.authorizedEmail || 'rmarrero@corpusafleet.test',
      ...over,
    },
  });
}

const CANCEL_INPUT = {
  confirm: CANCEL_CONFIRMATION,
  reason: 'Customer gave 30 days notice on 2026-07-27.',
  actorUserId: 'user_super',
  actorRole: 'SUPER_ADMIN',
};

// ═══ THE CANCEL INVARIANT ═══════════════════════════════════════════════════
// §2.2's worst outcome: a row marked CANCELLED whose ARB subscription is still
// live keeps charging a card belonging to somebody who believes they cancelled.

test('CANCEL IS ARB-FIRST: our row is still uncancelled at the moment ARB is called', async () => {
  // The ordering proof. The stub reads the database from inside the ARB call, so
  // an implementation that marked the row first would fail HERE rather than in
  // production, months later, on somebody's statement.
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);

  let statusAtArbCallTime = null;
  w.deps.cancelSubscription = async (arbId) => {
    w.calls.cancel.push(arbId);
    const row = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
    statusAtArbCallTime = row.status;
  };

  await cancelSubscriptionForTenant({ ...CANCEL_INPUT, subscriptionId: sub.id }, w.deps);

  assert.equal(w.calls.cancel.length, 1, 'Authorize.Net was never called');
  assert.equal(w.calls.cancel[0], 'arb_9471226');
  assert.equal(
    statusAtArbCallTime,
    SUBSCRIPTION_STATUS.ACTIVE,
    'the row was marked CANCELLED BEFORE Authorize.Net confirmed — this is the bug §2.2 names as the worst in the module',
  );
  const after = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(after.status, SUBSCRIPTION_STATUS.CANCELLED);
});

test('when ARB THROWS the row stays live — not cancelled, and not deleted', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  w.deps.cancelSubscription = async () => { throw new Error('E00027 declined'); };

  await assert.rejects(
    () => cancelSubscriptionForTenant({ ...CANCEL_INPUT, subscriptionId: sub.id }, w.deps),
    /still live/,
  );

  const after = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(after.status, SUBSCRIPTION_STATUS.ACTIVE, 'a failed ARB cancel still marked our row');
  assert.equal(after.cancelledAt ?? null, null);
  assert.equal(after.lastFailureCode, 'ARB_CANCEL_FAILED');
  assert.equal(w.prisma.tenantSubscription.rows.length, 1, 'the row was deleted rather than left alone');
});

test('when ARB TIMES OUT the row stays live, is flagged UNKNOWN, and the owner is told', async () => {
  // The dangerous one: we do not know whether the cancel took effect. Erring
  // toward "we still think we are billing them" is visible and correctable;
  // the opposite error is silent.
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  w.deps.cancelSubscription = async () => { throw new Error('ARBCancelSubscriptionRequest timed out after 20000ms'); };

  await assert.rejects(
    () => cancelSubscriptionForTenant({ ...CANCEL_INPUT, subscriptionId: sub.id }, w.deps),
    /unknown whether the subscription was cancelled/,
  );

  const after = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(after.status, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(after.lastFailureCode, 'ARB_CANCEL_TIMEOUT');
  assert.equal(w.calls.notify.length, 1, 'nobody was told the state is unknown');
  assert.match(w.calls.notify[0].extra.detectedBy, /UNKNOWN/);
});

test('a failed cancel is audited as a FAILURE, with no state change beside it', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  w.deps.cancelSubscription = async () => { throw new Error('nope'); };

  await assert.rejects(() => cancelSubscriptionForTenant({ ...CANCEL_INPUT, subscriptionId: sub.id }, w.deps));

  const rows = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.SUBSCRIPTION_CANCEL);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, AUDIT_OUTCOME.FAILURE);
  assert.equal(rows[0].metadata.failure, 'ARB_CANCEL_FAILED');
});

test('a successful cancel clears the next charge date and revokes outstanding links', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  const invite = await w.prisma.autopayInvite.create({
    data: {
      tokenHash: 'h1', tokenPrefix: 'abcd1234', mode: 'update', tenantId: 'tenant_1',
      subscriptionId: sub.id, merchantCustomerId: 'tenant_1', email: 'a@b.test',
      companyName: 'Corpusa', planCode: 'PRO', planName: 'RFM Pro', amount: 199,
      startDate: '2026-04-19', disclosureText: 'x', disclosureHash: 'y',
      expiresAt: new Date('2026-09-09T00:00:00Z'),
    },
  });

  await cancelSubscriptionForTenant({ ...CANCEL_INPUT, subscriptionId: sub.id }, w.deps);

  const after = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(after.status, SUBSCRIPTION_STATUS.CANCELLED);
  assert.deepEqual(after.cancelledAt, NOW);
  assert.equal(after.cancelReason, CANCEL_INPUT.reason);
  assert.equal(after.nextChargeDate, null, 'a stale charge date keeps feeding detector 3 a charge that can never happen');

  const afterInvite = await w.prisma.autopayInvite.findUnique({ where: { id: invite.id } });
  assert.ok(afterInvite.revokedAt, 'an outstanding link outlived the subscription it would have activated');

  const rows = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.SUBSCRIPTION_CANCEL);
  assert.equal(rows[0].outcome, AUDIT_OUTCOME.SUCCESS);
  assert.equal(rows[0].metadata.arbCallSkipped, false);
});

test('a PENDING row with NO ARB subscription skips the ARB call — there is nothing over there', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w, {
    status: SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION,
    arbSubscriptionId: null,
    customerProfileId: null,
  });

  await cancelSubscriptionForTenant({ ...CANCEL_INPUT, subscriptionId: sub.id }, w.deps);

  assert.equal(w.calls.cancel.length, 0, 'called Authorize.Net about a subscription that never existed there');
  const after = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(after.status, SUBSCRIPTION_STATUS.CANCELLED);
  const rows = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.SUBSCRIPTION_CANCEL);
  assert.equal(rows[0].metadata.arbCallSkipped, true, 'the trail must say the ARB call was skipped, and why it was safe');
});

test('a PENDING row that DOES have an ARB subscription still calls ARB first', async () => {
  // The stale-state case: the return leg timed out after ARB accepted the
  // create. Skipping on status alone would mark CANCELLED a subscription that is
  // very much alive and charging.
  const w = await world();
  await tenant(w);
  const sub = await subscription(w, {
    status: SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION,
    arbSubscriptionId: 'arb_orphan',
  });

  await cancelSubscriptionForTenant({ ...CANCEL_INPUT, subscriptionId: sub.id }, w.deps);
  assert.deepEqual(w.calls.cancel, ['arb_orphan'], 'a PENDING row with a live ARB subscription skipped the cancel call');
});

test('the typed confirmation is a real lock: a wrong phrase touches nothing', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);

  await assert.rejects(
    () => cancelSubscriptionForTenant({ ...CANCEL_INPUT, confirm: 'yes', subscriptionId: sub.id }, w.deps),
    /Type "CANCEL SUBSCRIPTION"/,
  );
  assert.equal(w.calls.cancel.length, 0, 'an unconfirmed cancel still reached Authorize.Net');
  const after = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(after.status, SUBSCRIPTION_STATUS.ACTIVE);
});

test('cancel demands a reason, and refuses a row that has already stopped', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  await assert.rejects(
    () => cancelSubscriptionForTenant({ ...CANCEL_INPUT, reason: '  ', subscriptionId: sub.id }, w.deps),
    /reason is required/,
  );

  await w.prisma.tenantSubscription.update({
    where: { id: sub.id }, data: { status: SUBSCRIPTION_STATUS.CANCELLED },
  });
  await assert.rejects(
    () => cancelSubscriptionForTenant({ ...CANCEL_INPUT, subscriptionId: sub.id }, w.deps),
    /already CANCELLED/,
  );
  assert.equal(w.calls.cancel.length, 0);
});

// ═══ "RETRY" HONESTY ════════════════════════════════════════════════════════

test('THE PANEL SHIPS NO FORCE-A-CHARGE BUTTON, and no invented retry countdown', async () => {
  /**
   * Verified at billing-events.js:11-15: a declined ARB payment SUSPENDS the
   * subscription and Authorize.Net retries nightly, but ONLY once the payment
   * method has been updated. There is no fixed retry count. So:
   *
   *   - Nothing in the panel may call chargeCustomerProfile / createTransaction.
   *     Forcing a charge would take money and STILL leave the subscription
   *     suspended at ARB — worse than the state it started in — and it is
   *     Phase 6 work besides.
   *   - Nothing may render "attempt N of M" or a predicted next-retry date.
   *     `failedAttempts` counts signals WE SAW; presenting it as a countdown
   *     Authorize.Net is running invents a deadline for the operator.
   *
   * Asserted on the source because the failure mode is CODE THAT SHOULD NOT
   * EXIST — a behavioural test can only cover the paths somebody thought to
   * write, and this arrives as a well-meant convenience button.
   */
  const files = ['./billing-admin.service.js', './billing-admin.routes.js'];
  for (const file of files) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/chargeCustomerProfile|createTransactionRequest|profileTransAuthCapture/.test(code),
      `${file} forces a charge. A "retry" that charges outside the ARB schedule does not un-suspend the `
      + 'subscription, so it takes money and still does not bill them.',
    );
    assert.ok(
      !/attempt\s*\d+\s*of|de\s*\d+\s*intento|nextRetry|retryOn|attemptsRemaining/i.test(code),
      `${file} invents a retry countdown. Authorize.Net runs no fixed retry count.`,
    );
  }
});

test('the update-payment link is the documented remedy, and it needs a live ARB subscription', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w, { status: SUBSCRIPTION_STATUS.PAST_DUE });

  const out = await sendUpdatePaymentLink({ subscriptionId: sub.id, actorUserId: 'user_super' }, w.deps);
  assert.match(out.url, /^https:\/\/example\.test\/autopay\//);
  assert.equal(out.invite.mode, 'update');
  assert.equal(out.invite.email, 'rmarrero@corpusafleet.test', 'the address that authorised the card is who can replace it');

  const rows = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.AUTOPAY_INVITE_SEND);
  assert.equal(rows[0].metadata.mode, 'update');
  assert.equal(rows[0].metadata.tokenPrefix, out.token.slice(0, 8));
  assert.ok(!JSON.stringify(rows).includes(out.token), 'a plaintext token reached the audit trail');
});

test('a subscription with no card yet is told to send an ENROLL link instead', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w, {
    status: SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION, arbSubscriptionId: null,
  });
  await assert.rejects(
    () => sendUpdatePaymentLink({ subscriptionId: sub.id }, w.deps),
    /Send an enrollment link instead/,
  );
});

test('minting a new update link kills the previous one', async () => {
  // Two live links to one subscription is two chances to repoint it at two
  // different cards.
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  const first = await sendUpdatePaymentLink({ subscriptionId: sub.id }, w.deps);
  await sendUpdatePaymentLink({ subscriptionId: sub.id }, w.deps);

  const stale = w.prisma.autopayInvite.rows.find((r) => r.tokenPrefix === first.token.slice(0, 8));
  assert.ok(stale.revokedAt, 'the superseded update link still works');
});

test('revoking outstanding invites reports how many died, and audits each', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  await sendUpdatePaymentLink({ subscriptionId: sub.id }, w.deps);

  const out = await revokeOutstandingInvites({ subscriptionId: sub.id, actorUserId: 'user_super' }, w.deps);
  assert.equal(out.revoked, 1);
  assert.equal(w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.AUTOPAY_INVITE_REVOKE).length, 1);

  // Idempotent: a second click revokes nothing rather than double-auditing.
  assert.equal((await revokeOutstandingInvites({ subscriptionId: sub.id }, w.deps)).revoked, 0);
});

test('refresh READS Authorize.Net and refuses to de-escalate a delinquency', async () => {
  // What the operator actually wants when they reach for "retry": has it gone
  // through? ARB saying `active` against our PAST_DUE is recorded, not adopted —
  // a status is not a payment, and only a settled charge clears a delinquency.
  const w = await world();
  await tenant(w);
  const sub = await subscription(w, { status: SUBSCRIPTION_STATUS.PAST_DUE, pastDueSince: new Date('2026-08-19T00:00:00Z') });

  const out = await refreshFromAuthorizeNet({ subscriptionId: sub.id }, w.deps);

  assert.deepEqual(w.calls.status, ['arb_9471226']);
  assert.equal(out.arbStatus, 'active');
  assert.equal(out.outcome, 'refused');
  assert.equal(out.status, SUBSCRIPTION_STATUS.PAST_DUE, 'a status poll laundered an unpaid invoice into a healthy row');
  assert.equal(w.calls.cancel.length, 0, 'a read-only refresh changed something at Authorize.Net');
});

test('refresh ADOPTS an escalation — ARB says canceled while we thought we were billing', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  w.deps.getSubscriptionStatus = async () => 'canceled';

  const out = await refreshFromAuthorizeNet({ subscriptionId: sub.id }, w.deps);
  assert.equal(out.outcome, 'escalated');
  assert.equal(out.status, SUBSCRIPTION_STATUS.CANCELLED);
  assert.equal(out.previousStatus, SUBSCRIPTION_STATUS.ACTIVE);
});

test('a manual suspension survives the refresh button', async () => {
  // Our SUSPENDED means "we cut their access"; ARB's `active` means "the money
  // still moves". They are not in conflict, and the de-escalation guard is what
  // stops a refresh from quietly undoing a decision a human made.
  const w = await world();
  await tenant(w, { status: 'SUSPENDED', billingSuspendedAt: NOW });
  const sub = await subscription(w, { status: SUBSCRIPTION_STATUS.SUSPENDED });

  const out = await refreshFromAuthorizeNet({ subscriptionId: sub.id }, w.deps);
  assert.equal(out.status, SUBSCRIPTION_STATUS.SUSPENDED, 'a status poll un-suspended a tenant a human switched off');
});

// ═══ MANUAL SUSPEND / RESTORE ═══════════════════════════════════════════════

test('suspend flips the tenant AND the subscription together, and stamps billingSuspendedAt', async () => {
  // §2.2's invariant: our SUSPENDED and Tenant.status must never disagree.
  const w = await world();
  await tenant(w);
  const sub = await subscription(w, { status: SUBSCRIPTION_STATUS.PAST_DUE });

  await suspendTenantAccess({ tenantId: 'tenant_1', reason: 'Impago — 7 días.', actorUserId: 'user_super' }, w.deps);

  const t = await w.prisma.tenant.findUnique({ where: { id: 'tenant_1' } });
  assert.equal(t.status, 'SUSPENDED');
  assert.deepEqual(t.billingSuspendedAt, NOW);
  const s = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(s.status, SUBSCRIPTION_STATUS.SUSPENDED);
  assert.deepEqual(s.suspendedAt, NOW);
});

test('suspend does NOT cancel at Authorize.Net, and says so in the trail', async () => {
  // Open question 6 is unanswered. The conservative half is to leave ARB alone:
  // a cancelled subscription cannot resume without the customer re-typing a
  // card, and that is not a side effect a "suspend access" button may have.
  const w = await world();
  await tenant(w);
  await subscription(w);

  await suspendTenantAccess({ tenantId: 'tenant_1', reason: 'Impago.' }, w.deps);

  assert.equal(w.calls.cancel.length, 0, 'suspending a tenant cancelled their ARB subscription');
  const row = w.audit.rows.find((r) => r.action === AUDIT_ACTIONS.TENANT_SUSPEND);
  assert.equal(row.metadata.arbSubscriptionCancelled, false);
  assert.equal(row.metadata.reason, 'Impago.');
});

test('suspend demands a reason and refuses a tenant that is already off', async () => {
  const w = await world();
  await tenant(w);
  await assert.rejects(() => suspendTenantAccess({ tenantId: 'tenant_1', reason: '' }, w.deps), /reason is required/);

  await suspendTenantAccess({ tenantId: 'tenant_1', reason: 'x' }, w.deps);
  await assert.rejects(() => suspendTenantAccess({ tenantId: 'tenant_1', reason: 'x' }, w.deps), /already suspended/);
});

test('RESTORE REFUSES a suspension billing did not set', async () => {
  // Somebody switched this tenant off by hand for a reason the billing screen
  // cannot see — a compliance hold, an offboarding. A billing button must not
  // guess that the reason has passed.
  const w = await world();
  await tenant(w, { status: 'SUSPENDED', billingSuspendedAt: null });

  await assert.rejects(
    () => restoreTenantAccess({ tenantId: 'tenant_1' }, w.deps),
    /was not suspended by billing/,
  );
  const t = await w.prisma.tenant.findUnique({ where: { id: 'tenant_1' } });
  assert.equal(t.status, 'SUSPENDED', 'a hand-set suspension was lifted from the billing panel');
});

test('restore returns a delinquent subscription to PAST_DUE, not ACTIVE', async () => {
  // Restoring access is not evidence that money moved. Marking it ACTIVE would
  // launder an unpaid invoice into a healthy row and drop it off the one list
  // that would have chased it.
  const w = await world();
  await tenant(w);
  const sub = await subscription(w, { status: SUBSCRIPTION_STATUS.PAST_DUE, pastDueSince: new Date('2026-08-19T00:00:00Z') });
  await suspendTenantAccess({ tenantId: 'tenant_1', reason: 'Impago.' }, w.deps);

  const out = await restoreTenantAccess({ tenantId: 'tenant_1', actorUserId: 'user_super' }, w.deps);

  assert.equal(out.subscriptionStatus, SUBSCRIPTION_STATUS.PAST_DUE);
  const t = await w.prisma.tenant.findUnique({ where: { id: 'tenant_1' } });
  assert.equal(t.status, 'ACTIVE');
  assert.equal(t.billingSuspendedAt, null, 'the billing marker outlived the suspension it described');
  const s = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(s.status, SUBSCRIPTION_STATUS.PAST_DUE);
  assert.equal(s.suspendedAt, null);
  assert.ok(w.audit.rows.some((r) => r.action === AUDIT_ACTIONS.TENANT_RESTORE));
});

test('restore returns a never-delinquent subscription to ACTIVE', async () => {
  const w = await world();
  await tenant(w);
  await subscription(w);
  await suspendTenantAccess({ tenantId: 'tenant_1', reason: 'Pausa acordada.' }, w.deps);

  const out = await restoreTenantAccess({ tenantId: 'tenant_1' }, w.deps);
  assert.equal(out.subscriptionStatus, SUBSCRIPTION_STATUS.ACTIVE);
});

// ═══ APPLY PLAN TO ENTITLEMENTS ═════════════════════════════════════════════

test('apply-plan moves Tenant.plan and NOTHING else — no price, no ARB call', async () => {
  const w = await world();
  await tenant(w, { plan: 'STARTER' });
  const sub = await subscription(w, { planCode: 'PRO', amount: 1650 });

  const out = await applyPlanToEntitlements({ tenantId: 'tenant_1', actorUserId: 'user_super' }, w.deps);

  assert.equal(out.previousPlan, 'STARTER');
  assert.equal(out.plan, 'PRO');
  const s = await w.prisma.tenantSubscription.findUnique({ where: { id: sub.id } });
  assert.equal(String(s.amount), '1650', 'applying entitlements re-priced a live subscriber');
  assert.equal(s.planCode, 'PRO');
  assert.equal(w.calls.cancel.length + w.calls.status.length, 0, 'an entitlement change talked to Authorize.Net');

  const row = w.audit.rows.find((r) => r.action === AUDIT_ACTIONS.TENANT_PLAN_APPLY);
  assert.equal(row.metadata.from, 'STARTER');
  assert.equal(row.metadata.to, 'PRO');
  assert.equal(row.metadata.maxUsers, 25, 'the caps the new plan implies are not on the record');
});

test('apply-plan refuses when there is nothing to reconcile, or no live subscription', async () => {
  const w = await world();
  await tenant(w, { plan: 'PRO' });
  await subscription(w, { planCode: 'PRO' });
  await assert.rejects(() => applyPlanToEntitlements({ tenantId: 'tenant_1' }, w.deps), /already entitled at PRO/);

  const w2 = await world();
  await tenant(w2, { id: 'tenant_2', plan: 'STARTER' });
  await assert.rejects(() => applyPlanToEntitlements({ tenantId: 'tenant_2' }, w2.deps), /no live subscription/);
});

test('apply-plan refuses a plan the catalog has retired', async () => {
  // Catches both "retired plan" and "typo": resolveTenantPlanConfig returns a
  // synthetic inactive entry for a code the catalog does not know.
  const w = await world();
  await tenant(w, { plan: 'PRO' });
  await subscription(w, { planCode: 'LEGACY' });
  await assert.rejects(() => applyPlanToEntitlements({ tenantId: 'tenant_1' }, w.deps), /not active in the plan catalog/);
});

// ═══ THE OVERVIEW ═══════════════════════════════════════════════════════════

test('a tenant with NO subscription is a row, not an omission', async () => {
  // The most important row on the screen: revenue that is missing rather than
  // late. An omitted tenant reads as a loading state.
  const w = await world();
  await tenant(w, { id: 'tenant_x', name: 'Autos del Valle', slug: 'autos-del-valle', plan: 'STARTER' });

  const { rows, totals } = await getBillingOverview(w.deps);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'NONE');
  assert.equal(rows[0].entitlementPlan, 'STARTER');
  assert.equal(rows[0].amount, null);
  assert.equal(totals.neverEnrolled, 1);
});

test('MRR counts ACTIVE and PAST_DUE, normalises annual, and excludes trial and suspended', async () => {
  const w = await world();
  await tenant(w, { id: 't1', name: 'A', slug: 'a' });
  await tenant(w, { id: 't2', name: 'B', slug: 'b' });
  await tenant(w, { id: 't3', name: 'C', slug: 'c' });
  await tenant(w, { id: 't4', name: 'D', slug: 'd' });
  await subscription(w, { tenantId: 't1', amount: 199, status: SUBSCRIPTION_STATUS.ACTIVE, arbSubscriptionId: 'a1' });
  await subscription(w, { tenantId: 't2', amount: 2149, intervalLength: 12, status: SUBSCRIPTION_STATUS.ACTIVE, arbSubscriptionId: 'a2' });
  await subscription(w, { tenantId: 't3', amount: 199, status: SUBSCRIPTION_STATUS.PAST_DUE, arbSubscriptionId: 'a3' });
  await subscription(w, { tenantId: 't4', amount: 99, status: SUBSCRIPTION_STATUS.TRIALING, arbSubscriptionId: 'a4' });

  const { totals } = await getBillingOverview(w.deps);
  // 199 + (2149/12 = 179.08) + 199. The trialing $99 has never charged anything.
  assert.equal(totals.mrr, 577.08);
  assert.equal(totals.active, 2);
  assert.equal(totals.pastDue, 1);
  assert.equal(totals.trialing, 1);
});

test('a suspended subscription contributes nothing to MRR', async () => {
  const w = await world();
  await tenant(w);
  await subscription(w, { status: SUBSCRIPTION_STATUS.SUSPENDED });
  const { totals } = await getBillingOverview(w.deps);
  assert.equal(totals.mrr, 0);
  assert.equal(totals.suspended, 1);
});

test('the divergence badge fires when billing and entitlement disagree', async () => {
  const w = await world();
  await tenant(w, { plan: 'STARTER' });
  await subscription(w, { planCode: 'PRO' });

  const { rows, totals } = await getBillingOverview(w.deps);
  assert.equal(rows[0].planDiverges, true);
  assert.equal(rows[0].planCode, 'PRO');
  assert.equal(rows[0].entitlementPlan, 'STARTER');
  assert.equal(totals.planDiverges, 1);
});

test('a cancelled tenant still shows its history rather than reading as never-enrolled', async () => {
  const w = await world();
  await tenant(w);
  await subscription(w, { status: SUBSCRIPTION_STATUS.CANCELLED, arbSubscriptionId: null });

  const { rows, totals } = await getBillingOverview(w.deps);
  assert.equal(rows[0].status, SUBSCRIPTION_STATUS.CANCELLED);
  assert.equal(totals.neverEnrolled, 0, '"they left" and "nobody enrolled them" are different problems');
});

test('a live row wins over a terminal one for the same tenant', async () => {
  const w = await world();
  await tenant(w);
  await subscription(w, { status: SUBSCRIPTION_STATUS.CANCELLED, arbSubscriptionId: 'old' });
  await subscription(w, { status: SUBSCRIPTION_STATUS.ACTIVE, arbSubscriptionId: 'new' });

  const { rows } = await getBillingOverview(w.deps);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(rows[0].arbSubscriptionId, 'new');
});

test('the last charge shown is the newest one', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  for (const [chargeDate, status] of [['2026-07-19', 'SETTLED'], ['2026-08-19', 'DECLINED']]) {
    await w.prisma.tenantSubscriptionCharge.create({
      data: {
        subscriptionId: sub.id, tenantId: 'tenant_1', kind: 'RECURRING', status,
        amount: 199, currency: 'USD', chargeDate, description: 'x', source: 'WEBHOOK',
      },
    });
  }
  const { rows } = await getBillingOverview(w.deps);
  assert.equal(rows[0].lastCharge.chargeDate, '2026-08-19');
  assert.equal(rows[0].lastCharge.status, 'DECLINED');
});

test('severity sorts trouble to the top, not the alphabet', async () => {
  const rows = [
    { status: SUBSCRIPTION_STATUS.ACTIVE, tenantName: 'Aaa' },
    { status: 'NONE', tenantName: 'Zzz' },
    { status: SUBSCRIPTION_STATUS.PAST_DUE, tenantName: 'Mmm' },
    { status: SUBSCRIPTION_STATUS.SUSPENDED, tenantName: 'Bbb' },
  ];
  assert.deepEqual(
    sortBySeverity(rows).map((r) => r.status),
    [SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.SUSPENDED, 'NONE', SUBSCRIPTION_STATUS.ACTIVE],
  );
});

test('monthlyValue normalises both ARB interval units and refuses nonsense', () => {
  assert.equal(monthlyValue({ amount: 199, intervalUnit: 'months', intervalLength: 1 }), 199);
  assert.equal(Math.round(monthlyValue({ amount: 2149, intervalUnit: 'months', intervalLength: 12 }) * 100) / 100, 179.08);
  assert.equal(monthlyValue({ amount: 30, intervalUnit: 'days', intervalLength: 30 }), 30);
  assert.equal(monthlyValue({ amount: 199, intervalUnit: 'months', intervalLength: 0 }), 0);
  assert.equal(monthlyValue({}), 0);
});

test('a card is good through the LAST day of its expiry month', () => {
  // Off-by-one here would warn a month early or, much worse, a month late.
  assert.equal(cardExpiryWarning({ cardExpMonth: 9, cardExpYear: 2026 }, TODAY).expired, false);
  // Expiring THIS month: inside the window, so it warns — but it is NOT dead
  // yet, because the card is good through 31 August. Reading it as expired on
  // the 26th would tell the operator to chase a card that still works.
  assert.equal(cardExpiryWarning({ cardExpMonth: 8, cardExpYear: 2026 }, TODAY).expired, false);
  assert.equal(cardExpiryWarning({ cardExpMonth: 7, cardExpYear: 2026 }, TODAY).expired, true);
  assert.equal(cardExpiryWarning({ cardExpMonth: 4, cardExpYear: 2029 }, TODAY), null);
  assert.equal(cardExpiryWarning({}, TODAY), null);
  // December rolls the year rather than producing month 13.
  assert.equal(cardExpiryWarning({ cardExpMonth: 12, cardExpYear: 2026 }, '2026-11-20').expired, false);
});

// ═══ THE DETAIL ═════════════════════════════════════════════════════════════

test('the detail carries the consent archive verbatim and the raw ARB handles', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w, {
    authorizedAt: new Date('2026-04-19T18:22:00Z'),
    authorizedIp: '24.55.18.203',
    authorizedDisclosureText: 'Corpusa Fleet autoriza a Ride Car Sharing LLC…',
    authorizedDisclosureHash: '4f2b9ac1',
  });

  const out = await getTenantBillingDetail('tenant_1', w.deps);
  assert.equal(out.subscription.id, sub.id);
  assert.equal(out.subscription.authorizedDisclosureText, 'Corpusa Fleet autoriza a Ride Car Sharing LLC…');
  assert.equal(out.subscription.authorizedIp, '24.55.18.203');
  assert.equal(out.subscription.arbSubscriptionId, 'arb_9471226');
  assert.equal(out.subscription.customerProfileId, 'cust_1');
});

test('the detail payload carries what restore will put the tenant back to', async () => {
  // Serialised for the same reason as suspensionEnforcement: the restore dialog
  // must name the status it is really going to set. Tenant.status is free text
  // and 'ACTIVE' is load-bearing (the public booking token resolver, the
  // booking-engine tenant resolution and the car-sharing marketplace list all
  // match it exactly), so a panel that says "turns the public booking site back
  // on" for a DEMO tenant is lying about a customer's public surface.
  const w = await world();
  await tenant(w, { status: 'SUSPENDED', billingSuspendedAt: NOW, billingPreviousStatus: 'DEMO' });

  const out = await getTenantBillingDetail('tenant_1', w.deps);
  assert.equal(out.tenant.billingPreviousStatus, 'DEMO');
  // THE RESOLVED ANSWER, asserted end to end. The panel renders THIS field, not
  // the raw one, and the four frontend cases feed it to a mock payload by hand —
  // so without this line nothing checks that the server emits it at all.
  // Deleting the field from getTenantBillingDetail, or pinning it to 'ACTIVE',
  // left the whole billing suite green: the restore dialog would promise
  // "returns this tenant to Active — their booking site comes back on" for a
  // DEMO tenant while the write correctly restored DEMO. A dialog promising one
  // outcome while the write performs another is the exact drift the field exists
  // to prevent.
  assert.equal(out.tenant.restoresToStatus, 'DEMO');
});

test('the detail payload reports a missing previous status as null, not as ACTIVE', async () => {
  // null is the honest answer for a tenant suspended before the column existed.
  // The ACTIVE fallback lives in restoreTenantAccess; inventing it here would
  // hide from the panel that nothing was ever recorded.
  const w = await world();
  await tenant(w, { status: 'SUSPENDED', billingSuspendedAt: NOW });

  const out = await getTenantBillingDetail('tenant_1', w.deps);
  assert.equal(out.tenant.billingPreviousStatus, null);
  // The two fields DISAGREE here, which is the point of carrying both: nothing
  // was recorded (null), and the resolved answer is still the ACTIVE fallback.
  // Asserting only the raw field would let the resolved one be anything at all.
  assert.equal(out.tenant.restoresToStatus, 'ACTIVE');
});

test('the detail renders the stored charge description, never a recomputation', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  const stored = 'Ajuste por cambio de plan: 18 días restantes del ciclo (1 jul – 18 jul) a $3.3333/día.';
  await w.prisma.tenantSubscriptionCharge.create({
    data: {
      subscriptionId: sub.id, tenantId: 'tenant_1', kind: 'PRORATION', status: 'SETTLED',
      amount: 59.94, currency: 'USD', chargeDate: '2026-07-01', description: stored,
      prorationDays: 18, fromPlanCode: 'STARTER', toPlanCode: 'PRO', source: 'ADMIN',
      transId: '80028119402',
    },
  });

  const out = await getTenantBillingDetail('tenant_1', w.deps);
  assert.equal(out.charges[0].description, stored, 'the dispute-answering sentence was rewritten');
  assert.equal(out.charges[0].transId, '80028119402');
  assert.equal(out.charges[0].prorationDays, 18);
});

test('the detail never leaks an invite token, only its prefix', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  const minted = await sendUpdatePaymentLink({ subscriptionId: sub.id }, w.deps);

  const out = await getTenantBillingDetail('tenant_1', w.deps);
  assert.equal(out.invites.length, 1);
  assert.equal(out.invites[0].tokenPrefix, minted.token.slice(0, 8));
  const serialised = JSON.stringify(out);
  assert.ok(!serialised.includes(minted.token), 'a read endpoint returned a live enrollment token');
  assert.ok(!serialised.includes('tokenHash'), 'the token hash reached a response');
});

test('the event log answers "did the webhook arrive?"', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  await w.prisma.tenantSubscriptionEvent.create({
    data: {
      notificationId: 'n-1', eventType: 'net.authorize.customer.subscription.suspended',
      subscriptionId: sub.id, arbSubscriptionId: 'arb_9471226', payload: {},
      processedAt: new Date('2026-08-26T07:40:58Z'), attempts: 1,
    },
  });

  const out = await getTenantBillingDetail('tenant_1', w.deps);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].eventType, 'net.authorize.customer.subscription.suspended');
  assert.ok(out.events[0].processedAt);
  // The raw payload stays out of the panel response — it can carry anything
  // Authorize.Net decided to echo back.
  assert.equal(out.events[0].payload, undefined);
});

test('a tenant that was never enrolled still renders a detail page', async () => {
  const w = await world();
  await tenant(w, { plan: 'STARTER' });
  const out = await getTenantBillingDetail('tenant_1', w.deps);
  assert.equal(out.subscription, null);
  assert.deepEqual(out.charges, []);
  assert.equal(out.planDiverges, false);
  assert.equal(out.tenant.plan, 'STARTER');
});

test('an unknown tenant is a 404, not an empty page', async () => {
  const w = await world();
  await assert.rejects(() => getTenantBillingDetail('nope', w.deps), /Tenant not found/);
});

// ═══ HEALTH ═════════════════════════════════════════════════════════════════

test('the silence alarm only fires when something should be producing events', async () => {
  // With no live subscription there is nothing for Authorize.Net to talk about,
  // so silence is expected rather than alarming.
  const w = await world();
  const quiet = await getBillingHealth(w.deps);
  assert.equal(quiet.silenceAlarm, false);
  assert.equal(quiet.liveSubscriptions, 0);

  await tenant(w);
  await subscription(w);
  const armed = await getBillingHealth(w.deps);
  assert.equal(armed.liveSubscriptions, 1);
  assert.equal(armed.silenceAlarm, true, 'a live subscription with zero events ever is exactly the silent-endpoint failure');
});

test('health counts unprocessed events and the ones that have given up', async () => {
  const w = await world();
  await tenant(w);
  const sub = await subscription(w);
  const mk = (notificationId, processedAt, attempts) => w.prisma.tenantSubscriptionEvent.create({
    data: { notificationId, eventType: 't', subscriptionId: sub.id, payload: {}, processedAt, attempts },
  });
  await mk('a', new Date('2026-08-26T12:00:00Z'), 1);
  await mk('b', null, 3);
  await mk('c', null, 10);

  const health = await getBillingHealth(w.deps);
  assert.equal(health.unprocessed, 2);
  assert.equal(health.unprocessedStuck, 1);
  assert.equal(health.eventsLast24h, 3);
  assert.equal(health.silenceAlarm, false);
});
