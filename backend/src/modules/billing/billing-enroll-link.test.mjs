/**
 * The "Send enroll link" button — Phase 3's ONE billing write, and the fence
 * around it.
 *
 * There is no panel yet (design §7 puts that in Phase 4), so this single action
 * hangs off the existing SUPER_ADMIN /tenants row. That makes the question
 * "what must this button be unable to do?" more load-bearing than usual, because
 * for a while it is the only billing control that exists and every temptation to
 * widen it will arrive as "it would only take a moment".
 *
 * THE FENCE:
 *   - It may create a subscription for a tenant that has none.
 *   - It may RESEND against a row nobody has authorised yet — same subscription,
 *     corrected terms, old links killed.
 *   - It may NOT touch a subscription with a card behind it. Changing a running
 *     subscription's price is a plan change (§6) and stopping one is an ARB call
 *     with an invariant attached (§2.2). Neither may happen by implication.
 *
 * And the invariant that governs anything that ever does stop a subscription,
 * pinned here so it is stated in code before the code that needs it exists:
 * A ROW MARKED CANCELLED WHOSE ARB SUBSCRIPTION IS STILL LIVE IS THE WORST
 * OUTCOME IN THIS MODULE — a card belonging to somebody who believes they
 * cancelled, charged every month, invisibly.
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
const {
  issueEnrollInvite,
  completeEnrollment,
  SUBSCRIPTION_STATUS,
} = await import('./billing.service.js');
const { resolveUsableInvite } = await import('./autopay-invites.service.js');
const { AUDIT_ACTIONS } = await import('../audit/audit.service.js');

const NOW = new Date('2026-08-26T14:00:00Z');
const CATALOG = [
  { code: 'PRO', name: 'Pro', billable: true, priceMonthly: 199, trialDays: 0 },
];
const METHOD = { customerPaymentProfileId: 'pp_1', maskedNumber: 'XXXX4242', cardType: 'Visa' };

async function world() {
  const prisma = makePrisma();
  const audit = makeAuditSpy();
  const calls = { create: [] };
  await prisma.tenant.create({ data: { id: 'tenant_1', name: 'Autos del Valle', plan: 'PRO' } });
  await saveTenantPlanCatalog(CATALOG, prisma);
  const deps = {
    prisma,
    logger: silentLogger,
    now: () => NOW,
    recordAudit: audit.recordAudit,
    ensureCustomerProfile: async () => 'cust_1',
    getHostedProfilePageToken: async () => 'tok',
    getNewestPaymentMethod: async () => METHOD,
    createSubscription: async (args) => { calls.create.push(args); return 'arb_1'; },
    updateSubscriptionPaymentMethod: async () => {},
    hostedPageUrl: () => 'https://test.authorize.net/customer/addPayment',
  };
  return { prisma, audit, deps, calls };
}

const INPUT = {
  tenantId: 'tenant_1',
  planCode: 'PRO',
  cycle: 'monthly',
  email: 'owner@autosdelvalle.test',
  actorUserId: 'user_super',
  actorRole: 'SUPER_ADMIN',
};

// ═══ RESEND ═════════════════════════════════════════════════════════════════

test('a second link for an UNAUTHORISED tenant reuses the row instead of dead-ending', async () => {
  // The operator typed the wrong price and noticed before the customer clicked.
  // The partial unique index means a naive second call is a P2002 — and being
  // stuck at that moment is how a wrong price gets emailed anyway, "just to get
  // it done", and corrected never.
  const w = await world();
  const first = await issueEnrollInvite({ ...INPUT, amountOverride: 199 }, w.deps);
  const second = await issueEnrollInvite({ ...INPUT, amountOverride: 1650 }, w.deps);

  assert.equal(second.resent, true);
  assert.equal(second.subscription.id, first.subscription.id, 'a second subscription row appeared');
  assert.equal(w.prisma.tenantSubscription.rows.length, 1);
  assert.equal(second.subscription.amount, 1650, 'the corrected price did not stick');
});

test('the OLD link dies when a new one is minted', async () => {
  // Otherwise the customer who kept the first email enrolls at the price that was
  // corrected, and the corrected one sits unused looking like the truth.
  const w = await world();
  const first = await issueEnrollInvite({ ...INPUT, amountOverride: 199 }, w.deps);
  const second = await issueEnrollInvite({ ...INPUT, amountOverride: 1650 }, w.deps);

  assert.equal(await resolveUsableInvite(first.token, w.deps), null, 'the superseded link still works');
  assert.ok(await resolveUsableInvite(second.token, w.deps), 'the new link does not work');
  // Revoked, not deleted: the trail of what was sent survives.
  assert.ok(w.prisma.autopayInvite.rows.find((r) => r.id === first.invite.id).revokedAt);
});

test('a resend is audited as its own event, with the new prefix and no token', async () => {
  const w = await world();
  await issueEnrollInvite(INPUT, w.deps);
  const second = await issueEnrollInvite({ ...INPUT, amountOverride: 1650 }, w.deps);

  const rows = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.AUTOPAY_INVITE_SEND);
  assert.equal(rows.length, 2, 'the resend left no trail');
  assert.equal(rows[1].metadata.resent, true);
  assert.equal(rows[1].metadata.amount, '1650');
  assert.equal(rows[1].metadata.tokenPrefix, second.token.slice(0, 8));
  assert.ok(!JSON.stringify(rows).includes(second.token), 'a plaintext token reached the audit trail');
});

// ═══ THE FENCE ══════════════════════════════════════════════════════════════

test('once a card is authorised the button refuses, and touches nothing', async () => {
  // THE LINE. Past this point the subscription is charging a real card on a real
  // schedule; re-pricing it silently, or minting a link that would create a
  // second one, is the double-billing case.
  const w = await world();
  const issued = await issueEnrollInvite(INPUT, w.deps);
  await w.prisma.autopayInvite.update({
    where: { id: issued.invite.id }, data: { customerProfileId: 'cust_1' },
  });
  await completeEnrollment(issued.token, {}, w.deps);
  assert.equal(w.prisma.tenantSubscription.rows[0].status, SUBSCRIPTION_STATUS.ACTIVE);

  await assert.rejects(
    () => issueEnrollInvite({ ...INPUT, amountOverride: 9999 }, w.deps),
    /already has a live subscription/,
  );

  const sub = w.prisma.tenantSubscription.rows[0];
  assert.equal(w.prisma.tenantSubscription.rows.length, 1);
  assert.equal(sub.amount, 199, 'a refused resend re-priced a live subscription anyway');
  assert.equal(sub.arbSubscriptionId, 'arb_1');
  assert.equal(w.calls.create.length, 1, 'a refused resend still called Authorize.Net');
});

test('a PAST_DUE or SUSPENDED tenant is refused too — those have live ARB subscriptions', async () => {
  for (const status of [SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.SUSPENDED, SUBSCRIPTION_STATUS.TRIALING]) {
    const w = await world();
    const first = await issueEnrollInvite(INPUT, w.deps);
    await w.prisma.tenantSubscription.update({
      where: { id: first.subscription.id },
      data: { status, arbSubscriptionId: 'arb_live' },
    });
    await assert.rejects(
      () => issueEnrollInvite(INPUT, w.deps),
      /already has a live subscription/,
      `${status} was allowed to be re-enrolled`,
    );
  }
});

test('a PENDING row that somehow has an ARB subscription is refused, not reused', async () => {
  // Belt and braces for the one state that should not exist: the return leg
  // timed out after ARB accepted the create, so our status is stale but a
  // subscription IS live over there. Reusing that row would mint a link that
  // creates a SECOND ARB subscription for the same tenant.
  const w = await world();
  const first = await issueEnrollInvite(INPUT, w.deps);
  await w.prisma.tenantSubscription.update({
    where: { id: first.subscription.id },
    data: { arbSubscriptionId: 'arb_orphan' },
  });
  await assert.rejects(() => issueEnrollInvite(INPUT, w.deps), /already has a live subscription/);
});

test('a CANCELLED subscription does not block a fresh enrollment', async () => {
  const w = await world();
  const first = await issueEnrollInvite(INPUT, w.deps);
  await w.prisma.tenantSubscription.update({
    where: { id: first.subscription.id },
    data: { status: SUBSCRIPTION_STATUS.CANCELLED },
  });
  const second = await issueEnrollInvite(INPUT, w.deps);
  assert.equal(second.resent, false, 'a terminal row was resurrected instead of superseded');
  assert.notEqual(second.subscription.id, first.subscription.id);
});

// ═══ THE CANCEL INVARIANT ═══════════════════════════════════════════════════

test('nothing in Phase 3 can mark a row CANCELLED — the ARB call has no caller yet', async () => {
  /**
   * §2.2's worst outcome, enforced by ABSENCE rather than by hope.
   *
   * A row marked CANCELLED whose ARB subscription is still live keeps charging a
   * card belonging to somebody who believes they cancelled. Phase 3 ships no
   * cancel ACTION at all — the panel's cancel button is Phase 4 — so the safe
   * property today is that no code path writes that status without calling
   * Authorize.Net first.
   *
   * This greps the two services Phase 3 owns rather than asserting on behaviour,
   * because the failure mode is a WRITE THAT SHOULD NOT EXIST: a behavioural test
   * can only check the paths somebody thought to test, and the way this bug
   * arrives is someone adding a convenient `status: 'CANCELLED'` update in a
   * hurry. When Phase 4 adds the real cancel, this test must be replaced by one
   * that asserts ARBCancelSubscriptionRequest is called FIRST and that a throw or
   * a timeout leaves the row uncancelled — not deleted.
   */
  for (const file of ['./billing.service.js', './autopay-invites.service.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/status:\s*['"`]?CANCELLED/.test(code) && !/SUBSCRIPTION_STATUS\.CANCELLED\s*[,}]/.test(code),
      `${file} writes CANCELLED. If that is a real cancel path it MUST call `
      + 'ARBCancelSubscriptionRequest first, and this test must be replaced by one that proves it.',
    );
  }
});

test('the reconciler is still the thing that catches cancelled-here-live-at-ARB', async () => {
  // The detector exists in Phase 2 and Phase 3 must not have removed it: a
  // recently-cancelled row is still polled, and ARB saying "active" is surfaced
  // rather than adopted. Asserted on the source so this suite stays DB-free and
  // does not duplicate billing-reconcile.test.mjs's own coverage.
  const src = readFileSync(new URL('./billing-reconcile.service.js', import.meta.url), 'utf8');
  assert.match(src, /recentlyStopped/, 'the cancelled-but-live poll was removed');
  assert.match(src, /SUBSCRIPTION_STATUS\.CANCELLED,\s*SUBSCRIPTION_STATUS\.EXPIRED/);
});
