/**
 * The SUPER_ADMIN billing panel — Phase 4.
 *
 * Reads first (overview → detail → charge history → event log), then the small
 * set of write actions the owner needs before ANY automation exists: send and
 * revoke payment links, cancel, manual suspend/restore, and apply-plan-to-
 * entitlements.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN
 * ---------------------------------------------------------------------------
 * - No plan change, no proration, no novel amount. That is Phase 6, last on
 *   purpose because it is the only part that computes a number nobody agreed to
 *   in advance.
 * - No dunning, no automatic suspension, no `requireAuth` gate. That is Phase 5.
 *   This file gives a human the lever; Phase 5 automates the decision to pull it.
 * - No refund. Design open question 10 (who may issue one, and the ceiling above
 *   which it must happen in the Authorize.Net portal) is UNANSWERED, so refunds
 *   are readable in the ledger here and issuable nowhere.
 * - NO "RETRY" THAT FORCES A CHARGE. See the block above retrying below; this is
 *   the single most important piece of honesty in the panel.
 *
 * MONEY SAFETY. Exactly one function here talks to Authorize.Net in a way that
 * changes anything: `cancelSubscription`, and it calls ARB FIRST (§2.2).
 * `refreshFromAuthorizeNet` reads. Everything else touches only our own rows.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { getTenantPlanCatalog, resolveTenantPlanConfig } from '../../lib/tenant-plan-limits.js';
import { recordAudit, AUDIT_ACTIONS, AUDIT_OUTCOME } from '../audit/audit.service.js';
import {
  cancelSubscription as arbCancelSubscription,
  getSubscriptionStatus as arbGetSubscriptionStatus,
  logAuthnetFailure,
} from './authorize-net.js';
import { applyDrift } from './billing-reconcile.service.js';
import { notifyOwner } from './billing-notify.js';
import {
  SUBSCRIPTION_STATUS,
  LIVE_SUBSCRIPTION_STATUSES,
  merchantCustomerIdForTenant,
  buildDisclosureText,
} from './billing.service.js';
import { createInvite, revokeInvite } from './autopay-invites.service.js';
import { authService } from '../auth/auth.service.js';
import { suspensionMode } from '../../lib/tenant-suspension.js';
import { todayCalendarDate, addCalendarDays } from './billing-dates.js';

/**
 * The typed second lock on cancel, mirroring demo-reset's RESET_CONFIRMATION
 * (`tenants/demo-reset.js`). Cancel is the one action here that reaches out and
 * changes something at Authorize.Net, and it is not undoable — a cancelled ARB
 * subscription cannot be un-cancelled, only replaced by a new enrollment that
 * makes the customer type a card again. A stray click must not be able to do it.
 */
export const CANCEL_CONFIRMATION = 'CANCEL SUBSCRIPTION';

export function assertCancelConfirmed(phrase) {
  if (String(phrase || '').trim().toUpperCase() !== CANCEL_CONFIRMATION) {
    const e = new Error(`Type "${CANCEL_CONFIRMATION}" to confirm.`);
    e.status = 400;
    throw e;
  }
}

/** Card-expiry warning window, matching the reconciler's auto-invite horizon. */
export const CARD_EXPIRY_WARN_DAYS = 45;

function deps(overrides = {}) {
  return {
    prisma: overrides.prisma || prisma,
    logger: overrides.logger || logger,
    now: overrides.now || (() => new Date()),
    cancelSubscription: overrides.cancelSubscription || arbCancelSubscription,
    getSubscriptionStatus: overrides.getSubscriptionStatus || arbGetSubscriptionStatus,
    applyDrift: overrides.applyDrift || applyDrift,
    recordAudit: overrides.recordAudit || recordAudit,
    notifyOwner: overrides.notifyOwner || notifyOwner,
    // Phase 5 (2026-08-28): busting every cached session of the tenant is what
    // makes suspend and restore take effect NOW rather than at cache expiry.
    // Injected (not imported inline) so the panel tests can assert it was
    // called — "the cache was busted" is a behaviour of this feature, not an
    // implementation detail of it.
    invalidateTenantSessions: overrides.invalidateTenantSessions
      || ((tenantId) => authService.invalidateTenantSessions(tenantId)),
    ...overrides,
  };
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function notFound(message) {
  const e = new Error(message);
  e.status = 404;
  return e;
}

// ───────────────────────────────────────────────────────────────────────────
// Normalised money
// ───────────────────────────────────────────────────────────────────────────

/**
 * One subscription's contribution to MRR, in dollars per month.
 *
 * Annual plans divide by 12 rather than counting in the month they bill, or the
 * overview's headline number would spike once a year and read as growth. ARB's
 * own vocabulary is `months` or `days`; a day-interval plan is normalised at 30
 * days to a month, which is an approximation and is only ever used for this one
 * display figure — never for a charge.
 */
export function monthlyValue(subscription) {
  const amount = Number(subscription?.amount ?? 0);
  const length = Number(subscription?.intervalLength ?? 0);
  if (!Number.isFinite(amount) || !Number.isFinite(length) || length <= 0) return 0;
  if (subscription.intervalUnit === 'months') return amount / length;
  if (subscription.intervalUnit === 'days') return (amount / length) * 30;
  return 0;
}

/**
 * Which statuses count toward MRR.
 *
 * ACTIVE and PAST_DUE only. PAST_DUE is money we are still owed and still trying
 * to collect, so dropping it would make a delinquency look like a cancellation
 * and quietly understate what is at stake. TRIALING has never charged anything
 * and SUSPENDED has stopped, so counting either would be inventing revenue.
 */
const MRR_STATUSES = new Set([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE]);

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Is this card within the expiry warning window?
 *
 * Compared on calendar months, not instants: a card is good through the LAST day
 * of its expiry month, so the cutoff is the first day of the following month.
 */
export function cardExpiryWarning(subscription, today) {
  const year = Number(subscription?.cardExpYear);
  const month = Number(subscription?.cardExpMonth);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !month) return null;
  const expiresAfter = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const horizon = addCalendarDays(today, CARD_EXPIRY_WARN_DAYS);
  if (expiresAfter > horizon) return null;
  return {
    cardExpMonth: month,
    cardExpYear: year,
    expired: expiresAfter <= today,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Screen 1 — the overview
// ───────────────────────────────────────────────────────────────────────────

/**
 * One row per TENANT, not per subscription.
 *
 * That is the whole point of the screen: a tenant with NO subscription row is
 * the row that matters most — revenue that is missing rather than late — and a
 * per-subscription query cannot produce it. `NONE` is a first-class status here,
 * exactly as it is in `summariseTenantBilling`.
 *
 * THREE QUERIES FOR THE WHOLE SCREEN, joined in memory. Tenant counts here are
 * in the dozens; an N+1 per row would be invisible today and a problem exactly
 * when the business grew enough for this screen to matter.
 */
export async function getBillingOverview(overrides = {}) {
  const d = deps(overrides);
  const now = d.now();
  const today = todayCalendarDate(now);

  const tenants = await d.prisma.tenant.findMany({ orderBy: { name: 'asc' } });
  const subs = await d.prisma.tenantSubscription.findMany({ orderBy: { createdAt: 'desc' } });
  const catalog = await getTenantPlanCatalog(d.prisma);

  const byTenant = new Map();
  for (const sub of subs) {
    const current = byTenant.get(sub.tenantId);
    // A live row always wins. Otherwise the newest terminal row stands in, so a
    // cancelled tenant still shows its history rather than reading as NONE —
    // "they left" and "nobody ever enrolled them" are different problems.
    const subIsLive = LIVE_SUBSCRIPTION_STATUSES.includes(sub.status);
    if (!current || (subIsLive && !LIVE_SUBSCRIPTION_STATUSES.includes(current.status))) {
      byTenant.set(sub.tenantId, sub);
    }
  }

  const subIds = [...byTenant.values()].map((s) => s.id);
  const charges = subIds.length
    ? await d.prisma.tenantSubscriptionCharge.findMany({
      where: { subscriptionId: { in: subIds } },
      orderBy: { chargeDate: 'desc' },
    })
    : [];
  const lastChargeBySub = new Map();
  for (const charge of charges) {
    if (!lastChargeBySub.has(charge.subscriptionId)) lastChargeBySub.set(charge.subscriptionId, charge);
  }

  const rows = tenants.map((tenant) => {
    const sub = byTenant.get(tenant.id) || null;
    const lastCharge = sub ? lastChargeBySub.get(sub.id) || null : null;
    const planConfig = resolveTenantPlanConfig(tenant.plan, catalog);

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      tenantStatus: tenant.status,
      // Distinguishes "switched off for not paying" from "switched off by hand
      // for some other reason". Restore refuses the second case (see below).
      billingSuspendedAt: tenant.billingSuspendedAt || null,
      tenantCreatedAt: tenant.createdAt || null,
      entitlementPlan: tenant.plan,
      entitlementPlanName: planConfig.name,

      status: sub ? sub.status : 'NONE',
      subscriptionId: sub ? sub.id : null,
      planCode: sub ? sub.planCode : null,
      planName: sub ? sub.planNameSnapshot : null,
      amount: sub ? String(sub.amount) : null,
      currency: sub ? sub.currency : null,
      intervalUnit: sub ? sub.intervalUnit : null,
      intervalLength: sub ? sub.intervalLength : null,
      startDate: sub ? sub.startDate : null,
      nextChargeDate: sub ? sub.nextChargeDate : null,
      trialEndsAt: sub ? sub.trialEndsAt : null,
      currentPeriodStart: sub ? sub.currentPeriodStart : null,
      currentPeriodEnd: sub ? sub.currentPeriodEnd : null,
      cardBrand: sub ? sub.cardBrand : null,
      cardLast4: sub ? sub.cardLast4 : null,
      cardExpiry: sub ? cardExpiryWarning(sub, today) : null,
      arbSubscriptionId: sub ? sub.arbSubscriptionId : null,
      arbStatusSnapshot: sub ? sub.arbStatusSnapshot : null,
      pastDueSince: sub ? sub.pastDueSince : null,
      suspendedAt: sub ? sub.suspendedAt : null,
      cancelledAt: sub ? sub.cancelledAt : null,
      cancelReason: sub ? sub.cancelReason : null,
      lastFailureCode: sub ? sub.lastFailureCode : null,
      lastReconciledAt: sub ? sub.lastReconciledAt : null,

      /**
       * THE DIVERGENCE BADGE. `Tenant.plan` is the ENTITLEMENT key (user and
       * vehicle caps); `TenantSubscription.planCode` is the BILLING key. Billing
       * never rewrites entitlements on its own — design open question 9, and the
       * owner confirmed by-hand — so when they disagree it is either a customer
       * paying for more than they can use or one using more than they pay for.
       * Neither is allowed to be invisible.
       */
      planDiverges: !!sub && sub.planCode !== tenant.plan,

      lastCharge: lastCharge
        ? {
          chargeDate: lastCharge.chargeDate,
          amount: String(lastCharge.amount),
          currency: lastCharge.currency,
          status: lastCharge.status,
          kind: lastCharge.kind,
        }
        : null,
      monthlyValue: sub && MRR_STATUSES.has(sub.status) ? round2(monthlyValue(sub)) : 0,
    };
  });

  return { rows, totals: summariseTotals(rows), asOf: today };
}

/** The strip across the top. Every number is derived from `rows`, never re-queried. */
export function summariseTotals(rows = []) {
  return {
    mrr: round2(rows.reduce((sum, r) => sum + (r.monthlyValue || 0), 0)),
    active: rows.filter((r) => r.status === SUBSCRIPTION_STATUS.ACTIVE).length,
    trialing: rows.filter((r) => r.status === SUBSCRIPTION_STATUS.TRIALING).length,
    pastDue: rows.filter((r) => r.status === SUBSCRIPTION_STATUS.PAST_DUE).length,
    suspended: rows.filter((r) => r.status === SUBSCRIPTION_STATUS.SUSPENDED).length,
    pendingAuthorization: rows.filter((r) => r.status === SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION).length,
    neverEnrolled: rows.filter((r) => r.status === 'NONE').length,
    planDiverges: rows.filter((r) => r.planDiverges).length,
    cardExpiring: rows.filter((r) => r.cardExpiry).length,
  };
}

/**
 * Default sort: SEVERITY, not alphabetical.
 *
 * The question this screen answers every morning is "who is in trouble today?",
 * not "where is Isla Verde?" — that is what the search box is for. Ties break on
 * name so the order is stable between loads.
 */
const SEVERITY_ORDER = [
  SUBSCRIPTION_STATUS.PAST_DUE,
  SUBSCRIPTION_STATUS.SUSPENDED,
  'NONE',
  SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION,
  SUBSCRIPTION_STATUS.TRIALING,
  SUBSCRIPTION_STATUS.ACTIVE,
];

/**
 * THE ONE RULE for what a billing restore puts `Tenant.status` back to.
 *
 * Exported and shared because the panel has to SAY what the button will do and
 * the service has to DO it — the same reason `suspensionEnforcement` is
 * serialised into the detail payload. Two copies of this rule would drift, and
 * the drift is a dialog promising one outcome while the write performs another,
 * which on this screen means lying about a paying customer's public surface.
 *
 * Rules, in order:
 *   - NOTHING RECORDED (null) -> ACTIVE. A tenant suspended before
 *     `billingPreviousStatus` existed, or by a path that did not record one.
 *     This is the old behaviour, kept deliberately as the fallback.
 *   - a recorded SUSPENDED -> ACTIVE. Restoring to SUSPENDED would clear
 *     `billingSuspendedAt` while leaving the tenant off, and restore refuses a
 *     suspension billing did not set — so that combination is the one state
 *     this screen could never undo again.
 *   - anything else -> itself, VERBATIM. Untrimmed, unchanged, byte for byte.
 *
 * NULL AND EMPTY STRING ARE NOT THE SAME THING, and collapsing them was a bug.
 * `Tenant.status` is non-nullable but tenants.service.js updateTenant writes
 * `String(patch.status || '').toUpperCase()`, so a tenant CAN sit at ''. That
 * tenant is already off the public surface (nothing matches '' either), and
 * treating its recorded '' as "nothing was recorded" would promote it to ACTIVE
 * and publish it — the exact defect this function exists to prevent, surviving
 * in the one branch nobody looks at. Only a NULL column means nothing was
 * recorded; '' means '' was.
 *
 * The SUSPENDED test is case-insensitive but the returned value keeps its
 * original casing and spacing. Both writers uppercase, but a row written by
 * hand could hold 'suspended', and a case-sensitive test would let it through
 * into the unrecoverable state above. Normalising the OUTPUT instead would mean
 * restore silently rewriting a value it was only asked to put back.
 */
export function resolveRestoredTenantStatus(billingPreviousStatus) {
  if (billingPreviousStatus == null) return 'ACTIVE';
  const previous = String(billingPreviousStatus);
  if (previous.trim().toUpperCase() === 'SUSPENDED') return 'ACTIVE';
  return previous;
}

export function severityRank(status) {
  const i = SEVERITY_ORDER.indexOf(status);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

export function sortBySeverity(rows = []) {
  return [...rows].sort((a, b) => severityRank(a.status) - severityRank(b.status)
    || String(a.tenantName).localeCompare(String(b.tenantName)));
}

// ───────────────────────────────────────────────────────────────────────────
// Screen 2 — the detail
// ───────────────────────────────────────────────────────────────────────────

/**
 * Everything about one tenant's billing, in one payload.
 *
 * Includes the archived consent verbatim (the disclosure text they actually read
 * before typing a card) and the raw Authorize.Net handles, because both are what
 * support reaches for during a dispute. This whole surface is SUPER_ADMIN-only
 * and `customerProfileId` is useless without the transaction key.
 */
export async function getTenantBillingDetail(tenantId, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();
  const today = todayCalendarDate(now);

  const tenant = await d.prisma.tenant.findUnique({ where: { id: String(tenantId) } });
  if (!tenant) throw notFound('Tenant not found');

  const subs = await d.prisma.tenantSubscription.findMany({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'desc' },
  });
  const current = subs.find((s) => LIVE_SUBSCRIPTION_STATUSES.includes(s.status)) || subs[0] || null;

  const catalog = await getTenantPlanCatalog(d.prisma);
  const entitlement = resolveTenantPlanConfig(tenant.plan, catalog);

  const charges = current
    ? await d.prisma.tenantSubscriptionCharge.findMany({
      where: { subscriptionId: current.id },
      orderBy: { chargeDate: 'desc' },
    })
    : [];

  const events = current
    ? await d.prisma.tenantSubscriptionEvent.findMany({
      where: { subscriptionId: current.id },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    })
    : [];

  const invites = current
    ? await d.prisma.autopayInvite.findMany({
      where: { subscriptionId: current.id },
      orderBy: { createdAt: 'desc' },
    })
    : [];

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      plan: tenant.plan,
      planName: entitlement.name,
      billingSuspendedAt: tenant.billingSuspendedAt || null,
      // What restore will put this tenant BACK to, for the same reason
      // suspensionEnforcement below is serialised: the dialog must describe the
      // lever the operator is really pulling, and only the server knows this
      // value. Without it the restore copy could only generalise ("normally
      // Active"), which is a hedge on a screen whose whole job is to be exact
      // about a customer's access.
      //
      // TWO fields, not one, because they answer different questions. The raw
      // value says what was RECORDED (null = nothing was, which is worth seeing
      // as itself). `restoresToStatus` is the RESOLVED answer, straight out of
      // the same helper restoreTenantAccess writes with, so the panel cannot
      // re-derive the rule and drift from it.
      billingPreviousStatus: tenant.billingPreviousStatus || null,
      restoresToStatus: resolveRestoredTenantStatus(tenant.billingPreviousStatus),
    },
    // Phase 5 (2026-08-28): WHAT SUSPENSION ACTUALLY DOES ON THIS DEPLOY.
    // 'off' | 'log' | 'enforce'. The suspend dialog must describe the lever the
    // operator is really pulling, and that depends on an environment variable
    // the frontend cannot see. Without this the panel would either keep saying
    // "staff can still sign in" after the gate went live, or start promising a
    // lockout that is switched off — both are lies about a lever being pulled
    // on a paying customer, which is the failure Phase 4 was careful to avoid.
    suspensionEnforcement: suspensionMode(),
    subscription: current ? publicSubscriptionView(current, today) : null,
    history: subs.filter((s) => !current || s.id !== current.id).map((s) => publicSubscriptionView(s, today)),
    charges: charges.map(publicChargeView),
    events: events.map(publicEventView),
    // The plaintext token is NEVER here — it exists exactly once, in the response
    // that minted it. `tokenPrefix` is what support uses to confirm "is this the
    // link I sent?" without the trail becoming a way in.
    invites: invites.map(publicInviteSummary),
    planDiverges: !!current && current.planCode !== tenant.plan,
    asOf: today,
  };
}

function publicSubscriptionView(sub, today) {
  return {
    id: sub.id,
    status: sub.status,
    planCode: sub.planCode,
    planName: sub.planNameSnapshot,
    amount: String(sub.amount),
    currency: sub.currency,
    intervalUnit: sub.intervalUnit,
    intervalLength: sub.intervalLength,
    startDate: sub.startDate,
    nextChargeDate: sub.nextChargeDate,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    trialEndsAt: sub.trialEndsAt,
    cardBrand: sub.cardBrand,
    cardLast4: sub.cardLast4,
    cardExpMonth: sub.cardExpMonth,
    cardExpYear: sub.cardExpYear,
    cardExpiry: cardExpiryWarning(sub, today),
    arbSubscriptionId: sub.arbSubscriptionId,
    customerProfileId: sub.customerProfileId,
    customerPaymentProfileId: sub.customerPaymentProfileId,
    arbStatusSnapshot: sub.arbStatusSnapshot,
    lastReconciledAt: sub.lastReconciledAt,
    lastWebhookAt: sub.lastWebhookAt,
    failedAttempts: sub.failedAttempts,
    lastFailureCode: sub.lastFailureCode,
    lastFailureText: sub.lastFailureText,
    lastFailureAt: sub.lastFailureAt,
    pastDueSince: sub.pastDueSince,
    suspendedAt: sub.suspendedAt,
    cancelledAt: sub.cancelledAt,
    cancelReason: sub.cancelReason,
    notes: sub.notes,
    // ── The consent archive. Stored verbatim at enrollment; a dispute is about
    // what THEY saw, not about what a template says today.
    authorizedAt: sub.authorizedAt,
    authorizedIp: sub.authorizedIp,
    authorizedEmail: sub.authorizedEmail,
    authorizedName: sub.authorizedName,
    authorizedDisclosureText: sub.authorizedDisclosureText,
    authorizedDisclosureHash: sub.authorizedDisclosureHash,
  };
}

/** The ledger row, rendered verbatim. `description` is stored, never recomputed. */
function publicChargeView(charge) {
  return {
    id: charge.id,
    kind: charge.kind,
    status: charge.status,
    amount: String(charge.amount),
    currency: charge.currency,
    chargeDate: charge.chargeDate,
    settledAt: charge.settledAt || null,
    description: charge.description,
    periodStart: charge.periodStart || null,
    periodEnd: charge.periodEnd || null,
    transId: charge.transId || null,
    arbPaymentNum: charge.arbPaymentNum ?? null,
    responseCode: charge.responseCode || null,
    responseReasonCode: charge.responseReasonCode || null,
    responseReasonText: charge.responseReasonText || null,
    cardBrand: charge.cardBrand || null,
    cardLast4: charge.cardLast4 || null,
    source: charge.source,
    prorationDays: charge.prorationDays ?? null,
    prorationDailyDelta: charge.prorationDailyDelta == null ? null : String(charge.prorationDailyDelta),
    fromPlanCode: charge.fromPlanCode || null,
    toPlanCode: charge.toPlanCode || null,
  };
}

/** "Did the webhook arrive?" answered without an SSH to the droplet. */
function publicEventView(event) {
  return {
    id: event.id,
    notificationId: event.notificationId,
    eventType: event.eventType,
    eventDate: event.eventDate || null,
    receivedAt: event.receivedAt,
    processedAt: event.processedAt || null,
    processingError: event.processingError || null,
    attempts: event.attempts,
    transId: event.transId || null,
  };
}

function publicInviteSummary(invite) {
  return {
    id: invite.id,
    mode: invite.mode,
    email: invite.email,
    tokenPrefix: invite.tokenPrefix,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    openedAt: invite.openedAt || null,
    usedAt: invite.usedAt || null,
    revokedAt: invite.revokedAt || null,
    attempts: invite.attempts,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Webhook + reconciler health — read-only
// ───────────────────────────────────────────────────────────────────────────

/**
 * The small operational strip above the overview.
 *
 * It exists because the failure that actually kills this module is the one that
 * leaves every other indicator looking healthy: the webhook endpoint silently
 * unreachable. Everything here is counted, never inferred.
 */
export async function getBillingHealth(overrides = {}) {
  const d = deps(overrides);
  const now = d.now();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const events = await d.prisma.tenantSubscriptionEvent.findMany({ orderBy: { receivedAt: 'desc' }, take: 200 });
  const unprocessed = events.filter((e) => !e.processedAt);
  const lastEvent = events[0] || null;

  const live = await d.prisma.tenantSubscription.findMany({
    where: { status: { in: LIVE_SUBSCRIPTION_STATUSES } },
  });

  const hoursSinceLastEvent = lastEvent
    ? (now.getTime() - new Date(lastEvent.receivedAt).getTime()) / 3_600_000
    : null;

  return {
    lastEventAt: lastEvent ? lastEvent.receivedAt : null,
    hoursSinceLastEvent: hoursSinceLastEvent == null ? null : round2(hoursSinceLastEvent),
    eventsLast24h: events.filter((e) => new Date(e.receivedAt) >= dayAgo).length,
    unprocessed: unprocessed.length,
    unprocessedStuck: unprocessed.filter((e) => (e.attempts || 0) >= 10).length,
    liveSubscriptions: live.length,
    // The 72-hour heartbeat from §4.5, surfaced rather than only emailed. Only
    // meaningful once something exists that should be producing events at all.
    silenceAlarm: live.length > 0 && (hoursSinceLastEvent == null || hoursSinceLastEvent >= 72),
    lastReconciledAt: live.reduce((latest, s) => {
      if (!s.lastReconciledAt) return latest;
      const t = new Date(s.lastReconciledAt);
      return !latest || t > latest ? t : latest;
    }, null),
    recentEvents: events.slice(0, 25).map(publicEventView),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// WRITE — cancel. ARB FIRST.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Stop billing this tenant. THE ORDER OF THE TWO WRITES IS THE WHOLE FEATURE.
 *
 * Design §2.2 names the failure this prevents as the worst outcome in the
 * module: a row marked CANCELLED whose ARB subscription is still live keeps
 * charging a card belonging to somebody who believes they cancelled, every
 * month, invisibly, until they notice on a statement and it becomes a
 * chargeback and a relationship.
 *
 * So: `ARBCancelSubscriptionRequest` FIRST, and our row is marked only after it
 * returns success. The three failure paths all land on the same side of the line
 * — WE STAY BILLING IN OUR OWN RECORDS:
 *
 *   throws   → ARB refused or was unreachable; nothing was cancelled. Row
 *              untouched, the operator sees the error, they can try again.
 *   times out→ WE DO NOT KNOW whether the cancel took effect. Row untouched, a
 *              distinct failure code is stamped, and the owner is alerted. The
 *              reconciler's `recentlyStopped`/live poll (detector 2) resolves it
 *              within a day by asking ARB what is actually true.
 *   success  → and only then, the row.
 *
 * Erring toward "we still think we are billing them" is the safe direction: it
 * shows up as a live row in the panel that a human can look at, and detector 2
 * corrects it. The opposite error is silent and costs a customer.
 *
 * A PENDING_AUTHORIZATION row with NO `arbSubscriptionId` is the one case that
 * skips the ARB call — there is nothing at Authorize.Net to cancel, because no
 * card was ever saved. That is the abandoned-invite path from §2.2 and it is
 * guarded on `arbSubscriptionId == null`, not on status alone, because a PENDING
 * row that somehow has an ARB id is exactly the stale-state case that must NOT
 * be marked cancelled without a real call.
 */
export async function cancelSubscriptionForTenant(input = {}, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();

  assertCancelConfirmed(input.confirm);

  const subscription = await d.prisma.tenantSubscription.findUnique({
    where: { id: String(input.subscriptionId) },
  });
  if (!subscription) throw notFound('Subscription not found');
  if (!LIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
    throw badRequest(`This subscription is already ${subscription.status}. There is nothing to cancel.`);
  }

  const reason = String(input.reason || '').trim();
  if (!reason) {
    // Not bureaucracy: in three months "why did we stop billing them?" has
    // exactly one place to be answered from, and this is it.
    throw badRequest('A cancellation reason is required.');
  }

  const actor = {
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    actorRole: input.actorRole ?? null,
  };

  // ── STEP 1: Authorize.Net. Nothing below this line runs unless it succeeded.
  if (subscription.arbSubscriptionId) {
    try {
      await d.cancelSubscription(subscription.arbSubscriptionId);
    } catch (err) {
      const timedOut = /timed out after/.test(String(err?.message || ''));
      logAuthnetFailure('ARBCancelSubscription', err, {
        subscriptionId: subscription.id,
        tenantId: subscription.tenantId,
      });

      // The row is NOT cancelled. It records that we tried and what happened, so
      // the panel shows the attempt rather than looking like nobody pressed it.
      await d.prisma.tenantSubscription.update({
        where: { id: subscription.id },
        data: {
          lastFailureCode: timedOut ? 'ARB_CANCEL_TIMEOUT' : 'ARB_CANCEL_FAILED',
          lastFailureText: timedOut
            ? 'ARBCancelSubscriptionRequest timed out — it is unknown whether the cancel took effect.'
            : 'ARBCancelSubscriptionRequest failed; the subscription is still live at Authorize.Net.',
          lastFailureAt: now,
        },
      });

      await d.recordAudit({
        tenantId: subscription.tenantId,
        ...actor,
        action: AUDIT_ACTIONS.SUBSCRIPTION_CANCEL,
        targetType: 'TenantSubscription',
        targetId: subscription.id,
        outcome: AUDIT_OUTCOME.FAILURE,
        metadata: {
          arbSubscriptionId: subscription.arbSubscriptionId,
          reason,
          failure: timedOut ? 'ARB_CANCEL_TIMEOUT' : 'ARB_CANCEL_FAILED',
        },
      });

      if (timedOut) {
        // A timeout is the genuinely dangerous one: we may or may not still be
        // charging them. A human has to know today, not at the next reconcile.
        await d.notifyOwner('CANCELLED', { ...subscription, cancelReason: 'ARB_CANCEL_TIMEOUT' }, {
          detectedBy: 'admin cancel — Authorize.Net timed out, state UNKNOWN',
        });
      }

      throw badRequest(
        timedOut
          ? 'Authorize.Net timed out. It is unknown whether the subscription was cancelled, so nothing '
            + 'was changed here. Check the Authorize.Net portal, or wait for the daily reconcile to '
            + 'adopt whatever ARB reports.'
          : 'Authorize.Net refused the cancellation, so the subscription is still live and nothing was '
            + 'changed here. Try again, or cancel it in the Authorize.Net portal.',
      );
    }
  }

  // ── STEP 2: only now, our row.
  const updated = await d.prisma.tenantSubscription.update({
    where: { id: subscription.id },
    data: {
      status: SUBSCRIPTION_STATUS.CANCELLED,
      cancelledAt: now,
      cancelReason: reason,
      cancelRequestedByUserId: input.actorUserId ?? null,
      // No charge is coming. A stale date would keep feeding detector 3 a charge
      // to hunt for that can never happen.
      nextChargeDate: null,
      lastFailureCode: null,
      lastFailureText: null,
    },
  });

  // Outstanding links die with the subscription they would have activated.
  for (const stale of await d.prisma.autopayInvite.findMany({
    where: { subscriptionId: subscription.id, usedAt: null, revokedAt: null },
  })) {
    await revokeInvite(stale.id, overrides);
  }

  await d.recordAudit({
    tenantId: subscription.tenantId,
    ...actor,
    action: AUDIT_ACTIONS.SUBSCRIPTION_CANCEL,
    targetType: 'TenantSubscription',
    targetId: subscription.id,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: {
      arbSubscriptionId: subscription.arbSubscriptionId,
      planCode: subscription.planCode,
      amount: String(subscription.amount),
      currency: subscription.currency,
      reason,
      from: subscription.status,
      to: SUBSCRIPTION_STATUS.CANCELLED,
      // True only for a row that never had anything at Authorize.Net.
      arbCallSkipped: !subscription.arbSubscriptionId,
    },
  });

  return publicSubscriptionView(updated, todayCalendarDate(now));
}

// ───────────────────────────────────────────────────────────────────────────
// WRITE — manual suspend / restore
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cut a non-payer off, by hand, today.
 *
 * This is the point of Phase 4. Phase 5 automates the DECISION to pull this
 * lever; the lever itself lands here so the owner has the business capability
 * before any automation exists to get it wrong.
 *
 * WHAT IT ACTUALLY DOES TODAY, STATED PLAINLY BECAUSE THE UI MUST NOT OVERSELL:
 *   - `Tenant.status = 'SUSPENDED'` — which today really does darken the
 *     tenant's public booking site and stop their Economy / NU / booking-source
 *     syncs, because those surfaces already read it.
 *   - `Tenant.billingSuspendedAt` — the marker that separates "suspended for not
 *     paying" from "suspended by hand for some other reason".
 *   - `TenantSubscription.status = 'SUSPENDED'` + `suspendedAt`, keeping §2.2's
 *     invariant that our SUSPENDED and `Tenant.status` never disagree.
 *
 * STAFF LOCKOUT — PHASE 5, AND IT DEPENDS ON A SWITCH (updated 2026-08-28).
 * `requireAuth` now consults `lib/tenant-suspension.js` on every authenticated
 * request, but ONLY when TENANT_SUSPENSION_ENFORCEMENT is `enforce`. Until that
 * variable is set, this lever does exactly what it did in Phase 4 and nothing
 * more, and the panel copy must keep saying so. Whether staff are actually
 * locked out is a deploy-time fact this function cannot see, so it must not
 * claim either way — `getBillingHealth` surfaces the mode instead.
 *
 * WHAT IT ALWAYS DOES NOW: busts every cached session of this tenant, so that
 * when enforcement IS on the lockout is immediate rather than arriving as each
 * user's 30-second session cache happens to lapse.
 *
 * IT DOES NOT CANCEL AT AUTHORIZE.NET EITHER. Design open question 6 — cancel on
 * suspension, or leave it suspended — is UNANSWERED, and the conservative half
 * is to leave ARB alone: a subscription we cancel cannot be resumed without the
 * customer re-entering a card, and that is not a side effect a "suspend access"
 * button gets to have.
 */
export async function suspendTenantAccess(input = {}, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();

  const tenant = await d.prisma.tenant.findUnique({ where: { id: String(input.tenantId) } });
  if (!tenant) throw notFound('Tenant not found');

  const reason = String(input.reason || '').trim();
  if (!reason) throw badRequest('A suspension reason is required.');

  if (tenant.status === 'SUSPENDED') {
    throw badRequest(`${tenant.name} is already suspended.`);
  }

  const subscription = await d.prisma.tenantSubscription.findFirst({
    where: { tenantId: tenant.id, status: { in: LIVE_SUBSCRIPTION_STATUSES } },
  });

  const writes = [
    d.prisma.tenant.update({
      where: { id: tenant.id },
      // billingPreviousStatus is captured in the SAME write that sets
      // SUSPENDED, so the pair can never disagree: there is no window in which
      // a tenant is off with no record of what it was.
      data: { status: 'SUSPENDED', billingSuspendedAt: now, billingPreviousStatus: tenant.status },
    }),
  ];
  if (subscription && subscription.status !== SUBSCRIPTION_STATUS.SUSPENDED) {
    writes.push(d.prisma.tenantSubscription.update({
      where: { id: subscription.id },
      data: { status: SUBSCRIPTION_STATUS.SUSPENDED, suspendedAt: now },
    }));
  }
  await d.prisma.$transaction(writes);

  // AFTER the write has committed, never before. Busting first would leave a
  // window in which a re-hydrating session reloads the OLD status and caches it
  // again for another 30 seconds — a bust that makes the staleness worse.
  const bust = await d.invalidateTenantSessions(tenant.id);

  await d.recordAudit({
    tenantId: tenant.id,
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    actorRole: input.actorRole ?? null,
    action: AUDIT_ACTIONS.TENANT_SUSPEND,
    targetType: 'Tenant',
    targetId: tenant.id,
    metadata: {
      reason,
      previousTenantStatus: tenant.status,
      subscriptionId: subscription ? subscription.id : null,
      previousSubscriptionStatus: subscription ? subscription.status : null,
      arbSubscriptionId: subscription ? subscription.arbSubscriptionId : null,
      // Recorded so the trail says what was and was NOT done: the ARB
      // subscription is deliberately left alone (open question 6).
      arbSubscriptionCancelled: false,
      // How many staff sessions were dropped, and the enforcement mode in
      // force at the time. Six months from now "why did the lockout take a
      // minute" is answerable from the trail instead of from a guess.
      sessionsInvalidated: bust?.invalidated ?? 0,
      suspensionEnforcement: suspensionMode(),
    },
  });

  return {
    tenantId: tenant.id,
    status: 'SUSPENDED',
    billingSuspendedAt: now,
    sessionsInvalidated: bust?.invalidated ?? 0,
    // So the panel can say "staff are locked out now" or "staff are NOT locked
    // out — enforcement is off" rather than overselling the lever.
    suspensionEnforcement: suspensionMode(),
  };
}

/**
 * Turn a tenant back on.
 *
 * REFUSES TO LIFT A SUSPENSION BILLING DID NOT SET. If `billingSuspendedAt` is
 * null, somebody switched this tenant off by hand for a reason the billing panel
 * cannot see — a compliance hold, an offboarding, an investigation — and a
 * "Restore" button on the billing screen has no business guessing that the
 * reason has passed. Design §1.6 states the rule for the automation; it applies
 * at least as strongly to a human clicking from the wrong screen.
 */
export async function restoreTenantAccess(input = {}, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();

  const tenant = await d.prisma.tenant.findUnique({ where: { id: String(input.tenantId) } });
  if (!tenant) throw notFound('Tenant not found');
  if (tenant.status !== 'SUSPENDED') throw badRequest(`${tenant.name} is not suspended.`);

  if (!tenant.billingSuspendedAt) {
    throw badRequest(
      `${tenant.name} was not suspended by billing, so this screen will not restore it. `
      + 'Someone switched this tenant off by hand for a reason billing cannot see. '
      + 'Restore it from the Tenants screen once you know what that reason was.',
    );
  }

  const subscription = await d.prisma.tenantSubscription.findFirst({
    where: { tenantId: tenant.id, status: SUBSCRIPTION_STATUS.SUSPENDED },
  });

  /**
   * WHAT THE SUBSCRIPTION GOES BACK TO — and why not ACTIVE.
   *
   * Restoring access is not evidence that money moved. If the reason they were
   * suspended was a decline, that decline is still unresolved until a settled
   * charge lands, so the row returns to PAST_DUE and stays visible as a
   * delinquency. Only a real payment (webhook or reconciler) clears it. Marking
   * it ACTIVE here would launder an unpaid invoice into a healthy row and remove
   * it from the one list that would have chased it.
   */
  const restoredStatus = subscription?.pastDueSince
    ? SUBSCRIPTION_STATUS.PAST_DUE
    : SUBSCRIPTION_STATUS.ACTIVE;

  /**
   * WHAT THE TENANT GOES BACK TO — whatever it was, not ACTIVE.
   *
   * `Tenant.status` is a free-text String — tenants.service.js updateTenant
   * accepts any string and only uppercases it — and ACTIVE is not a synonym for
   * "on": the public booking token resolver, resolvePublicTenant() in the
   * booking engine and the car-sharing marketplace tenant list all match
   * `status: 'ACTIVE'` exactly. Restoring a tenant that held ANY other value to
   * ACTIVE therefore does not just mislabel it, it puts it on the public booking
   * surface. Suspend recorded the real value; read it back.
   *
   * The fallback is ACTIVE, for a tenant suspended before billingPreviousStatus
   * existed or by a path that did not record one. SUSPENDED is treated as
   * nothing recorded: restoring to SUSPENDED would leave the tenant off with
   * billingSuspendedAt cleared, which is the one state this screen can no
   * longer undo.
   *
   * DELIBERATELY NOT AN INPUT. The caller does not get to name the target
   * status — that would turn a restore button into a status editor. It comes
   * only from what suspend itself wrote.
   */
  const restoredTenantStatus = resolveRestoredTenantStatus(tenant.billingPreviousStatus);

  const writes = [
    d.prisma.tenant.update({
      where: { id: tenant.id },
      // Cleared alongside billingSuspendedAt: both describe a suspension that
      // is over, and a stale value here would be read by the NEXT restore.
      data: { status: restoredTenantStatus, billingSuspendedAt: null, billingPreviousStatus: null },
    }),
  ];
  if (subscription) {
    writes.push(d.prisma.tenantSubscription.update({
      where: { id: subscription.id },
      data: { status: restoredStatus, suspendedAt: null },
    }));
  }
  await d.prisma.$transaction(writes);

  // THE BUST MATTERS MORE ON RESTORE THAN ON SUSPEND. A late suspension costs
  // us thirty seconds of service we were going to give away anyway; a late
  // restore leaves a customer who has just paid still staring at a hold screen,
  // on the phone, being told it is fixed. Same call, much worse failure.
  const bust = await d.invalidateTenantSessions(tenant.id);

  await d.recordAudit({
    tenantId: tenant.id,
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    actorRole: input.actorRole ?? null,
    action: AUDIT_ACTIONS.TENANT_RESTORE,
    targetType: 'Tenant',
    targetId: tenant.id,
    metadata: {
      reason: String(input.reason || '').trim() || null,
      subscriptionId: subscription ? subscription.id : null,
      subscriptionStatus: subscription ? restoredStatus : null,
      suspendedSince: tenant.billingSuspendedAt,
      // What it went back to, and whether that came from a recorded value or
      // from the ACTIVE fallback — so a restore that guessed is distinguishable
      // in the trail from one that knew.
      restoredTenantStatus,
      previousTenantStatus: tenant.billingPreviousStatus ?? null,
      sessionsInvalidated: bust?.invalidated ?? 0,
    },
  });

  return {
    tenantId: tenant.id,
    status: restoredTenantStatus,
    subscriptionStatus: subscription ? restoredStatus : null,
    sessionsInvalidated: bust?.invalidated ?? 0,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// WRITE — apply the billing plan to entitlements
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reconcile `Tenant.plan` (entitlements) to `TenantSubscription.planCode`
 * (billing). THE ONLY WAY THE TWO EVER GET RECONCILED, and always a deliberate
 * click.
 *
 * The owner's rule is that billing never auto-changes `Tenant.plan`: activating
 * a subscription does not silently widen or narrow what a tenant may do. So the
 * overview badges the divergence and this is the one action that clears it. It
 * moves entitlements ONLY — it never touches `amount`, never re-prices anything,
 * and never calls Authorize.Net. Money does not move here.
 */
export async function applyPlanToEntitlements(input = {}, overrides = {}) {
  const d = deps(overrides);

  const tenant = await d.prisma.tenant.findUnique({ where: { id: String(input.tenantId) } });
  if (!tenant) throw notFound('Tenant not found');

  const subscription = await d.prisma.tenantSubscription.findFirst({
    where: { tenantId: tenant.id, status: { in: LIVE_SUBSCRIPTION_STATUSES } },
  });
  if (!subscription) {
    throw badRequest(`${tenant.name} has no live subscription, so there is no billing plan to apply.`);
  }
  if (subscription.planCode === tenant.plan) {
    throw badRequest(`${tenant.name} is already entitled at ${tenant.plan}. Nothing to apply.`);
  }

  const catalog = await getTenantPlanCatalog(d.prisma);
  const target = resolveTenantPlanConfig(subscription.planCode, catalog);
  if (!target.isActive) {
    // resolveTenantPlanConfig returns a synthetic inactive entry for a code the
    // catalog does not know, so this catches both "retired plan" and "typo".
    throw badRequest(
      `Plan ${subscription.planCode} is not active in the plan catalog, so it cannot be applied as an `
      + 'entitlement. Fix the catalog first.',
    );
  }

  /**
   * DOWNGRADES ARE NOT BLOCKED HERE, ON PURPOSE.
   *
   * Applying a smaller plan can leave a tenant over the new cap — more users or
   * vehicles than the plan allows. The existing capacity guards
   * (`assertTenantUserCapacity` / `assertTenantVehicleCapacity`) refuse the NEXT
   * create rather than deleting anything, which is the correct behaviour and
   * needs no help from here. Refusing the apply instead would leave billing and
   * entitlement permanently diverged, which is the state this action exists to
   * end. The counts go in the audit row so the consequence is on the record.
   */
  const previousPlan = tenant.plan;
  const updated = await d.prisma.tenant.update({
    where: { id: tenant.id },
    data: { plan: subscription.planCode },
  });

  await d.recordAudit({
    tenantId: tenant.id,
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    actorRole: input.actorRole ?? null,
    action: AUDIT_ACTIONS.TENANT_PLAN_APPLY,
    targetType: 'Tenant',
    targetId: tenant.id,
    metadata: {
      from: previousPlan,
      to: subscription.planCode,
      subscriptionId: subscription.id,
      source: 'BILLING_PANEL',
      maxUsers: target.maxUsers,
      maxVehicles: target.maxVehicles,
    },
  });

  return { tenantId: tenant.id, plan: updated.plan, previousPlan };
}

// ───────────────────────────────────────────────────────────────────────────
// WRITE — the update-payment link, and the thing that is NOT "retry"
// ───────────────────────────────────────────────────────────────────────────

/**
 * Email the tenant a link to replace the card behind an EXISTING subscription.
 *
 * `mode: 'update'` — the plan, the amount and the schedule do not change; only
 * the payment method the ARB subscription points at. This is the remedy for a
 * decline, and per the verified Authorize.Net behaviour it is the ONLY remedy:
 * ARB resumes its nightly retries once, and only once, the payment method has
 * been updated (billing-events.js:11-15). Waiting does not fix a suspended ARB
 * subscription; a new card does.
 *
 * Requires a live ARB subscription. A tenant with no card yet needs an ENROLL
 * link, which is the existing `/tenants` row button, not this.
 */
export async function sendUpdatePaymentLink(input = {}, overrides = {}) {
  const d = deps(overrides);

  const subscription = await d.prisma.tenantSubscription.findUnique({
    where: { id: String(input.subscriptionId) },
  });
  if (!subscription) throw notFound('Subscription not found');
  if (!subscription.arbSubscriptionId) {
    throw badRequest(
      'This subscription has no payment method at Authorize.Net yet, so there is nothing to update. '
      + 'Send an enrollment link instead.',
    );
  }
  if (!LIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
    throw badRequest(`This subscription is ${subscription.status}. An update link would have nothing to repoint.`);
  }

  const tenant = await d.prisma.tenant.findUnique({ where: { id: subscription.tenantId } });
  if (!tenant) throw notFound('Tenant not found');

  // Falls back to the address that authorised the subscription — the person who
  // typed the card is the person who can replace it. Open question 11 (a durable
  // per-tenant billing contact) is unanswered, so this stays on the subscription.
  const email = String(input.email || subscription.authorizedEmail || '').trim();
  if (!email) {
    throw badRequest('A billing contact email is required — it is who the link goes to.');
  }

  const companyName = String(input.companyName || subscription.authorizedName || tenant.name);

  // Old update links die when a new one is minted, exactly as a resent enroll
  // link kills its predecessor. Two live links to the same subscription is two
  // chances to repoint it at two different cards.
  for (const stale of await d.prisma.autopayInvite.findMany({
    where: { subscriptionId: subscription.id, mode: 'update', usedAt: null, revokedAt: null },
  })) {
    await revokeInvite(stale.id, overrides);
  }

  const disclosureText = buildDisclosureText({
    companyName,
    planName: subscription.planNameSnapshot,
    amount: subscription.amount,
    currency: subscription.currency,
    intervalUnit: subscription.intervalUnit,
    intervalLength: subscription.intervalLength,
    firstChargeDate: subscription.nextChargeDate || subscription.startDate,
    email,
  });

  const { invite, token, url } = await createInvite({
    mode: 'update',
    tenantId: tenant.id,
    subscriptionId: subscription.id,
    merchantCustomerId: merchantCustomerIdForTenant(tenant.id),
    email,
    companyName,
    planCode: subscription.planCode,
    planName: subscription.planNameSnapshot,
    amount: subscription.amount,
    intervalUnit: subscription.intervalUnit,
    intervalLength: subscription.intervalLength,
    startDate: subscription.startDate,
    nextChargeDate: subscription.nextChargeDate,
    trialOccurrences: 0,
    trialAmount: null,
    // The existing profile, so the hosted page opens on THEIR stored methods
    // rather than minting a second customer profile for the same tenant.
    customerProfileId: subscription.customerProfileId,
    disclosureText,
    validForDays: input.validForDays,
    createdByUserId: input.actorUserId ?? null,
  }, overrides);

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
      mode: 'update',
      planCode: subscription.planCode,
      arbSubscriptionId: subscription.arbSubscriptionId,
      expiresAt: invite.expiresAt.toISOString(),
    },
  });

  return { url, token, invite: publicInviteSummary(invite) };
}

/** Kill every outstanding link for a subscription — a link sent to the wrong address. */
export async function revokeOutstandingInvites(input = {}, overrides = {}) {
  const d = deps(overrides);

  const subscription = await d.prisma.tenantSubscription.findUnique({
    where: { id: String(input.subscriptionId) },
  });
  if (!subscription) throw notFound('Subscription not found');

  const outstanding = await d.prisma.autopayInvite.findMany({
    where: { subscriptionId: subscription.id, usedAt: null, revokedAt: null },
  });

  let revoked = 0;
  for (const invite of outstanding) {
    if (await revokeInvite(invite.id, overrides)) {
      revoked += 1;
      await d.recordAudit({
        tenantId: subscription.tenantId,
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        actorRole: input.actorRole ?? null,
        action: AUDIT_ACTIONS.AUTOPAY_INVITE_REVOKE,
        targetType: 'AutopayInvite',
        targetId: invite.id,
        metadata: { tokenPrefix: invite.tokenPrefix, mode: invite.mode, subscriptionId: subscription.id },
      });
    }
  }

  return { revoked };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO "RETRY CHARGE" BUTTON IN THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The design's Phase 4 line item says "retry", and the approved mockup draws a
 * "Reintentar cobro ahora" button next to "Intento 2 de 3 · Authorize.Net
 * reintenta el 27 de agosto". Both are wrong, and shipping either would be a lie
 * told to an operator about somebody else's money. The verified behaviour
 * (billing-events.js:11-15) is:
 *
 *   - A declined ARB payment SUSPENDS the subscription at Authorize.Net.
 *   - Authorize.Net retries NIGHTLY — but ONLY once the payment method has been
 *     updated. Until then the subscription stays suspended indefinitely.
 *   - There is NO fixed retry count. "Attempt 2 of 3" is a number nobody is
 *     counting; `failedAttempts` is a count of SIGNALS WE SAW, not a countdown
 *     ARB is running, and rendering it as one would invent a deadline.
 *
 * So a "Retry" button cannot do what an operator would expect it to do:
 *
 *   Force a charge now?  That means `chargeCustomerProfileRequest` — a direct,
 *                        novel charge outside the subscription schedule. It is
 *                        not implemented (§4.6 lists it as missing), it is
 *                        Phase 6 work, and critically it would NOT un-suspend
 *                        the ARB subscription: we would take the customer's
 *                        money and still not be billing them. That is a worse
 *                        state than the one we started in.
 *   Reactivate at ARB?   There is no reactivate call. The documented mechanism
 *                        that resumes billing IS the payment-method update.
 *   Tell ARB to hurry?   Nothing to send.
 *
 * The honest answer is that no retry action exists. What exists is
 * `sendUpdatePaymentLink` above — the actual remedy — and `refreshFromAuthorizeNet`
 * below, which answers the question the operator is really asking when they
 * reach for "retry": *has it gone through yet?* Neither pretends to have forced
 * a charge, because neither did.
 *
 * The panel must therefore never render "attempt N of M" or a next-retry date.
 * It says suspended, and it offers the update-method path.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Ask Authorize.Net what is actually true about this subscription, now.
 *
 * READ-ONLY AT ARB. It moves no money and starts nothing. What it can change is
 * OUR row, and only by adopting what ARB reports — reusing the reconciler's
 * `applyDrift` rather than reimplementing the comparison, so the same escalation
 * rules, the same synthetic `reconcile.status-drift` event and the same owner
 * alert apply whether the poll came from the nightly sweep or from a person
 * clicking a button.
 *
 * `applyDrift` refuses to DE-escalate — ARB reporting `active` against our
 * PAST_DUE or SUSPENDED is recorded and alerted but not adopted, because a
 * status is not a payment and only a settled charge clears a delinquency. That
 * is also what stops this button from quietly undoing a manual suspension.
 */
export async function refreshFromAuthorizeNet(input = {}, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();

  const subscription = await d.prisma.tenantSubscription.findUnique({
    where: { id: String(input.subscriptionId) },
  });
  if (!subscription) throw notFound('Subscription not found');
  if (!subscription.arbSubscriptionId) {
    throw badRequest('This subscription does not exist at Authorize.Net yet, so there is nothing to check.');
  }

  let arbStatus;
  try {
    arbStatus = await d.getSubscriptionStatus(subscription.arbSubscriptionId);
  } catch (err) {
    logAuthnetFailure('ARBGetSubscriptionStatus', err, {
      subscriptionId: subscription.id,
      tenantId: subscription.tenantId,
    });
    throw badRequest('Could not reach Authorize.Net. Nothing was changed.');
  }

  const outcome = await d.applyDrift(subscription, arbStatus, now, {}, overrides);
  const after = await d.prisma.tenantSubscription.findUnique({ where: { id: subscription.id } });

  return {
    arbStatus,
    // 'agree' | 'escalated' | 'refused' | 'unmapped' | 'no-status' — surfaced
    // rather than flattened to a boolean, because "ARB says something we do not
    // recognise" and "ARB agrees" must not look the same in the panel.
    outcome,
    status: after ? after.status : subscription.status,
    previousStatus: subscription.status,
  };
}

export const billingAdmin = {
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
  summariseTotals,
  sortBySeverity,
  monthlyValue,
  cardExpiryWarning,
  CANCEL_CONFIRMATION,
  assertCancelConfirmed,
};
