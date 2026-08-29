/**
 * Enrollment end to end, DB-free — issue an invite, then complete the return
 * leg — plus the plan-snapshot invariant that protects existing subscribers.
 *
 * WHAT CARRIES THE OPERATION HERE:
 *   - THE SNAPSHOT. A catalog price edit must never re-price a live subscriber
 *     or rewrite what their history says they agreed to. That is the difference
 *     between a price change and a billing scandal.
 *   - IDEMPOTENCY. A refresh, a double-click or back-then-forward must never
 *     produce a second ARB subscription. Two guards, tested separately.
 *   - FAILING TOWARD UNDER-BILLING. A create that throws leaves the tenant with
 *     no subscription and a retryable link. A create that TIMES OUT leaves the
 *     invite consumed, because we do not know whether money will move and a
 *     released invite is how somebody gets two subscriptions.
 *   - NOTHING CHARGES. The row this phase writes is PENDING; ARB moves money on
 *     startDate, and only a webhook or the reconciler may ever call it settled.
 *   - NO PAN, ANYWHERE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

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
  resolvePlanOffer,
  SUBSCRIPTION_STATUS,
  CHARGE_STATUS,
  CHARGE_SOURCE,
} = await import('./billing.service.js');
const { AUDIT_ACTIONS } = await import('../audit/audit.service.js');

const NOW = new Date('2026-08-27T12:00:00Z');

const PRICED_CATALOG = [
  { code: 'BETA', name: 'Beta', billable: false },
  { code: 'PRO', name: 'Pro', billable: true, priceMonthly: 199, priceAnnual: 1990, trialDays: 0 },
  { code: 'STARTER', name: 'Starter', billable: true, priceMonthly: 99 },
  { code: 'UNPRICED', name: 'Unpriced', billable: true },
];

const METHOD = {
  customerPaymentProfileId: 'pp_55',
  maskedNumber: 'XXXX4242',
  cardType: 'Visa',
};

/** A whole world: fake DB, fake Authorize.Net, captured audit rows. */
async function world(overrides = {}) {
  const prisma = makePrisma();
  const audit = makeAuditSpy();
  const calls = { createSubscription: [], ensureCustomerProfile: [], repoint: [] };

  await prisma.tenant.create({ data: { id: 'tenant_1', name: 'Autos del Valle' } });
  await saveTenantPlanCatalog(overrides.catalog || PRICED_CATALOG, prisma);

  const deps = {
    prisma,
    logger: silentLogger,
    now: () => overrides.now || NOW,
    recordAudit: audit.recordAudit,
    ensureCustomerProfile: async (args) => {
      calls.ensureCustomerProfile.push(args);
      return 'cust_9111';
    },
    getHostedProfilePageToken: async () => 'anet-hosted-token',
    getNewestPaymentMethod: async () => (overrides.method === undefined ? METHOD : overrides.method),
    createSubscription: async (args) => {
      calls.createSubscription.push(args);
      if (overrides.createThrows) throw overrides.createThrows;
      return 'arb_7788';
    },
    updateSubscriptionPaymentMethod: async (args) => { calls.repoint.push(args); },
    hostedPageUrl: () => 'https://test.authorize.net/customer/addPayment',
  };

  return { prisma, audit, calls, deps };
}

const INVITE_INPUT = {
  tenantId: 'tenant_1',
  planCode: 'PRO',
  cycle: 'monthly',
  email: 'owner@autosdelvalle.com',
  actorUserId: 'user_super',
  actorRole: 'SUPER_ADMIN',
};

// ═══ THE SNAPSHOT ═══════════════════════════════════════════════════════════

test('a catalog price edit does NOT re-price a live subscriber', async () => {
  const w = await world();
  const { subscription } = await issueEnrollInvite(INVITE_INPUT, w.deps);
  assert.equal(subscription.planCode, 'PRO');
  assert.equal(subscription.amount, 199);
  assert.equal(subscription.planNameSnapshot, 'Pro');

  // The owner raises the list price and renames the plan.
  await saveTenantPlanCatalog(
    PRICED_CATALOG.map((p) => (p.code === 'PRO'
      ? { ...p, name: 'Pro Plus', priceMonthly: 299 }
      : p)),
    w.prisma,
  );

  const after = await w.prisma.tenantSubscription.findUnique({ where: { id: subscription.id } });
  assert.equal(after.amount, 199, 'the live subscriber was re-priced by a catalog edit');
  assert.equal(after.planNameSnapshot, 'Pro', 'the snapshot name followed the catalog');
  // The LINK still points at the catalog row, so the panel can show divergence.
  assert.equal(after.planCode, 'PRO');

  // And a NEW invite does pick up the new price — the catalog is the default
  // offered, not a retroactive instruction.
  const next = await resolvePlanOffer('PRO', 'monthly', w.deps);
  assert.equal(next.amount, 299);
  assert.equal(next.planName, 'Pro Plus');
});

test('the snapshot survives the catalog row being deleted outright', async () => {
  const w = await world();
  const { subscription } = await issueEnrollInvite(INVITE_INPUT, w.deps);
  await saveTenantPlanCatalog(PRICED_CATALOG.filter((p) => p.code !== 'PRO'), w.prisma);
  const after = await w.prisma.tenantSubscription.findUnique({ where: { id: subscription.id } });
  assert.equal(after.amount, 199);
  assert.equal(after.planNameSnapshot, 'Pro');
});

test('a negotiated amount overrides the catalog and is what gets snapshotted', async () => {
  const w = await world();
  const { subscription, invite } = await issueEnrollInvite(
    { ...INVITE_INPUT, amountOverride: 149 },
    w.deps,
  );
  assert.equal(subscription.amount, 149);
  assert.equal(invite.amount, 149);
});

// ═══ THE CATALOG REFUSES TO GUESS ═══════════════════════════════════════════

test('a plan that is not marked billable cannot back an invite', async () => {
  const w = await world();
  await assert.rejects(
    () => issueEnrollInvite({ ...INVITE_INPUT, planCode: 'BETA' }, w.deps),
    /not marked billable/,
  );
  assert.equal(w.prisma.tenantSubscription.rows.length, 0, 'a half-made subscription was left behind');
});

test('a billable plan with no price for the requested cycle is refused', async () => {
  const w = await world();
  await assert.rejects(
    () => issueEnrollInvite({ ...INVITE_INPUT, planCode: 'UNPRICED' }, w.deps),
    /no monthly price/,
  );
  await assert.rejects(
    () => issueEnrollInvite({ ...INVITE_INPUT, planCode: 'STARTER', cycle: 'annual' }, w.deps),
    /no annual price/,
  );
});

test('an unknown plan code is not billable by default', async () => {
  // A typo in a plan code must never become a charge.
  const w = await world();
  await assert.rejects(
    () => issueEnrollInvite({ ...INVITE_INPUT, planCode: 'PROO' }, w.deps),
    /not active|not marked billable/,
  );
});

test('the shipped catalog prices nothing until the owner fills it in', async () => {
  // Defaults are deliberately unpriced and not billable, so a deploy of this
  // phase cannot enroll anybody by accident.
  const w = await world({ catalog: [] });
  await assert.rejects(
    () => issueEnrollInvite(INVITE_INPUT, w.deps),
    /not marked billable/,
  );
});

// ═══ ISSUANCE ═══════════════════════════════════════════════════════════════

test('issuing an invite parks the subscription in PENDING_AUTHORIZATION', async () => {
  const w = await world();
  const { subscription, invite, token, url } = await issueEnrollInvite(INVITE_INPUT, w.deps);

  assert.equal(subscription.status, SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION);
  assert.equal(subscription.arbSubscriptionId, null);
  assert.equal(subscription.startDate, '2026-08-27');
  assert.equal(invite.subscriptionId, subscription.id);
  assert.equal(invite.mode, 'enroll');
  assert.ok(url.endsWith(`/autopay/${token}`));
  // Nothing has been charged and nothing is scheduled to be until a card lands.
  assert.equal(w.prisma.tenantSubscriptionCharge.rows.length, 0);
});

test('a trial is a DEFERRED START, not ARB trial occurrences', async () => {
  const w = await world();
  const { subscription, invite } = await issueEnrollInvite(
    { ...INVITE_INPUT, trialDays: 30 },
    w.deps,
  );
  assert.equal(subscription.startDate, '2026-09-26');
  assert.equal(subscription.trialEndsAt, '2026-09-26');
  assert.equal(invite.trialOccurrences, 0, 'ARB trial occurrences must stay off the exercised path');
  assert.equal(invite.trialAmount, null);
});

test('a start date in the past is refused before Authorize.Net can reject it', async () => {
  const w = await world();
  await assert.rejects(
    () => issueEnrollInvite({ ...INVITE_INPUT, startDate: '2026-08-01' }, w.deps),
    /cannot be in the past/,
  );
});

test('a tenant may not have two live subscriptions', async () => {
  // The real guard is a PARTIAL unique index in raw SQL, which Prisma cannot
  // express. This proves the service surfaces it as something a human can act on
  // rather than a P2002 stack trace.
  //
  // AUTHORISED, not merely existing (Phase 3): a second invite against an
  // UNauthorised PENDING row is a resend and is covered separately below. What
  // must never happen is a second subscription for a tenant whose card is
  // already charging — that is the double-billing case.
  const w = await world();
  const first = await issueEnrollInvite(INVITE_INPUT, w.deps);
  await w.prisma.tenantSubscription.update({
    where: { id: first.subscription.id },
    data: { status: SUBSCRIPTION_STATUS.ACTIVE, arbSubscriptionId: 'arb_live' },
  });
  await assert.rejects(
    () => issueEnrollInvite(INVITE_INPUT, w.deps),
    /already has a live subscription/,
  );
  assert.equal(w.prisma.tenantSubscription.rows.length, 1);
});

test('a CANCELLED subscription does not block a new one', async () => {
  const w = await world();
  const first = await issueEnrollInvite(INVITE_INPUT, w.deps);
  await w.prisma.tenantSubscription.update({
    where: { id: first.subscription.id },
    data: { status: SUBSCRIPTION_STATUS.CANCELLED },
  });
  const second = await issueEnrollInvite(INVITE_INPUT, w.deps);
  assert.ok(second.subscription.id);
});

test('the issuance audit carries the token PREFIX and never the token', async () => {
  const w = await world();
  const { token } = await issueEnrollInvite(INVITE_INPUT, w.deps);
  const row = w.audit.rows.find((r) => r.action === AUDIT_ACTIONS.AUTOPAY_INVITE_SEND);
  assert.ok(row, 'issuance was not audited');
  assert.equal(row.actorUserId, 'user_super');
  assert.equal(row.metadata.planCode, 'PRO');
  assert.equal(row.metadata.amount, '199');
  assert.equal(row.metadata.tokenPrefix, token.slice(0, 8));
  assert.ok(!JSON.stringify(row).includes(token), 'the plaintext token reached the audit trail');
});

// ═══ THE RETURN LEG ═════════════════════════════════════════════════════════

async function enrolled(overrides = {}) {
  const w = await world(overrides);
  const issued = await issueEnrollInvite(INVITE_INPUT, w.deps);
  // The customer goes through the hosted page: that is what stamps the profile.
  await w.prisma.autopayInvite.update({
    where: { id: issued.invite.id },
    data: { customerProfileId: 'cust_9111' },
  });
  return { ...w, ...issued };
}

test('the happy path activates, records the ledger row, and archives consent', async () => {
  const w = await enrolled();
  const result = await completeEnrollment(w.token, { ip: '1.2.3.4', userAgent: 'UA/1' }, w.deps);

  assert.equal(result.status, 'enrolled');
  assert.equal(result.reference, 'arb_7788');
  assert.equal(result.cardLast4, '4242');

  const sub = w.prisma.tenantSubscription.rows[0];
  assert.equal(sub.status, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(sub.arbSubscriptionId, 'arb_7788');
  assert.equal(sub.customerProfileId, 'cust_9111');
  assert.equal(sub.customerPaymentProfileId, 'pp_55');
  assert.equal(sub.cardBrand, 'Visa');
  assert.equal(sub.cardLast4, '4242');
  assert.equal(sub.currentPeriodStart, '2026-08-27');
  assert.equal(sub.currentPeriodEnd, '2026-09-26');
  assert.equal(sub.nextChargeDate, '2026-08-27');

  // Consent, next to the handle we charge.
  assert.deepEqual(sub.authorizedAt, NOW);
  assert.equal(sub.authorizedIp, '1.2.3.4');
  assert.equal(sub.authorizedUserAgent, 'UA/1');
  assert.equal(sub.authorizedEmail, 'owner@autosdelvalle.com');
  assert.equal(sub.authorizedInviteId, w.invite.id);
  assert.equal(sub.authorizedDisclosureText, w.invite.disclosureText);
  assert.equal(sub.authorizedDisclosureHash, w.invite.disclosureHash);

  // The startDate we send ARB is byte-identical to the one we stored.
  assert.equal(w.calls.createSubscription[0].startDate, '2026-08-27');
});

test('the first charge row is PENDING and explains itself in a sentence', async () => {
  const w = await enrolled();
  await completeEnrollment(w.token, {}, w.deps);

  const charges = w.prisma.tenantSubscriptionCharge.rows;
  assert.equal(charges.length, 1);
  const c = charges[0];
  // NOT settled: ARB has not charged anything, and nothing in this phase can
  // promote it. Calling this SETTLED would invent revenue.
  assert.equal(c.status, CHARGE_STATUS.PENDING);
  assert.equal(c.kind, 'RECURRING');
  assert.equal(c.source, CHARGE_SOURCE.ENROLLMENT);
  assert.equal(c.amount, 199);
  assert.equal(c.chargeDate, '2026-08-27');
  assert.equal(c.periodStart, '2026-08-27');
  assert.equal(c.periodEnd, '2026-09-26');
  assert.equal(c.transId, undefined, 'a transId before any transaction would be a fiction');
  // The stored explanation — written once, never recomputed from a catalog that
  // may since have been edited.
  assert.match(c.description, /plan Pro/);
  assert.match(c.description, /\$199\.00 USD/);
  assert.match(c.description, /27 de agosto de 2026/);
  assert.match(c.description, /26 de septiembre de 2026/);
});

test('a TRIAL lands in TRIALING, not ACTIVE', async () => {
  // Days the customer was PROMISED FREE. Contrast the deferred-start suite in
  // billing-deferred-start.test.mjs, which uses the same ARB mechanism and must
  // NOT be called a trial.
  const w = await world();
  const issued = await issueEnrollInvite({ ...INVITE_INPUT, trialDays: 30 }, w.deps);
  await w.prisma.autopayInvite.update({
    where: { id: issued.invite.id },
    data: { customerProfileId: 'cust_9111' },
  });
  const result = await completeEnrollment(issued.token, {}, w.deps);
  assert.equal(result.trialing, true);
  assert.equal(w.prisma.tenantSubscription.rows[0].status, SUBSCRIPTION_STATUS.TRIALING);
  // The receipt says "primer cargo" on that date, which is the whole point.
  assert.equal(result.firstChargeDate, '2026-09-26');
});

// ── Idempotency ────────────────────────────────────────────────────────────

test('calling the return leg twice does not create a second ARB subscription', async () => {
  const w = await enrolled();
  const a = await completeEnrollment(w.token, {}, w.deps);
  const b = await completeEnrollment(w.token, {}, w.deps);

  assert.equal(a.status, 'enrolled');
  assert.equal(b.status, 'enrolled');
  assert.equal(b.reference, 'arb_7788');
  assert.equal(w.calls.createSubscription.length, 1);
  assert.equal(w.prisma.tenantSubscriptionCharge.rows.length, 1, 'the ledger gained a phantom row');
});

test('two SIMULTANEOUS return-leg requests still create exactly one subscription', async () => {
  // The double-click race. Without the atomic claim both readers see a usable
  // invite, both call ARB, and the tenant is billed twice a month forever.
  const w = await enrolled();
  const [a, b] = await Promise.all([
    completeEnrollment(w.token, {}, w.deps),
    completeEnrollment(w.token, {}, w.deps),
  ]);
  assert.equal(w.calls.createSubscription.length, 1);
  assert.equal(w.prisma.tenantSubscriptionCharge.rows.length, 1);
  // The loser is never told "no method" — it either gets the receipt or an
  // honest "still working on it".
  for (const r of [a, b]) assert.ok(['enrolled', 'in_progress'].includes(r.status), r.status);
});

// ── Failure paths ──────────────────────────────────────────────────────────

test('a failed ARB create is never shown as success, and leaves the link usable', async () => {
  const w = await enrolled({ createThrows: new Error('E00027 declined') });
  const result = await completeEnrollment(w.token, {}, w.deps);

  assert.equal(result.status, 'method_saved_not_activated');
  const sub = w.prisma.tenantSubscription.rows[0];
  assert.equal(sub.status, SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION);
  assert.equal(sub.arbSubscriptionId, null);
  assert.equal(sub.lastFailureCode, 'ARB_CREATE_FAILED');
  // No ledger row: nothing is scheduled, so claiming otherwise would be a lie.
  assert.equal(w.prisma.tenantSubscriptionCharge.rows.length, 0);
  // The claim went back, because the throw tells us no ARB subscription exists.
  assert.equal(w.prisma.autopayInvite.rows[0].usedAt, null);
});

test('a TIMED-OUT create keeps the invite consumed — the state is unknown', async () => {
  // The dangerous case. A released invite here is how a tenant ends up with two
  // live subscriptions; resolution is by asking Authorize.Net, never by retry.
  const w = await enrolled({ createThrows: new Error('authorize-net ARBCreate timed out after 20000ms') });
  const result = await completeEnrollment(w.token, {}, w.deps);

  assert.equal(result.status, 'method_saved_not_activated');
  assert.equal(w.prisma.tenantSubscription.rows[0].lastFailureCode, 'ARB_CREATE_TIMEOUT');
  assert.notEqual(w.prisma.autopayInvite.rows[0].usedAt, null, 'a timeout released the invite');
  assert.equal(w.prisma.tenantSubscriptionCharge.rows.length, 0);
});

test('bailing out of the hosted form leaves the link usable', async () => {
  const w = await enrolled({ method: null });
  const result = await completeEnrollment(w.token, {}, w.deps);
  assert.equal(result.status, 'no_method');
  assert.equal(w.prisma.autopayInvite.rows[0].usedAt, null);
  assert.equal(w.calls.createSubscription.length, 0);
});

test('a dead token gets nothing at all', async () => {
  const w = await enrolled();
  assert.equal(await completeEnrollment('not-a-real-token', {}, w.deps), null);
});

test('a revoked invite cannot be completed', async () => {
  const w = await enrolled();
  await w.prisma.autopayInvite.update({
    where: { id: w.invite.id },
    data: { revokedAt: NOW },
  });
  assert.equal(await completeEnrollment(w.token, {}, w.deps), null);
  assert.equal(w.calls.createSubscription.length, 0);
});

// ── What we store, and what we never store ─────────────────────────────────

test('nothing anywhere holds a card number', async () => {
  const w = await enrolled();
  await completeEnrollment(w.token, {}, w.deps);

  const everything = JSON.stringify([
    w.prisma.tenantSubscription.rows,
    w.prisma.tenantSubscriptionCharge.rows,
    w.prisma.autopayInvite.rows,
    w.audit.rows,
  ]);
  // The masked value Authorize.Net hands back is not a PAN, but we do not keep
  // even that: brand and last4 are what every surface renders.
  assert.ok(!everything.includes('XXXX4242'), 'a masked number was persisted verbatim');
  assert.ok(!/\b\d{13,19}\b/.test(everything), 'a card-number-shaped value was persisted');
  assert.ok(everything.includes('"cardLast4":"4242"'));
});

test('the enrollment audit carries handles and card facts, never the token', async () => {
  const w = await enrolled();
  await completeEnrollment(w.token, { ip: '1.2.3.4' }, w.deps);

  const rows = w.audit.rows.filter(
    (r) => r.action === AUDIT_ACTIONS.AUTOPAY_ENROLL || r.action === AUDIT_ACTIONS.SUBSCRIPTION_CREATE,
  );
  assert.equal(rows.length, 2, 'both the consent event and the subscription creation are audited');
  for (const row of rows) {
    assert.equal(row.tenantId, 'tenant_1');
    assert.equal(row.metadata.arbSubscriptionId, 'arb_7788');
    // Fine to keep: useless without the transaction key, and support needs it
    // to look the customer up in the Authorize.Net portal.
    assert.equal(row.metadata.customerProfileId, 'cust_9111');
    assert.equal(row.metadata.cardLast4, '4242');
    assert.ok(!JSON.stringify(row).includes(w.token));
    assert.ok(!JSON.stringify(row).includes(process.env.BILLING_AUTHNET_TRANSACTION_KEY));
  }
});

test('the receipt tells the customer their own facts and no internals', async () => {
  const w = await enrolled();
  const r = await completeEnrollment(w.token, {}, w.deps);
  for (const forbidden of ['customerProfileId', 'customerPaymentProfileId', 'tenantId', 'inviteId']) {
    assert.ok(!(forbidden in r), `the receipt exposes ${forbidden}`);
  }
  assert.ok(!JSON.stringify(r).includes(w.token));
});
