/**
 * Suspension for real — Tenant Subscriptions Phase 5.
 *
 * The gate's DECISION is pinned in lib/tenant-suspension.test.mjs and its
 * WIRING in modules/auth/tenant-suspension-gate.test.mjs. This file covers the
 * three things neither of those can see:
 *
 *   1. THE CACHE BUST. Suspension must take effect immediately, not whenever a
 *      30-second session cache happens to lapse. Tested against the real cache.
 *   2. RESTORE FULLY REVERSES IT — including busting the cache again, which is
 *      the half that matters more: a late restore leaves a customer who has
 *      just paid still staring at a hold screen.
 *   3. DUNNING. Off by default; six days of grace; suspends through the SAME
 *      code path the panel button uses; and never suspends a tenant somebody
 *      switched off by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.BILLING_AUTHNET_ENV = 'sandbox';
process.env.BILLING_AUTHNET_LOGIN_ID = 'test-login';
process.env.BILLING_AUTHNET_TRANSACTION_KEY = 'test-key';
process.env.BILLING_BASE_URL = 'https://example.test';

const { makePrisma, makeAuditSpy, silentLogger } = await import('./billing-test-prisma.mjs');
const { SUBSCRIPTION_STATUS } = await import('./billing.service.js');
const { AUDIT_ACTIONS } = await import('../audit/audit.service.js');
const { suspendTenantAccess, restoreTenantAccess } = await import('./billing-admin.service.js');
const { runDunningSweep, dunningGraceDays, isDunningEnabled } = await import('./billing-dunning.service.js');
const { getSelfBilling, requestSelfPaymentLink, buildBillingNotice, daysUntilSuspension } =
  await import('./billing-self.service.js');
const { authService } = await import('../auth/auth.service.js');
const { cache } = await import('../../lib/cache.js');
const { globalKey } = await import('../../lib/cache/tenantKey.js');

const NOW = new Date('2026-09-10T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function seed({ tenantStatus = 'ACTIVE', billingSuspendedAt = null, billingPreviousStatus = null, subscription = {} } = {}) {
  const prisma = makePrisma();
  const tenant = { id: 't1', name: 'Autos del Valle', status: tenantStatus, plan: 'PRO', billingSuspendedAt, billingPreviousStatus };
  prisma.tenant.rows.push(tenant);
  const sub = {
    id: 's1',
    tenantId: 't1',
    planCode: 'PRO',
    planNameSnapshot: 'Pro',
    amount: '199.00',
    currency: 'USD',
    intervalUnit: 'months',
    intervalLength: 1,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    arbSubscriptionId: 'arb-1',
    customerProfileId: 'cp-1',
    cardBrand: 'Visa',
    cardLast4: '1111',
    startDate: '2026-08-01',
    nextChargeDate: '2026-09-01',
    pastDueSince: null,
    suspendedAt: null,
    failedAttempts: 0,
    authorizedEmail: 'owner@autosdelvalle.test',
    authorizedName: 'Autos del Valle',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...subscription,
  };
  prisma.tenantSubscription.rows.push(sub);
  return { prisma, tenant, sub };
}

function overridesFor(prisma, extra = {}) {
  const audit = makeAuditSpy();
  return {
    audit,
    overrides: {
      prisma,
      logger: silentLogger,
      now: () => NOW,
      recordAudit: audit.recordAudit,
      notifyOwner: async () => ({ sent: false }),
      invalidateTenantSessions: async () => ({ ok: true, invalidated: 0 }),
      ...extra,
    },
  };
}

// ═══ 1. THE CACHE BUST ═════════════════════════════════════════════════════

test('invalidateTenantSessions really drops the cached session of every user of the tenant', async () => {
  cache.set(globalKey('session', 'a1'), { id: 'a1', tenantStatus: 'ACTIVE' }, 60000);
  cache.set(globalKey('session', 'a2'), { id: 'a2', tenantStatus: 'ACTIVE' }, 60000);
  // A user of ANOTHER tenant. Suspending one tenant must not log out the rest
  // of the platform — the cheapest possible way to turn a collections problem
  // into an outage.
  cache.set(globalKey('session', 'other'), { id: 'other' }, 60000);

  const fakePrisma = { user: { findMany: async () => [{ id: 'a1' }, { id: 'a2' }] } };
  const out = await authService.invalidateTenantSessions('t1', { prisma: fakePrisma });

  assert.equal(out.invalidated, 2);
  assert.equal(cache.get(globalKey('session', 'a1')), undefined);
  assert.equal(cache.get(globalKey('session', 'a2')), undefined);
  assert.ok(cache.get(globalKey('session', 'other')), 'another tenant must be untouched');
  cache.del(globalKey('session', 'other'));
});

test('a failing bust never throws into the caller — the suspension already happened', async () => {
  const exploding = { user: { findMany: async () => { throw new Error('db down'); } } };
  const out = await authService.invalidateTenantSessions('t1', { prisma: exploding });
  assert.equal(out.ok, false);
});

test('an empty tenantId is a no-op, not a platform-wide session flush', async () => {
  let called = false;
  const spy = { user: { findMany: async () => { called = true; return []; } } };
  const out = await authService.invalidateTenantSessions('', { prisma: spy });
  assert.equal(called, false);
  assert.equal(out.invalidated, 0);
});

test('SUSPEND busts the tenant\'s sessions — this is what makes it immediate, not cache-expiry', async () => {
  const { prisma } = seed();
  let bustedFor = null;
  const { overrides } = overridesFor(prisma, {
    invalidateTenantSessions: async (tid) => { bustedFor = tid; return { ok: true, invalidated: 4 }; },
  });

  const out = await suspendTenantAccess({ tenantId: 't1', reason: 'no pagó' }, overrides);

  assert.equal(bustedFor, 't1');
  assert.equal(out.sessionsInvalidated, 4);
  assert.equal(prisma.tenant.rows[0].status, 'SUSPENDED');
  assert.ok(prisma.tenant.rows[0].billingSuspendedAt);
});

test('the audit row records how many sessions were dropped and the enforcement mode', async () => {
  const { prisma } = seed();
  const { audit, overrides } = overridesFor(prisma, {
    invalidateTenantSessions: async () => ({ ok: true, invalidated: 7 }),
  });
  await suspendTenantAccess({ tenantId: 't1', reason: 'no pagó' }, overrides);
  const row = audit.rows.find((r) => r.action === AUDIT_ACTIONS.TENANT_SUSPEND);
  assert.equal(row.metadata.sessionsInvalidated, 7);
  // Whatever the ambient mode is, it is RECORDED — so "why did the lockout take
  // a minute" is answerable from the trail rather than from a guess.
  assert.ok(['off', 'log', 'enforce'].includes(row.metadata.suspensionEnforcement));
});

// ═══ 2. RESTORE FULLY REVERSES IT ══════════════════════════════════════════

test('RESTORE reverses the suspension and busts the cache again', async () => {
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    subscription: { status: SUBSCRIPTION_STATUS.SUSPENDED, suspendedAt: new Date('2026-09-08T00:00:00.000Z') },
  });
  let bustedFor = null;
  const { overrides } = overridesFor(prisma, {
    invalidateTenantSessions: async (tid) => { bustedFor = tid; return { ok: true, invalidated: 4 }; },
  });

  const out = await restoreTenantAccess({ tenantId: 't1' }, overrides);

  assert.equal(bustedFor, 't1');
  assert.equal(prisma.tenant.rows[0].status, 'ACTIVE');
  assert.equal(prisma.tenant.rows[0].billingSuspendedAt, null);
  assert.equal(prisma.tenantSubscription.rows[0].suspendedAt, null);
  assert.equal(out.sessionsInvalidated, 4);
});

test('a delinquent subscription comes back as PAST_DUE, not ACTIVE — restore is not a payment', async () => {
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    subscription: {
      status: SUBSCRIPTION_STATUS.SUSPENDED,
      pastDueSince: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  const { overrides } = overridesFor(prisma);
  const out = await restoreTenantAccess({ tenantId: 't1' }, overrides);
  assert.equal(out.subscriptionStatus, SUBSCRIPTION_STATUS.PAST_DUE);
});

// ─── RESTORE PUTS BACK WHAT WAS THERE, NOT ACTIVE ──────────────────────────
//
// Tenant.status is a free-text String, not a Prisma enum, and 'ACTIVE' is not a
// synonym for "on": public-tenant-token.js, booking-engine resolvePublicTenant()
// and the car-sharing marketplace tenant list all match `status: 'ACTIVE'`
// exactly. So restoring a DEMO tenant to ACTIVE does not merely relabel it — it
// puts a demo tenant on the public booking surface. That is the failure these
// tests exist to stop.

test('SUSPEND records what the status WAS, in the same write that switches it off', async () => {
  const { prisma } = seed({ tenantStatus: 'DEMO' });
  const { overrides } = overridesFor(prisma);

  await suspendTenantAccess({ tenantId: 't1', reason: 'prueba de Phase 5' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, 'SUSPENDED');
  assert.equal(prisma.tenant.rows[0].billingPreviousStatus, 'DEMO');
});

test('RESTORE puts a non-ACTIVE tenant back to what it was, not to ACTIVE', async () => {
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    billingPreviousStatus: 'DEMO',
    subscription: { status: SUBSCRIPTION_STATUS.SUSPENDED, suspendedAt: new Date('2026-09-08T00:00:00.000Z') },
  });
  const { overrides } = overridesFor(prisma);

  const out = await restoreTenantAccess({ tenantId: 't1' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, 'DEMO', 'restore promoted a DEMO tenant to ACTIVE');
  assert.equal(out.status, 'DEMO', 'the response told the panel ACTIVE while the row said otherwise');
  assert.equal(prisma.tenant.rows[0].billingSuspendedAt, null);
  // Cleared with the suspension it describes: a value left behind here would be
  // read by the NEXT restore, long after it stopped being true.
  assert.equal(prisma.tenant.rows[0].billingPreviousStatus, null);
});

test('RESTORE falls back to ACTIVE when nothing was recorded', async () => {
  // A tenant suspended before billingPreviousStatus existed, or by a path that
  // did not record one. The old behaviour is the fallback, not the default.
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    billingPreviousStatus: null,
    subscription: { status: SUBSCRIPTION_STATUS.SUSPENDED },
  });
  const { overrides } = overridesFor(prisma);

  const out = await restoreTenantAccess({ tenantId: 't1' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, 'ACTIVE');
  assert.equal(out.status, 'ACTIVE');
});

test('a recorded SUSPENDED is caught whatever its casing', async () => {
  // Tenant.status is free text. Both writers uppercase it, but a row written by
  // hand could hold 'suspended', and a case-SENSITIVE guard would let that
  // through into exactly the state the guard exists to prevent: status off,
  // billingSuspendedAt cleared, and restore refusing to touch it ever again.
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    billingPreviousStatus: 'suspended',
  });
  const { overrides } = overridesFor(prisma);

  await restoreTenantAccess({ tenantId: 't1' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, 'ACTIVE');
});

test('a recorded status is put back VERBATIM, not normalised', async () => {
  // The casing test above is a COMPARISON, not a rewrite. Restore was asked to
  // put a value back; uppercasing the output would mean it quietly changed one.
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    billingPreviousStatus: 'Demo',
  });
  const { overrides } = overridesFor(prisma);

  await restoreTenantAccess({ tenantId: 't1' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, 'Demo');
});

test('a recorded SUSPENDED is treated as nothing recorded', async () => {
  // Restoring to SUSPENDED would leave the tenant off with billingSuspendedAt
  // cleared — the one state this screen can no longer undo, because restore
  // refuses a suspension billing did not set.
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    billingPreviousStatus: 'SUSPENDED',
  });
  const { overrides } = overridesFor(prisma);

  await restoreTenantAccess({ tenantId: 't1' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, 'ACTIVE');
});

test('an EMPTY recorded status is put back as empty, not promoted to ACTIVE', async () => {
  // Tenant.status is non-nullable, but tenants.service.js updateTenant writes
  // String(patch.status || '').toUpperCase(), so a tenant CAN sit at ''. Such a
  // tenant is already off the public surface — nothing matches '' either — and
  // reading its recorded '' as "nothing was recorded" would publish it. NULL is
  // the only value that means nothing was recorded.
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    billingPreviousStatus: '',
  });
  const { overrides } = overridesFor(prisma);

  await restoreTenantAccess({ tenantId: 't1' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, '');
});

test('a recorded status keeps its exact spacing — restore rewrites nothing', async () => {
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    billingPreviousStatus: ' DEMO ',
  });
  const { overrides } = overridesFor(prisma);

  await restoreTenantAccess({ tenantId: 't1' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, ' DEMO ');
});

test('a padded SUSPENDED is still caught by the guard', async () => {
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    billingPreviousStatus: '  suspended  ',
  });
  const { overrides } = overridesFor(prisma);

  await restoreTenantAccess({ tenantId: 't1' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, 'ACTIVE');
});

test('a round trip through suspend and restore leaves the status where it started', async () => {
  const { prisma } = seed({ tenantStatus: 'DEMO' });
  const { overrides } = overridesFor(prisma);

  await suspendTenantAccess({ tenantId: 't1', reason: 'prueba' }, overrides);
  await restoreTenantAccess({ tenantId: 't1', reason: 'terminada' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, 'DEMO');
  assert.equal(prisma.tenant.rows[0].billingSuspendedAt, null);
  assert.equal(prisma.tenant.rows[0].billingPreviousStatus, null);
});

test('the restore audit row says what it restored to, and whether it knew', async () => {
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    billingPreviousStatus: 'DEMO',
  });
  const { audit, overrides } = overridesFor(prisma);

  await restoreTenantAccess({ tenantId: 't1' }, overrides);

  const row = audit.rows.find((r) => r.action === AUDIT_ACTIONS.TENANT_RESTORE);
  assert.equal(row.metadata.restoredTenantStatus, 'DEMO');
  assert.equal(row.metadata.previousTenantStatus, 'DEMO');
});

test('restore takes NO status from the caller — it is a restore button, not a status editor', async () => {
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: new Date('2026-09-08T00:00:00.000Z'),
    billingPreviousStatus: 'DEMO',
  });
  const { overrides } = overridesFor(prisma);

  await restoreTenantAccess({ tenantId: 't1', status: 'ACTIVE', tenantStatus: 'ACTIVE' }, overrides);

  assert.equal(prisma.tenant.rows[0].status, 'DEMO', 'a caller-supplied status reached the tenant row');
});

test('restore still refuses to lift a suspension billing did not set', async () => {
  const { prisma } = seed({ tenantStatus: 'SUSPENDED', billingSuspendedAt: null });
  const { overrides } = overridesFor(prisma);
  await assert.rejects(
    () => restoreTenantAccess({ tenantId: 't1' }, overrides),
    /not suspended by billing/i,
  );
});

// ═══ 3. DUNNING ════════════════════════════════════════════════════════════

test('DUNNING IS OFF BY DEFAULT and suspends nothing', async () => {
  assert.equal(isDunningEnabled({}), false);
  const { prisma } = seed({
    subscription: {
      status: SUBSCRIPTION_STATUS.PAST_DUE,
      pastDueSince: new Date(NOW.getTime() - 30 * DAY),
    },
  });
  const { overrides } = overridesFor(prisma, { env: {} });
  const counts = await runDunningSweep(overrides);
  assert.equal(counts.disabled, true);
  assert.equal(counts.suspended, 0);
  assert.equal(prisma.tenant.rows[0].status, 'ACTIVE');
});

test('the grace window is six days by default, and a bad value cannot collapse it to zero', () => {
  assert.equal(dunningGraceDays({}), 6);
  assert.equal(dunningGraceDays({ BILLING_DUNNING_GRACE_DAYS: '10' }), 10);
  // 0 would mean "suspend the instant a card declines" — the grace window the
  // owner asked for, deleted by a typo.
  for (const bad of ['0', '-3', 'abc', '']) {
    assert.equal(dunningGraceDays({ BILLING_DUNNING_GRACE_DAYS: bad }), 6, bad);
  }
});

test('a tenant inside the grace window is NOT suspended', async () => {
  const { prisma } = seed({
    subscription: {
      status: SUBSCRIPTION_STATUS.PAST_DUE,
      // Day 5 of 6. ARB is still retrying for free.
      pastDueSince: new Date(NOW.getTime() - 5 * DAY),
    },
  });
  const { overrides } = overridesFor(prisma, { env: { BILLING_DUNNING_ENABLED: 'true' } });
  const counts = await runDunningSweep(overrides);
  assert.equal(counts.eligible, 0);
  assert.equal(prisma.tenant.rows[0].status, 'ACTIVE');
});

test('past the grace window, dunning suspends — through the same path the panel button uses', async () => {
  const { prisma } = seed({
    subscription: {
      status: SUBSCRIPTION_STATUS.PAST_DUE,
      pastDueSince: new Date(NOW.getTime() - 7 * DAY),
      lastFailureCode: 'AUTHNET_2',
    },
  });
  const { audit, overrides } = overridesFor(prisma, { env: { BILLING_DUNNING_ENABLED: 'true' } });

  const counts = await runDunningSweep(overrides);

  assert.equal(counts.suspended, 1);
  assert.equal(prisma.tenant.rows[0].status, 'SUSPENDED');
  assert.ok(prisma.tenant.rows[0].billingSuspendedAt, 'billing must own this suspension so restore can lift it');
  assert.equal(prisma.tenantSubscription.rows[0].status, SUBSCRIPTION_STATUS.SUSPENDED);

  const row = audit.rows.find((r) => r.action === AUDIT_ACTIONS.TENANT_SUSPEND);
  assert.ok(row, 'an automated suspension must still be audited');
  // "Did a person decide to switch this customer off, or did a cron?" has to be
  // answerable from the row alone.
  assert.equal(row.actorRole, 'SYSTEM_DUNNING');
  assert.match(row.metadata.reason, /Automatic suspension/i);
});

test('dunning never re-suspends a tenant a human switched off for another reason', async () => {
  const { prisma } = seed({
    tenantStatus: 'SUSPENDED',
    billingSuspendedAt: null, // a hand suspension: compliance hold, offboarding…
    subscription: {
      status: SUBSCRIPTION_STATUS.PAST_DUE,
      pastDueSince: new Date(NOW.getTime() - 30 * DAY),
    },
  });
  const { overrides } = overridesFor(prisma, { env: { BILLING_DUNNING_ENABLED: 'true' } });
  const counts = await runDunningSweep(overrides);
  assert.equal(counts.suspended, 0);
  assert.equal(counts.skipped, 1);
  // Crucially, it did NOT stamp billingSuspendedAt — which would have handed a
  // hand-made suspension to the automation to lift later.
  assert.equal(prisma.tenant.rows[0].billingSuspendedAt, null);
});

test('a PAST_DUE row with no clock is never treated as infinitely overdue', async () => {
  const { prisma } = seed({
    subscription: { status: SUBSCRIPTION_STATUS.PAST_DUE, pastDueSince: null },
  });
  const { overrides } = overridesFor(prisma, { env: { BILLING_DUNNING_ENABLED: 'true' } });
  const counts = await runDunningSweep(overrides);
  assert.equal(counts.eligible, 0);
  assert.equal(prisma.tenant.rows[0].status, 'ACTIVE');
});

test('an ACTIVE subscription is never swept up by dunning', async () => {
  const { prisma } = seed({ subscription: { pastDueSince: new Date(NOW.getTime() - 30 * DAY) } });
  const { overrides } = overridesFor(prisma, { env: { BILLING_DUNNING_ENABLED: 'true' } });
  const counts = await runDunningSweep(overrides);
  assert.equal(counts.eligible, 0);
});

// ═══ 4. THE TENANT'S OWN BILLING PAGE ══════════════════════════════════════

test('the day-0 notice appears on the first decline, and says how long they have', () => {
  const notice = buildBillingNotice(
    { status: SUBSCRIPTION_STATUS.PAST_DUE, pastDueSince: new Date(NOW.getTime() - 2 * DAY), amount: '199.00', cardLast4: '1111' },
    { status: 'ACTIVE' },
    NOW,
    6,
  );
  assert.equal(notice.level, 'warning');
  assert.equal(notice.code, 'BILLING_PAST_DUE');
  assert.equal(notice.daysRemaining, 4);
  // STRUCTURED, not a sentence. The frontend renders it in the viewer's own
  // language; building the copy here would hard-code one.
  assert.equal(typeof notice.daysRemaining, 'number');
});

test('the countdown never goes negative on screen', () => {
  assert.equal(daysUntilSuspension(new Date(NOW.getTime() - 40 * DAY), NOW, 6), 0);
  assert.equal(daysUntilSuspension(null, NOW, 6), null);
});

test('a healthy subscription produces no banner at all', () => {
  assert.equal(buildBillingNotice({ status: SUBSCRIPTION_STATUS.ACTIVE }, { status: 'ACTIVE' }, NOW, 6), null);
  assert.equal(buildBillingNotice(null, { status: 'ACTIVE' }, NOW, 6), null);
});

test('GET /api/billing/self never leaks the Authorize.Net handles or the consent archive', async () => {
  const { prisma } = seed();
  const out = await getSelfBilling({ tenantId: 't1' }, { prisma, now: () => NOW, logger: silentLogger });
  assert.equal(out.subscription.cardLast4, '1111');
  assert.equal(out.subscription.billingEmail, 'owner@autosdelvalle.test');
  for (const forbidden of [
    'arbSubscriptionId', 'customerProfileId', 'customerPaymentProfileId',
    'authorizedDisclosureText', 'authorizedIp', 'lastFailureText',
  ]) {
    assert.equal(out.subscription[forbidden], undefined, `${forbidden} must not reach the customer`);
  }
});

test('a hand-suspended tenant is NOT told to go pay us', async () => {
  // The remedy would be wrong and the message insulting.
  const { prisma } = seed({ tenantStatus: 'SUSPENDED', billingSuspendedAt: null });
  const out = await getSelfBilling({ tenantId: 't1' }, { prisma, now: () => NOW, logger: silentLogger });
  assert.equal(out.tenant.suspendedForNonPayment, false);
});

test('a tenant with no subscription gets a quiet answer, not an error', async () => {
  const prisma = makePrisma();
  prisma.tenant.rows.push({ id: 't2', name: 'Nobody Enrolled Us', status: 'ACTIVE', billingSuspendedAt: null });
  const out = await getSelfBilling({ tenantId: 't2' }, { prisma, now: () => NOW, logger: silentLogger });
  assert.equal(out.subscription, null);
  assert.equal(out.notice, null);
});

test('the payment link is EMAILED, and its URL never comes back over the response', async () => {
  const { prisma } = seed({ subscription: { status: SUBSCRIPTION_STATUS.SUSPENDED } });
  const sent = [];
  const out = await requestSelfPaymentLink({ tenantId: 't1', actorUserId: 'u1' }, {
    prisma,
    now: () => NOW,
    logger: silentLogger,
    sendEmail: async (m) => { sent.push(m); },
    sendUpdatePaymentLink: async () => ({
      url: 'https://ride.test/autopay/SECRET-TOKEN',
      invite: { email: 'owner@autosdelvalle.test', tokenPrefix: 'abcd1234', expiresAt: new Date() },
    }),
  });

  assert.equal(out.sent, true);
  assert.equal(out.email, 'owner@autosdelvalle.test');
  assert.equal(out.url, undefined, 'a stolen staff session must not be able to read the token');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /SECRET-TOKEN/);
});

test('a second request inside the cooldown does not kill the link already in their inbox', async () => {
  const { prisma } = seed({ subscription: { status: SUBSCRIPTION_STATUS.SUSPENDED } });
  prisma.autopayInvite.rows.push({
    id: 'i1',
    subscriptionId: 's1',
    mode: 'update',
    usedAt: null,
    revokedAt: null,
    createdAt: new Date(NOW.getTime() - 60 * 1000),
    expiresAt: new Date(NOW.getTime() + 14 * DAY),
  });
  let minted = false;
  const out = await requestSelfPaymentLink({ tenantId: 't1' }, {
    prisma,
    now: () => NOW,
    logger: silentLogger,
    sendEmail: async () => {},
    sendUpdatePaymentLink: async () => { minted = true; return {}; },
  });
  assert.equal(minted, false);
  assert.equal(out.sent, false);
  assert.equal(out.reason, 'ALREADY_SENT');
});
