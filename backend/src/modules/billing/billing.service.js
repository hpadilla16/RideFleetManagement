/**
 * Tenant subscriptions — Ride billing its own tenants for Ride Fleet Manager.
 *
 * SCOPE OF THIS FILE (Phase 1): issue an enrollment invite, and complete the
 * return leg that turns a saved card into a live ARB subscription plus the
 * ledger rows that explain it. No webhooks, no dunning, no suspension
 * enforcement, no proration — those are later phases and deliberately absent.
 *
 * NOTHING HERE CHARGES ANYBODY. `createSubscription` hands Authorize.Net a
 * schedule; ARB moves the money on `startDate`, on its own. The charge row this
 * file writes is PENDING — a record of what is scheduled, not of money that has
 * moved. The only thing that promotes a row to SETTLED is a verified webhook or
 * the reconciler, and neither exists yet.
 *
 * WHICH MERCHANT ACCOUNT: BILLING_AUTHNET_* — money flowing TO Ride. The
 * per-tenant rental gateway is AUTHNET_* and bills a renter on the TENANT's
 * account. Mixing them would deposit our subscription revenue into a customer's
 * bank account. See the header of ./authorize-net.js.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { getTenantPlanCatalog, resolveTenantPlanConfig } from '../../lib/tenant-plan-limits.js';
import { recordAudit, AUDIT_ACTIONS, AUDIT_OUTCOME } from '../audit/audit.service.js';
import {
  ensureCustomerProfile,
  getHostedProfilePageToken,
  getNewestPaymentMethod,
  createSubscription,
  updateSubscriptionPaymentMethod,
  hostedPageUrl,
  logAuthnetFailure,
} from './authorize-net.js';
import {
  createInvite,
  resolveUsableInvite,
  resolveInviteForReturn,
  claimInvite,
  releaseInviteClaim,
  updateInvite,
  markInviteOpened,
  revokeInvite,
  publicInviteView,
} from './autopay-invites.service.js';
import {
  todayCalendarDate,
  addCalendarDays,
  addInterval,
  assertCalendarDate,
  formatCalendarDateEs,
  cadenceLabelEs,
  formatMoney,
} from './billing-dates.js';

export const SUBSCRIPTION_STATUS = Object.freeze({
  PENDING_AUTHORIZATION: 'PENDING_AUTHORIZATION',
  TRIALING: 'TRIALING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED',
  EXPIRED: 'EXPIRED',
});

/** Statuses that are NOT terminal — the set the one-live-per-tenant index covers. */
export const LIVE_SUBSCRIPTION_STATUSES = Object.freeze([
  SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION,
  SUBSCRIPTION_STATUS.TRIALING,
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PAST_DUE,
  SUBSCRIPTION_STATUS.SUSPENDED,
]);

export const CHARGE_KIND = Object.freeze({
  RECURRING: 'RECURRING',
  TRIAL: 'TRIAL',
  PRORATION: 'PRORATION',
  CREDIT_APPLIED: 'CREDIT_APPLIED',
  SETUP: 'SETUP',
  MANUAL: 'MANUAL',
  REFUND: 'REFUND',
  CHARGEBACK: 'CHARGEBACK',
});

export const CHARGE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SETTLED: 'SETTLED',
  DECLINED: 'DECLINED',
  VOIDED: 'VOIDED',
  REFUNDED: 'REFUNDED',
  ERROR: 'ERROR',
});

/**
 * Where a charge row came from. ENROLLMENT is an addition to the design's
 * vocabulary (WEBHOOK | RECONCILE | DIRECT_CHARGE | ADMIN): the first row is
 * written by the customer's own return leg, which is none of those. ADMIN would
 * have been a lie about who acted, and getting that wrong in a dispute is the
 * whole reason this table exists.
 */
export const CHARGE_SOURCE = Object.freeze({
  ENROLLMENT: 'ENROLLMENT',
  WEBHOOK: 'WEBHOOK',
  RECONCILE: 'RECONCILE',
  DIRECT_CHARGE: 'DIRECT_CHARGE',
  ADMIN: 'ADMIN',
});

const CYCLES = {
  monthly: { intervalUnit: 'months', intervalLength: 1, priceField: 'priceMonthly' },
  annual: { intervalUnit: 'months', intervalLength: 12, priceField: 'priceAnnual' },
};

function deps(overrides = {}) {
  return {
    prisma: overrides.prisma || prisma,
    logger: overrides.logger || logger,
    now: overrides.now || (() => new Date()),
    ensureCustomerProfile: overrides.ensureCustomerProfile || ensureCustomerProfile,
    getHostedProfilePageToken: overrides.getHostedProfilePageToken || getHostedProfilePageToken,
    getNewestPaymentMethod: overrides.getNewestPaymentMethod || getNewestPaymentMethod,
    createSubscription: overrides.createSubscription || createSubscription,
    updateSubscriptionPaymentMethod:
      overrides.updateSubscriptionPaymentMethod || updateSubscriptionPaymentMethod,
    hostedPageUrl: overrides.hostedPageUrl || hostedPageUrl,
    recordAudit: overrides.recordAudit || recordAudit,
    ...overrides,
  };
}

/**
 * merchantCustomerId for a tenant.
 *
 * Authorize.Net caps this at 20 characters and dedupes customer profiles on it,
 * so it must be STABLE for a given tenant and it must already fit. A cuid is 25
 * chars; its first 20 carry the timestamp, counter and fingerprint segments, so
 * truncating there is deterministic and collision risk is negligible.
 */
export function merchantCustomerIdForTenant(tenantId) {
  return String(tenantId).slice(0, 20);
}

/**
 * What a plan costs today, per the catalog. The catalog is the DEFAULT OFFERED;
 * the returned amount is snapshotted onto the subscription at enrollment and is
 * authoritative from then on.
 *
 * Refuses loudly rather than guessing: a plan that is not marked billable, or
 * has no price for the requested cycle, cannot back an invite. The owner has
 * not set prices yet, so today every call throws until the catalog is filled in
 * — which is the correct behaviour for a phase whose job is to charge nobody.
 */
export async function resolvePlanOffer(planCode, cycle = 'monthly', overrides = {}) {
  const d = deps(overrides);
  const spec = CYCLES[cycle];
  if (!spec) throw new Error(`Unknown billing cycle "${cycle}" (expected monthly or annual).`);

  const catalog = await getTenantPlanCatalog(d.prisma);
  const plan = resolveTenantPlanConfig(planCode, catalog);
  if (!plan.isActive) throw new Error(`Plan ${plan.code} is not active in the plan catalog.`);
  if (!plan.billable) {
    throw new Error(
      `Plan ${plan.code} is not marked billable in the plan catalog. `
      + 'Set billable + a price via PUT /api/tenants/plan-catalog before issuing an invite.',
    );
  }
  const amount = plan[spec.priceField];
  if (amount == null) {
    throw new Error(`Plan ${plan.code} has no ${cycle} price set in the plan catalog.`);
  }

  return {
    planCode: plan.code,
    planName: plan.name,
    amount,
    currency: plan.currency,
    intervalUnit: spec.intervalUnit,
    intervalLength: spec.intervalLength,
    trialDays: Number(plan.trialDays || 0),
  };
}

/**
 * The consent artefact, frozen at SEND time.
 *
 * Stored VERBATIM on the invite and copied onto the subscription at activation —
 * not a template id. Templates get edited; a dispute is about what THEY saw.
 * This is the cheapest dispute insurance available, so it says who is charging,
 * how much, how often, and the exact date of the first charge, in the language
 * the enrollment pages are written in.
 */
export function buildDisclosureText({
  companyName,
  planName,
  amount,
  currency = 'USD',
  intervalUnit,
  intervalLength,
  firstChargeDate,
  email,
}) {
  const cadence = cadenceLabelEs(intervalUnit, intervalLength);
  return [
    `${companyName} autoriza a Ride Car Sharing LLC a cobrar automáticamente la suscripción de Ride Fleet Manager`,
    `al método de pago guardado, por $${formatMoney(amount)} ${currency} con frecuencia ${cadence},`,
    `plan ${planName}. El primer cobro corre el ${formatCalendarDateEs(firstChargeDate)}.`,
    `Se enviará un recibo de cada cargo a ${email}.`,
    'El cobro automático puede cancelarse avisando con 30 días de anticipación.',
    'El número completo de la tarjeta se ingresa y se guarda en los servidores de Authorize.Net;',
    'Ride Fleet Manager solo recibe un identificador y los últimos cuatro dígitos.',
  ].join(' ');
}

/** The sentence a person can read out on a phone call. Stored once, never recomputed. */
export function buildScheduledChargeDescription({
  planName,
  amount,
  currency = 'USD',
  intervalUnit,
  intervalLength,
  chargeDate,
  periodStart,
  periodEnd,
}) {
  const cadence = cadenceLabelEs(intervalUnit, intervalLength);
  return (
    `Suscripción Ride Fleet Manager — plan ${planName}, cobro ${cadence} de `
    + `$${formatMoney(amount)} ${currency}. Cargo programado para el `
    + `${formatCalendarDateEs(chargeDate)}, cubre del ${formatCalendarDateEs(periodStart)} `
    + `al ${formatCalendarDateEs(periodEnd)}.`
  );
}

/** brand + last4 out of Authorize.Net's already-masked value. NEVER a PAN. */
export function cardFacts(method) {
  const masked = String(method?.maskedNumber || '');
  const digits = masked.replace(/[^0-9]/g, '');
  return {
    cardBrand: method?.cardType || null,
    cardLast4: digits ? digits.slice(-4) : null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Issuance — SUPER_ADMIN only. Phase 1 ships this as a service function; its
// route and the panel button that calls it are Phase 4.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Create a PENDING_AUTHORIZATION subscription plus the invite that will activate
 * it. Returns the plaintext token exactly once — put it straight into the link.
 *
 * At most ONE live subscription per tenant is enforced by a partial unique index
 * in the migration (Prisma cannot express one). A second invite for a tenant
 * that already has a live row therefore fails at the database, not on a race
 * somebody has to remember to guard.
 */
export async function issueEnrollInvite(input = {}, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();
  const today = todayCalendarDate(now);

  const tenant = await d.prisma.tenant.findUnique({
    where: { id: String(input.tenantId) },
    select: { id: true, name: true },
  });
  if (!tenant) throw new Error('Tenant not found');

  const offer = await resolvePlanOffer(input.planCode, input.cycle || 'monthly', overrides);
  // The amount may be negotiated per tenant — the catalog price is only the
  // default. Whatever lands here is what the subscription snapshots.
  const amount = input.amountOverride == null ? offer.amount : Number(input.amountOverride);
  if (!(Number(amount) >= 0)) throw new Error('Subscription amount must be a non-negative number.');

  // A trial is a DEFERRED START, not ARB trialOccurrences (design §5A): the card
  // is captured and validated now, ARB charges nothing until startDate, and our
  // own TRIALING bookkeeping cannot disagree with Authorize.Net because there is
  // nothing at Authorize.Net to disagree with.
  const trialDays = input.trialDays == null ? offer.trialDays : Number(input.trialDays);
  const startDate = input.startDate
    ? assertCalendarDate(input.startDate, 'startDate')
    : addCalendarDays(today, Math.max(0, trialDays));
  if (startDate < today) {
    // Authorize.Net rejects a past startDate outright; catch it here where the
    // message can say something useful.
    throw new Error('startDate cannot be in the past — Authorize.Net rejects it.');
  }

  const companyName = String(input.companyName || tenant.name);
  const email = String(input.email || '').trim();
  if (!email) throw new Error('A billing contact email is required on the invite.');

  const disclosureText = buildDisclosureText({
    companyName,
    planName: offer.planName,
    amount,
    currency: offer.currency,
    intervalUnit: offer.intervalUnit,
    intervalLength: offer.intervalLength,
    firstChargeDate: startDate,
    email,
  });

  let subscription;
  try {
    subscription = await d.prisma.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        planCode: offer.planCode,
        // THE SNAPSHOT. A catalog edit after this moment must never re-price a
        // live subscriber or rewrite what their history says they agreed to.
        planNameSnapshot: offer.planName,
        amount,
        currency: offer.currency,
        intervalUnit: offer.intervalUnit,
        intervalLength: offer.intervalLength,
        status: SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION,
        startDate,
        nextChargeDate: startDate,
        trialEndsAt: trialDays > 0 ? startDate : null,
        createdByUserId: input.actorUserId ?? null,
        notes: input.notes ?? null,
      },
    });
  } catch (e) {
    if (e?.code === 'P2002') {
      throw new Error(
        `${tenant.name} already has a live subscription. Cancel it before enrolling a new one.`,
      );
    }
    throw e;
  }

  const { invite, token, url } = await createInvite(
    {
      mode: 'enroll',
      tenantId: tenant.id,
      subscriptionId: subscription.id,
      merchantCustomerId: merchantCustomerIdForTenant(tenant.id),
      email,
      companyName,
      planCode: offer.planCode,
      planName: offer.planName,
      amount,
      intervalUnit: offer.intervalUnit,
      intervalLength: offer.intervalLength,
      startDate,
      nextChargeDate: null,
      trialOccurrences: 0,
      trialAmount: null,
      disclosureText,
      validForDays: input.validForDays,
      createdByUserId: input.actorUserId ?? null,
    },
    overrides,
  );

  // Ids, amounts, plan codes and the token PREFIX only. Never the token.
  await d.recordAudit({
    tenantId: tenant.id,
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    actorRole: input.actorRole ?? null,
    action: AUDIT_ACTIONS.AUTOPAY_INVITE_SEND,
    targetType: 'TenantSubscription',
    targetId: subscription.id,
    metadata: {
      inviteId: invite.id,
      tokenPrefix: invite.tokenPrefix,
      planCode: offer.planCode,
      amount: String(amount),
      currency: offer.currency,
      intervalUnit: offer.intervalUnit,
      intervalLength: offer.intervalLength,
      startDate,
      expiresAt: invite.expiresAt.toISOString(),
    },
  });

  return { subscription, invite, token, url };
}

export async function revokeInviteById(inviteId, actor = {}, overrides = {}) {
  const d = deps(overrides);
  const invite = await d.prisma.autopayInvite.findUnique({ where: { id: String(inviteId) } });
  if (!invite) return false;
  const revoked = await revokeInvite(invite.id, overrides);
  if (revoked) {
    await d.recordAudit({
      tenantId: invite.tenantId,
      actorUserId: actor.userId ?? null,
      actorEmail: actor.email ?? null,
      actorRole: actor.role ?? null,
      action: AUDIT_ACTIONS.AUTOPAY_INVITE_REVOKE,
      targetType: 'AutopayInvite',
      targetId: invite.id,
      metadata: { tokenPrefix: invite.tokenPrefix, subscriptionId: invite.subscriptionId },
    });
  }
  return revoked;
}

// ───────────────────────────────────────────────────────────────────────────
// Public legs
// ───────────────────────────────────────────────────────────────────────────

/** GET the enrollment page's payload. Null means the route answers a bare 404. */
export async function resolvePublicInvite(token, overrides = {}) {
  const invite = await resolveUsableInvite(token, overrides);
  if (!invite) return null;
  await markInviteOpened(invite.id, overrides);
  return publicInviteView(invite);
}

/**
 * Mint the Authorize.Net hosted-page token — BEHIND THE BUTTON.
 *
 * That token lives ~15 minutes. Minting it while the customer is still reading
 * the disclosure burns the clock on the one page we actually want them to read.
 * The proven groundwork minted it on page render and said so in its own comment;
 * this is that comment's advice, taken.
 */
export async function startHostedSession(token, overrides = {}) {
  const d = deps(overrides);
  const invite = await resolveUsableInvite(token, overrides);
  if (!invite) return null;

  const customerProfileId = invite.customerProfileId
    || await d.ensureCustomerProfile({
      merchantCustomerId: invite.merchantCustomerId,
      email: invite.email,
      description: invite.companyName,
    });

  if (!invite.customerProfileId) {
    await updateInvite(invite.id, { customerProfileId }, overrides);
  }

  const base = (process.env.BILLING_BASE_URL || '').replace(/\/+$/, '');
  const hostedToken = await d.getHostedProfilePageToken({
    customerProfileId,
    // The plaintext token appears here and only here on the server side: it has
    // to, because Authorize.Net must send the customer back to THEIR link.
    returnUrl: `${base}/autopay/${token}/return`,
    returnUrlText: 'Volver a Ride Fleet Manager',
    mode: invite.mode,
  });

  return { hostedPageUrl: d.hostedPageUrl(invite.mode), hostedToken };
}

/**
 * The return leg. Authorize.Net redirects the customer here after they save a
 * card; it tells us nothing about WHAT was saved, so we read it off the customer
 * profile and only then start the recurring subscription.
 *
 * MUST STAY IDEMPOTENT. A refresh, a double-click, or back-then-forward all land
 * here again and none of them may create a second ARB subscription — that bills
 * the customer twice a month with no obvious cause. Two independent guards:
 * the atomic invite claim, and a re-read of the subscription's arbSubscriptionId.
 *
 * Returns a discriminated result the client renders; it never throws for an
 * expected outcome.
 */
export async function completeEnrollment(token, meta = {}, overrides = {}) {
  const d = deps(overrides);
  const invite = await resolveInviteForReturn(token, overrides);
  if (!invite) return null;

  if (invite.mode === 'update') return completeMethodUpdate(invite, meta, overrides);

  if (!invite.subscriptionId) {
    d.logger.error('[billing] enroll invite has no subscription row', { inviteId: invite.id });
    return null;
  }

  const existing = await d.prisma.tenantSubscription.findUnique({
    where: { id: invite.subscriptionId },
  });
  if (!existing) return null;

  // Guard 1: already activated. Re-render the receipt, touch nothing.
  if (existing.arbSubscriptionId) return receipt(existing, invite);

  if (!invite.customerProfileId) {
    // They reached the return URL without ever going through the hosted page.
    return { status: 'no_method', companyName: invite.companyName };
  }

  // Guard 2: exactly one caller may proceed past here.
  const won = await claimInvite(invite.id, overrides);
  if (!won) {
    const after = await d.prisma.tenantSubscription.findUnique({
      where: { id: invite.subscriptionId },
    });
    if (after?.arbSubscriptionId) return receipt(after, invite);
    return { status: 'in_progress', companyName: invite.companyName };
  }

  const method = await d.getNewestPaymentMethod(invite.customerProfileId);
  if (!method) {
    // Reaching the return URL without saving anything is the "cancel" path.
    // Give the claim back so the same emailed link still works.
    await releaseInviteClaim(invite.id, overrides);
    return { status: 'no_method', companyName: invite.companyName };
  }

  const { cardBrand, cardLast4 } = cardFacts(method);

  let arbSubscriptionId;
  try {
    arbSubscriptionId = await d.createSubscription({
      name: `${invite.planName} — ${invite.companyName}`,
      amount: existing.amount,
      startDate: existing.startDate,
      intervalLength: existing.intervalLength,
      intervalUnit: existing.intervalUnit,
      customerProfileId: invite.customerProfileId,
      customerPaymentProfileId: method.customerPaymentProfileId,
      trialOccurrences: invite.trialOccurrences || 0,
      trialAmount: invite.trialAmount,
    });
  } catch (err) {
    // The card saved but the subscription did not start. NEVER show this as
    // success: billing would silently never run and nobody would notice until
    // someone audited revenue by hand.
    //
    // The claim goes back ONLY because createSubscription threw — we know no ARB
    // subscription exists. A TIMEOUT is a different case and must not reach
    // here as a release: it means we do not know, and an invite released on an
    // unknown state is how a tenant ends up with two live subscriptions.
    logAuthnetFailure('createSubscription', err, {
      inviteId: invite.id,
      tenantId: invite.tenantId,
      subscriptionId: existing.id,
      customerProfileId: invite.customerProfileId,
    });
    const timedOut = /timed out after/.test(String(err?.message || ''));
    if (!timedOut) await releaseInviteClaim(invite.id, overrides);
    await d.prisma.tenantSubscription.update({
      where: { id: existing.id },
      data: {
        customerProfileId: invite.customerProfileId,
        customerPaymentProfileId: method.customerPaymentProfileId,
        cardBrand,
        cardLast4,
        lastFailureCode: timedOut ? 'ARB_CREATE_TIMEOUT' : 'ARB_CREATE_FAILED',
        lastFailureText: String(err?.message || '').slice(0, 500),
        lastFailureAt: d.now(),
      },
    });
    return { status: 'method_saved_not_activated', companyName: invite.companyName };
  }

  const now = d.now();
  const periodEnd = addCalendarDays(
    addInterval(existing.startDate, existing.intervalUnit, existing.intervalLength),
    -1,
  );
  const trialing = !!existing.trialEndsAt && existing.startDate > todayCalendarDate(now);

  const description = buildScheduledChargeDescription({
    planName: existing.planNameSnapshot,
    amount: existing.amount,
    currency: existing.currency,
    intervalUnit: existing.intervalUnit,
    intervalLength: existing.intervalLength,
    chargeDate: existing.startDate,
    periodStart: existing.startDate,
    periodEnd,
  });

  // ONE transaction: the state change and its ledger row land together or not at
  // all. The audit row is written afterwards and separately, because it is
  // best-effort by design and must never be able to roll this back.
  const [updated] = await d.prisma.$transaction([
    d.prisma.tenantSubscription.update({
      where: { id: existing.id },
      data: {
        status: trialing ? SUBSCRIPTION_STATUS.TRIALING : SUBSCRIPTION_STATUS.ACTIVE,
        arbSubscriptionId,
        customerProfileId: invite.customerProfileId,
        customerPaymentProfileId: method.customerPaymentProfileId,
        cardBrand,
        cardLast4,
        currentPeriodStart: existing.startDate,
        currentPeriodEnd: periodEnd,
        nextChargeDate: existing.startDate,
        lastFailureCode: null,
        lastFailureText: null,
        // ── Consent archive. Copied off the invite so it survives invite
        // pruning, and stored next to the token we charge: "here is the handle,
        // here is the exact text they agreed to, at this instant, from this IP."
        authorizedAt: now,
        authorizedIp: meta.ip ?? null,
        authorizedUserAgent: meta.userAgent ? String(meta.userAgent).slice(0, 120) : null,
        authorizedEmail: invite.email,
        authorizedName: invite.companyName,
        authorizedDisclosureText: invite.disclosureText,
        authorizedDisclosureHash: invite.disclosureHash,
        authorizedInviteId: invite.id,
      },
    }),
    d.prisma.tenantSubscriptionCharge.create({
      data: {
        subscriptionId: existing.id,
        tenantId: existing.tenantId,
        kind: CHARGE_KIND.RECURRING,
        // PENDING, not SETTLED: ARB has not charged anything yet and will not
        // until startDate. Only a verified webhook or the reconciler may
        // promote this row — and neither exists in this phase.
        status: CHARGE_STATUS.PENDING,
        amount: existing.amount,
        currency: existing.currency,
        arbSubscriptionId,
        cardBrand,
        cardLast4,
        chargeDate: existing.startDate,
        description,
        periodStart: existing.startDate,
        periodEnd,
        toPlanCode: existing.planCode,
        toAmount: existing.amount,
        source: CHARGE_SOURCE.ENROLLMENT,
      },
    }),
    d.prisma.autopayInvite.update({
      where: { id: invite.id },
      data: {
        customerPaymentProfileId: method.customerPaymentProfileId,
        arbSubscriptionId,
        cardBrand,
        cardLast4,
      },
    }),
  ]);

  const auditMeta = {
    subscriptionId: existing.id,
    inviteId: invite.id,
    tokenPrefix: invite.tokenPrefix,
    planCode: existing.planCode,
    amount: String(existing.amount),
    currency: existing.currency,
    arbSubscriptionId,
    customerProfileId: invite.customerProfileId,
    cardBrand,
    cardLast4,
    startDate: existing.startDate,
    disclosureHash: invite.disclosureHash,
  };
  await d.recordAudit({
    tenantId: existing.tenantId,
    action: AUDIT_ACTIONS.AUTOPAY_ENROLL,
    targetType: 'TenantSubscription',
    targetId: existing.id,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    metadata: auditMeta,
    outcome: AUDIT_OUTCOME.SUCCESS,
  });
  await d.recordAudit({
    tenantId: existing.tenantId,
    action: AUDIT_ACTIONS.SUBSCRIPTION_CREATE,
    targetType: 'TenantSubscription',
    targetId: existing.id,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    metadata: auditMeta,
  });

  return receipt(updated, invite);
}

/**
 * mode=update: the subscription already exists and only needs repointing at
 * whatever method was just saved.
 */
async function completeMethodUpdate(invite, meta, overrides) {
  const d = deps(overrides);
  if (!invite.customerProfileId || !invite.subscriptionId) return null;
  const subscription = await d.prisma.tenantSubscription.findUnique({
    where: { id: invite.subscriptionId },
  });
  if (!subscription?.arbSubscriptionId) return null;

  const next = await d.getNewestPaymentMethod(invite.customerProfileId);
  if (!next) return { status: 'no_method', companyName: invite.companyName };

  const { cardBrand, cardLast4 } = cardFacts(next);

  // An IN-PLACE EDIT keeps the same customerPaymentProfileId, so ARB already
  // follows it and calling update would be a no-op round trip. Only a genuinely
  // NEW method mints a new id, and only that case needs the subscription moved —
  // miss it and the subscription keeps charging the old, dying card.
  if (next.customerPaymentProfileId !== subscription.customerPaymentProfileId) {
    try {
      await d.updateSubscriptionPaymentMethod({
        subscriptionId: subscription.arbSubscriptionId,
        customerProfileId: invite.customerProfileId,
        customerPaymentProfileId: next.customerPaymentProfileId,
      });
    } catch (err) {
      // The new card is stored but the subscription still points at the old one,
      // which is precisely the state that bills a dead card next cycle. Never
      // call it done.
      logAuthnetFailure('updateSubscriptionPaymentMethod', err, {
        inviteId: invite.id,
        tenantId: invite.tenantId,
        subscriptionId: subscription.id,
      });
      return { status: 'method_saved_not_repointed', companyName: invite.companyName };
    }
  }

  await d.prisma.$transaction([
    d.prisma.tenantSubscription.update({
      where: { id: subscription.id },
      data: {
        customerPaymentProfileId: next.customerPaymentProfileId,
        cardBrand,
        cardLast4,
      },
    }),
    d.prisma.autopayInvite.update({
      where: { id: invite.id },
      data: {
        customerPaymentProfileId: next.customerPaymentProfileId,
        cardBrand,
        cardLast4,
        usedAt: invite.usedAt || d.now(),
      },
    }),
  ]);

  await d.recordAudit({
    tenantId: invite.tenantId,
    action: AUDIT_ACTIONS.AUTOPAY_METHOD_UPDATE,
    targetType: 'TenantSubscription',
    targetId: subscription.id,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    metadata: {
      inviteId: invite.id,
      tokenPrefix: invite.tokenPrefix,
      subscriptionId: subscription.id,
      customerProfileId: invite.customerProfileId,
      cardBrand,
      cardLast4,
    },
  });

  return {
    status: 'updated',
    companyName: invite.companyName,
    cardBrand,
    cardLast4,
    nextChargeDate: subscription.nextChargeDate || subscription.startDate,
    reference: subscription.arbSubscriptionId,
  };
}

/**
 * The receipt. Whitelisted, like publicInviteView — an unauthenticated caller
 * gets the facts of their own enrollment and nothing else. arbSubscriptionId is
 * shown as "Referencia" on purpose: it is what support asks for, and it is
 * useless to anyone without our transaction key.
 */
function receipt(subscription, invite) {
  return {
    status: 'enrolled',
    companyName: invite.companyName,
    planName: subscription.planNameSnapshot,
    amount: String(subscription.amount),
    currency: subscription.currency,
    intervalUnit: subscription.intervalUnit,
    intervalLength: subscription.intervalLength,
    cardBrand: subscription.cardBrand,
    cardLast4: subscription.cardLast4,
    firstChargeDate: subscription.startDate,
    trialing: subscription.status === SUBSCRIPTION_STATUS.TRIALING,
    reference: subscription.arbSubscriptionId,
  };
}

export const billingService = {
  resolvePlanOffer,
  issueEnrollInvite,
  revokeInviteById,
  resolvePublicInvite,
  startHostedSession,
  completeEnrollment,
  buildDisclosureText,
  buildScheduledChargeDescription,
  merchantCustomerIdForTenant,
  cardFacts,
  SUBSCRIPTION_STATUS,
  LIVE_SUBSCRIPTION_STATUSES,
  CHARGE_KIND,
  CHARGE_STATUS,
  CHARGE_SOURCE,
};
