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

test('the ENROLLMENT services still cannot mark a row CANCELLED — only the audited cancel path may', async () => {
  /**
   * §2.2's worst outcome. This test was Phase 3's placeholder, which pinned the
   * invariant by ABSENCE across the whole module because no cancel action
   * existed yet, and carried instructions to replace it when Phase 4 added one.
   *
   * PHASE 4 REPLACED IT, in two halves:
   *
   *   1. The BEHAVIOURAL half now lives in billing-admin.test.mjs, under "THE
   *      CANCEL INVARIANT". It proves ARBCancelSubscriptionRequest is called
   *      FIRST — the stub reads the database from inside the ARB call and fails
   *      if our row is already marked — and that a throw and a timeout each
   *      leave the row uncancelled and undeleted. That is what the placeholder
   *      asked for, and a grep could never have shown it.
   *
   *   2. This half SURVIVES, narrowed to the two ENROLLMENT services, because
   *      the property it guards is still true of them and still worth guarding:
   *      issuing and completing an enrollment must never stop a subscription as
   *      a side effect. The failure mode is a WRITE THAT SHOULD NOT EXIST —
   *      someone adding a convenient `status: 'CANCELLED'` update in a hurry —
   *      and behaviour can only cover the paths somebody thought to test.
   *
   * billing-admin.service.js is DELIBERATELY not in this list: it is the one
   * file that may write CANCELLED, and it earns that by calling ARB first, which
   * is asserted over there rather than assumed here.
   */
  for (const file of ['./billing.service.js', './autopay-invites.service.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/status:\s*['"`]?CANCELLED/.test(code) && !/SUBSCRIPTION_STATUS\.CANCELLED\s*[,}]/.test(code),
      `${file} writes CANCELLED. Stopping a subscription is not something an enrollment path may do `
      + 'by implication. If it is a real cancel it belongs in billing-admin.service.js, which calls '
      + 'ARBCancelSubscriptionRequest FIRST and proves it in billing-admin.test.mjs.',
    );
  }
});

test('the behavioural ARB-first cancel proof still exists and still asserts ordering', async () => {
  // The guard on the replacement. Half of this invariant moved to another file
  // (see above); if that half is ever deleted or softened into a stub, the
  // narrowed grep left here would keep passing and the module would look
  // protected while the only test of the actual ordering was gone.
  const src = readFileSync(new URL('./billing-admin.test.mjs', import.meta.url), 'utf8');
  assert.match(src, /CANCEL IS ARB-FIRST/, 'the behavioural cancel-ordering test was removed');
  assert.match(
    src,
    /statusAtArbCallTime/,
    'the cancel test no longer inspects our row from INSIDE the ARB call, so it no longer proves ordering',
  );
  assert.match(src, /when ARB THROWS the row stays live/);
  assert.match(src, /when ARB TIMES OUT the row stays live/);
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
