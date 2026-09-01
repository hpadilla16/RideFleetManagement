/**
 * Plan changes + proration — Phase 6, last on purpose (design §6, §9).
 *
 * This is the only part of the billing module that computes a NOVEL amount —
 * a number nobody agreed to in advance — which is why it shipped after the
 * history surface that can explain the odd charge existed (Phase 4) and after
 * the detectors that would notice it going wrong existed (Phase 2).
 *
 * THE DEFAULT IS THE BORING ONE, AND THAT IS THE FEATURE
 * ---------------------------------------------------------------------------
 * A plan/amount change is SCHEDULED for the next period boundary and applied
 * by the daily reconciler via ARBUpdateSubscriptionRequest. No proration, no
 * refund, no odd amount: "your new price starts at your next renewal", which
 * is what every SaaS the customer already uses does (§6.3). Two verified ARB
 * facts force this shape:
 *
 *   - ARBUpdateSubscription's amount applies to FUTURE charges only. A charge
 *     ARB has already scheduled for today cannot be re-priced reliably, so the
 *     boundary we store is the day BEFORE the charge (currentPeriodEnd), and
 *     the daily sweep has a full day of margin to land the update.
 *   - ARB cannot express a credit or a partial charge on a schedule, so any
 *     mid-cycle money movement is a separate one-off chargeCustomerProfile.
 *
 * MID-CYCLE PRORATION EXISTS BUT IS OPT-IN PER CALL (§6.2), upgrades only,
 * behind an explicit `prorateNow: true` plus an `expectedProration` echo of
 * the previewed number — a stale preview cannot charge a different amount
 * than the operator saw. Downgrades NEVER move money mid-cycle (§6.3: a
 * mid-cycle refund invites downgrade-and-re-upgrade as a cash-flow tool, and
 * "no ambiguous-money failure mode" beats "sooner").
 *
 * CYCLE CHANGES (monthly ↔ annual) ARE NOT HERE. ARB cannot change an
 * interval after creation; the §6.4 cancel+create dance is deliberate future
 * work, and until then a cycle change is done by hand: cancel + re-enroll.
 *
 * IDEMPOTENCY OF THE BOUNDARY APPLY — the two-worker case
 * ---------------------------------------------------------------------------
 * The ARB call goes FIRST and is idempotent at ARB (setting the amount to X
 * twice leaves X). The database apply is an atomic CLAIM: an updateMany whose
 * WHERE re-asserts the exact pending values being applied. Two workers racing
 * the same boundary may both call ARB — harmless — but only one claim
 * matches, and only the claimer writes the audit row and the synthetic event.
 * The event's notificationId is deterministic on the effective date, so even
 * a claim raced across days cannot double-record.
 *
 * FAILURE DIRECTION, EVERYWHERE: toward "nothing happened" (§6.5). A declined
 * proration leaves the old plan standing. An unknown-state proration is NEVER
 * retried automatically — an ERROR row with our refId surfaces loudly and a
 * human resolves it against the Authorize.Net portal. Money taken with the
 * ARB update then failing is the one state that self-heals: the row already
 * shows the new plan the customer paid for, and the pending fields are set to
 * TODAY so the daily sweep retries the (idempotent) ARB update until it lands.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { getTenantPlanCatalog, resolveTenantPlanConfig } from '../../lib/tenant-plan-limits.js';
import { recordAudit, AUDIT_ACTIONS, AUDIT_OUTCOME } from '../audit/audit.service.js';
import {
  updateSubscriptionAmount as arbUpdateSubscriptionAmount,
  chargeCustomerProfile as arbChargeCustomerProfile,
  logAuthnetFailure,
} from './authorize-net.js';
import {
  SUBSCRIPTION_STATUS,
  CHARGE_KIND,
  CHARGE_STATUS,
  CHARGE_SOURCE,
} from './billing.service.js';
import { BILLING_EVENT } from './billing-events.js';
import { notifyOwner } from './billing-notify.js';
import {
  todayCalendarDate,
  addCalendarDays,
  assertCalendarDate,
  isCalendarDate,
  formatCalendarDateEs,
  formatMoney,
} from './billing-dates.js';

/**
 * Below this, a proration charge is skipped and the plan simply changes
 * (§6.2 step 1): a sub-dollar card charge costs more in disputes and fees
 * than it earns. OPEN QUESTION 7 names the floor as an owner decision that is
 * still unanswered, so the default is the conservative $1.00 and the env var
 * keeps the alternative a deploy away rather than a build away.
 */
export const PRORATION_FLOOR = Number(process.env.BILLING_PRORATION_FLOOR || 1);

/** Statuses a change may be scheduled against. */
const SCHEDULABLE = [
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.TRIALING,
  SUBSCRIPTION_STATUS.PAST_DUE,
];

const BATCH = 200;

function deps(overrides = {}) {
  return {
    prisma: overrides.prisma || prisma,
    logger: overrides.logger || logger,
    now: overrides.now || (() => new Date()),
    recordAudit: overrides.recordAudit || recordAudit,
    notifyOwner: overrides.notifyOwner || notifyOwner,
    updateSubscriptionAmount: overrides.updateSubscriptionAmount || arbUpdateSubscriptionAmount,
    chargeCustomerProfile: overrides.chargeCustomerProfile || arbChargeCustomerProfile,
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

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Whole days from `a` to `b` (calendar dates), UTC-pinned. Negative if b < a. */
export function daysBetween(a, b) {
  const [ay, am, ad] = assertCalendarDate(a).split('-').map(Number);
  const [by, bm, bd] = assertCalendarDate(b).split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

// ───────────────────────────────────────────────────────────────────────────
// The arithmetic (§6.1) — pure, testable, UTC only
// ───────────────────────────────────────────────────────────────────────────

/**
 * What a mid-cycle upgrade owes for the rest of the period.
 *
 * Day counts are INCLUSIVE: a period that runs the 1st through the 30th is 30
 * days, and a change made on the 16th leaves 15 days (the 16th through the
 * 30th) on the new price — the day the operator clicks is the first day the
 * customer has the new plan, so it is a day they pay the difference for.
 * (§6.1 writes the arithmetic as bare subtractions; the inclusive form is
 * pinned here and in the suite so nobody re-derives it off by one.)
 *
 * All arithmetic on YYYY-MM-DD strings via Date.UTC. Never a local Date —
 * that is how you bill somebody for 31 days in a 30-day month.
 */
export function computeProration({ currentPeriodStart, currentPeriodEnd, today, oldAmount, newAmount }) {
  const periodDays = daysBetween(currentPeriodStart, currentPeriodEnd) + 1;
  if (periodDays <= 0) throw badRequest('The current period is empty — nothing to prorate against.');
  const rawRemaining = daysBetween(today, currentPeriodEnd) + 1;
  const remainingDays = Math.max(0, Math.min(periodDays, rawRemaining));
  const dailyDelta = (Number(newAmount) - Number(oldAmount)) / periodDays;
  return {
    periodDays,
    remainingDays,
    // Four decimals, matching the ledger's prorationDailyDelta DECIMAL(10,4).
    dailyDelta: Number(dailyDelta.toFixed(4)),
    proration: round2(dailyDelta * remainingDays),
  };
}

/**
 * The stored ledger sentence for a proration charge (§1.3) — Spanish, matching
 * every other stored description, written ONCE at charge time from the numbers
 * actually used and never recomputed from a catalog that may since be edited.
 */
export function buildProrationChargeDescription({
  fromPlanName,
  toPlanName,
  fromAmount,
  toAmount,
  remainingDays,
  dailyDelta,
  periodStart,
  periodEnd,
}) {
  return (
    `Ajuste por cambio de plan: ${remainingDays} día(s) restante(s) del ciclo `
    + `(${formatCalendarDateEs(periodStart)} – ${formatCalendarDateEs(periodEnd)}) `
    + `a la diferencia de $${formatMoney(dailyDelta)}/día entre ${fromPlanName} `
    + `($${formatMoney(fromAmount)}) y ${toPlanName} ($${formatMoney(toAmount)}).`
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Resolving what the change IS
// ───────────────────────────────────────────────────────────────────────────

/**
 * Validate the requested target against the subscription and the catalog.
 *
 * The catalog supplies the plan's NAME and — when the caller names no amount —
 * its price for this subscription's cycle. An explicit amount is a negotiated
 * per-tenant price and skips the price lookup entirely, exactly as enrollment
 * does (billing.service.js resolvePlanOffer): the catalog must never need an
 * edit to bill one tenant a special number.
 */
async function resolveTarget(sub, input, d) {
  const planCode = String(input.planCode || sub.planCode).trim().toUpperCase();
  const catalog = await getTenantPlanCatalog(d.prisma);
  const plan = resolveTenantPlanConfig(planCode, catalog);
  if (!plan.isActive) {
    throw badRequest(`Plan ${planCode} is not active in the plan catalog, so nothing can be moved onto it.`);
  }

  let amount;
  if (input.amount != null && input.amount !== '') {
    amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw badRequest('The amount must be a positive number.');
    }
    amount = round2(amount);
  } else {
    // No explicit amount → the catalog price for THIS subscription's cycle.
    const priceField = sub.intervalUnit === 'months' && Number(sub.intervalLength) === 12
      ? 'priceAnnual'
      : sub.intervalUnit === 'months' && Number(sub.intervalLength) === 1
        ? 'priceMonthly'
        : null;
    if (!priceField) {
      throw badRequest(
        `This subscription bills every ${sub.intervalLength} ${sub.intervalUnit}, which has no catalog price `
        + 'field. Pass an explicit amount.',
      );
    }
    if (!plan.billable || plan[priceField] == null) {
      throw badRequest(
        `Plan ${planCode} has no ${priceField === 'priceAnnual' ? 'annual' : 'monthly'} price in the catalog. `
        + 'Set one there, or pass an explicit amount for a negotiated per-tenant price.',
      );
    }
    amount = round2(Number(plan[priceField]));
  }

  return { planCode, planName: plan.name || planCode, amount };
}

/**
 * The next period boundary — the day BEFORE the next charge, which is the
 * latest day an ARBUpdateSubscription reliably reaches that charge (future
 * charges only; same-day is not dependable).
 */
export function nextPeriodBoundary(sub) {
  if (sub.currentPeriodEnd && isCalendarDate(sub.currentPeriodEnd)) return sub.currentPeriodEnd;
  if (sub.nextChargeDate && isCalendarDate(sub.nextChargeDate)) return addCalendarDays(sub.nextChargeDate, -1);
  return null;
}

async function loadSchedulable(subscriptionId, d) {
  const sub = await d.prisma.tenantSubscription.findUnique({ where: { id: String(subscriptionId) } });
  if (!sub) throw notFound('Subscription not found');
  if (!SCHEDULABLE.includes(sub.status)) {
    throw badRequest(
      `This subscription is ${sub.status}. A plan change can only be scheduled on a subscription that is `
      + 'still billing (Active, Trialing, or Past due). A pending enrollment is re-priced by revoking the '
      + 'invite and sending a new one; a suspended tenant is restored first.',
    );
  }
  if (!sub.arbSubscriptionId) {
    throw badRequest(
      'This subscription does not exist at Authorize.Net yet, so there is no schedule to change. '
      + 'Revoke the outstanding invite and send a new one at the new price instead.',
    );
  }
  return sub;
}

function actorOf(input) {
  return {
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    actorRole: input.actorRole ?? null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Preview — the exact number and the exact sentence, before committing (§7.2)
// ───────────────────────────────────────────────────────────────────────────

/**
 * What WOULD happen, with nothing written. The panel shows this before the
 * operator commits, so the number that charges is a number somebody has
 * already read — and `expectedProration` on the commit call pins it.
 */
export async function previewPlanChange(input = {}, overrides = {}) {
  const d = deps(overrides);
  const today = todayCalendarDate(d.now());
  const sub = await loadSchedulable(input.subscriptionId, d);
  const target = await resolveTarget(sub, input, d);

  const oldAmount = round2(Number(sub.amount));
  const noChange = target.planCode === sub.planCode && target.amount === oldAmount;
  const boundary = nextPeriodBoundary(sub);
  const upgrade = target.amount > oldAmount;

  let proration = null;
  if (upgrade && sub.status === SUBSCRIPTION_STATUS.ACTIVE
    && sub.currentPeriodStart && sub.currentPeriodEnd && today <= sub.currentPeriodEnd) {
    const p = computeProration({
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      today,
      oldAmount,
      newAmount: target.amount,
    });
    proration = {
      ...p,
      belowFloor: p.proration < PRORATION_FLOOR,
      floor: PRORATION_FLOOR,
      description: buildProrationChargeDescription({
        fromPlanName: sub.planNameSnapshot,
        toPlanName: target.planName,
        fromAmount: oldAmount,
        toAmount: target.amount,
        remainingDays: p.remainingDays,
        dailyDelta: p.dailyDelta,
        periodStart: today,
        periodEnd: sub.currentPeriodEnd,
      }),
    };
  }

  return {
    from: { planCode: sub.planCode, planName: sub.planNameSnapshot, amount: String(oldAmount) },
    to: { planCode: target.planCode, planName: target.planName, amount: String(target.amount) },
    noChange,
    upgrade,
    effectiveDate: boundary,
    firstChargedOn: sub.nextChargeDate,
    // Mid-cycle proration is OFFERED only where it is possible; the default
    // remains the scheduled, no-money-moves change either way.
    prorationAvailable: proration != null,
    proration,
    hasPendingChange: !!(sub.pendingPlanCode || sub.pendingEffectiveDate),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Schedule — the default: no money moves today (§6.3 generalised)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Write the pending fields. NOTHING is said to Authorize.Net here — the daily
 * sweep applies the change at the boundary, and until then the change is
 * fully undoable with cancelPendingPlanChange. That undoability is the reason
 * scheduling is the default shape and needs no typed confirmation the way
 * cancel does: until the boundary arrives, nothing has happened.
 */
export async function scheduleSubscriptionPlanChange(input = {}, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();
  const today = todayCalendarDate(now);

  const sub = await loadSchedulable(input.subscriptionId, d);
  if (sub.pendingPlanCode || sub.pendingEffectiveDate) {
    throw badRequest(
      'A change is already scheduled for this subscription. Cancel it first — two scheduled changes '
      + 'would race over which one the boundary applies.',
    );
  }

  const target = await resolveTarget(sub, input, d);
  const oldAmount = round2(Number(sub.amount));
  if (target.planCode === sub.planCode && target.amount === oldAmount) {
    throw badRequest(
      `This subscription is already ${sub.planCode} at $${formatMoney(oldAmount)}. Nothing would change.`,
    );
  }

  let effectiveDate;
  if (input.effectiveDate != null && input.effectiveDate !== '') {
    effectiveDate = assertCalendarDate(input.effectiveDate, 'effectiveDate');
    if (effectiveDate < today) {
      throw badRequest('The effective date cannot be in the past.');
    }
  } else {
    effectiveDate = nextPeriodBoundary(sub);
    if (!effectiveDate) {
      throw badRequest(
        'This subscription has no upcoming charge to schedule against. There is no boundary for the '
        + 'change to land on.',
      );
    }
  }

  const updated = await d.prisma.tenantSubscription.update({
    where: { id: sub.id },
    data: {
      pendingPlanCode: target.planCode,
      pendingAmount: target.amount,
      pendingEffectiveDate: effectiveDate,
    },
  });

  await d.recordAudit({
    tenantId: sub.tenantId,
    ...actorOf(input),
    action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CHANGE_SCHEDULE,
    targetType: 'TenantSubscription',
    targetId: sub.id,
    metadata: {
      fromPlanCode: sub.planCode,
      toPlanCode: target.planCode,
      fromAmount: String(oldAmount),
      toAmount: String(target.amount),
      effectiveDate,
      arbSubscriptionId: sub.arbSubscriptionId,
      // The scheduled shape moves no money by definition.
      proration: 'NONE_SCHEDULED_AT_BOUNDARY',
    },
  });

  return {
    subscriptionId: sub.id,
    pendingPlanCode: updated.pendingPlanCode,
    pendingAmount: String(updated.pendingAmount),
    pendingEffectiveDate: updated.pendingEffectiveDate,
    // The date the customer's card actually feels it: the charge AFTER the
    // boundary. Surfaced so the panel says "new price from the charge on X",
    // never the ambiguous "changes on X".
    firstChargedOn: sub.nextChargeDate,
  };
}

/**
 * Undo a scheduled change before it applies. The whole point of the pending
 * fields being data rather than an ARB call is that this is a plain clear.
 */
export async function cancelPendingPlanChange(input = {}, overrides = {}) {
  const d = deps(overrides);

  const sub = await d.prisma.tenantSubscription.findUnique({
    where: { id: String(input.subscriptionId) },
  });
  if (!sub) throw notFound('Subscription not found');
  if (!sub.pendingPlanCode && !sub.pendingEffectiveDate) {
    throw badRequest('No change is scheduled for this subscription. There is nothing to cancel.');
  }

  await d.prisma.tenantSubscription.update({
    where: { id: sub.id },
    data: { pendingPlanCode: null, pendingAmount: null, pendingEffectiveDate: null },
  });

  await d.recordAudit({
    tenantId: sub.tenantId,
    ...actorOf(input),
    action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CHANGE_CANCEL,
    targetType: 'TenantSubscription',
    targetId: sub.id,
    metadata: {
      cancelledPlanCode: sub.pendingPlanCode,
      cancelledAmount: sub.pendingAmount == null ? null : String(sub.pendingAmount),
      cancelledEffectiveDate: sub.pendingEffectiveDate,
      keptPlanCode: sub.planCode,
      keptAmount: String(sub.amount),
    },
  });

  return { subscriptionId: sub.id, cancelled: true };
}

// ───────────────────────────────────────────────────────────────────────────
// The boundary apply — reconciler pass (§4.5 step 5)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Apply every pending change whose day has arrived. Called from the daily
 * reconcile sweep; safe to run from two workers at once (see the header).
 *
 * ORDER: ARB FIRST. If ARBUpdateSubscription fails, our row is untouched and
 * the pending fields stand — the next sweep retries, and the customer keeps
 * being charged the OLD, agreed price meanwhile. Failing toward under-change
 * mirrors cancel's "fail toward still-billing": every failure leaves us
 * charging a number the customer has already consented to.
 */
export async function applyDuePlanChanges(now, counts = {}, overrides = {}) {
  const d = deps(overrides);
  const today = todayCalendarDate(now);

  const due = await d.prisma.tenantSubscription.findMany({
    where: {
      status: { in: SCHEDULABLE },
      arbSubscriptionId: { not: null },
      // VARCHAR(10) calendar strings compare chronologically by design.
      pendingEffectiveDate: { not: null, lte: today },
    },
    take: BATCH,
  });

  for (const sub of due) {
    try {
      await applyOnePlanChange(sub, now, counts, overrides);
    } catch (err) {
      counts.planChangeErrors = (counts.planChangeErrors || 0) + 1;
      logAuthnetFailure('applyPlanChange', err, { subscriptionId: sub.id, tenantId: sub.tenantId });
    }
  }
  return counts;
}

export async function applyOnePlanChange(sub, now, counts = {}, overrides = {}) {
  const d = deps(overrides);
  const newPlanCode = sub.pendingPlanCode || sub.planCode;
  const newAmount = round2(Number(sub.pendingAmount ?? sub.amount));

  // ── STEP 1: Authorize.Net. Idempotent (same amount twice = same amount),
  // so a second worker racing this exact change does no harm here.
  try {
    await d.updateSubscriptionAmount(sub.arbSubscriptionId, newAmount);
  } catch (err) {
    const timedOut = /timed out after/.test(String(err?.message || ''));
    const failureCode = timedOut ? 'ARB_AMOUNT_UPDATE_TIMEOUT' : 'ARB_AMOUNT_UPDATE_FAILED';
    logAuthnetFailure('ARBUpdateSubscription(amount)', err, {
      subscriptionId: sub.id,
      tenantId: sub.tenantId,
    });
    // Pending fields stand; the next sweep retries. Alert ONCE per stretch of
    // failure, not once per day — the transition test, same as markPastDue.
    const alreadyFailing = sub.lastFailureCode === 'ARB_AMOUNT_UPDATE_FAILED'
      || sub.lastFailureCode === 'ARB_AMOUNT_UPDATE_TIMEOUT';
    await d.prisma.tenantSubscription.update({
      where: { id: sub.id },
      data: { lastFailureCode: failureCode, lastFailureAt: now },
    });
    if (!alreadyFailing) {
      await d.notifyOwner('DRIFT', sub, {
        wasStatus: sub.status,
        arbStatus: 'unreachable',
        becameStatus: sub.status,
        detectedBy: `plan-change apply — ARBUpdateSubscription ${timedOut ? 'timed out' : 'failed'}; `
          + 'the scheduled change is still pending and will be retried daily. The customer keeps being '
          + 'charged the old, agreed price until it lands.',
      });
    }
    counts.planChangeErrors = (counts.planChangeErrors || 0) + 1;
    return 'arb-failed';
  }

  // ── STEP 2: the atomic claim. The WHERE re-asserts the exact pending values
  // this worker read, so of two racing workers exactly one claims — and a
  // change cancelled or re-scheduled mid-flight is NOT applied over.
  const catalog = await getTenantPlanCatalog(d.prisma);
  const planName = newPlanCode === sub.planCode
    ? sub.planNameSnapshot
    : (resolveTenantPlanConfig(newPlanCode, catalog).name || newPlanCode);

  const claim = await d.prisma.tenantSubscription.updateMany({
    where: {
      id: sub.id,
      pendingPlanCode: sub.pendingPlanCode,
      pendingEffectiveDate: sub.pendingEffectiveDate,
    },
    data: {
      planCode: newPlanCode,
      planNameSnapshot: planName,
      amount: newAmount,
      pendingPlanCode: null,
      pendingAmount: null,
      pendingEffectiveDate: null,
      lastReconciledAt: now,
    },
  });
  if (!claim || claim.count === 0) {
    // Another worker applied it, or the operator cancelled/re-scheduled while
    // the ARB call was in flight. Either way this worker records nothing.
    return 'lost-claim';
  }

  counts.planChangesApplied = (counts.planChangesApplied || 0) + 1;

  // Deterministic on the EFFECTIVE DATE, not today: an apply that slips a day
  // past its boundary still cannot double-record.
  await writePlanChangeEvent(sub, now, {
    fromPlanCode: sub.planCode,
    toPlanCode: newPlanCode,
    fromAmount: String(sub.amount),
    toAmount: String(newAmount),
    effectiveDate: sub.pendingEffectiveDate,
  }, d);

  // No actor: this runs unattended. The actor is on the SCHEDULE row.
  await d.recordAudit({
    tenantId: sub.tenantId,
    action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CHANGE_APPLY,
    targetType: 'TenantSubscription',
    targetId: sub.id,
    metadata: {
      fromPlanCode: sub.planCode,
      toPlanCode: newPlanCode,
      fromAmount: String(sub.amount),
      toAmount: String(newAmount),
      effectiveDate: sub.pendingEffectiveDate,
      arbSubscriptionId: sub.arbSubscriptionId,
      source: 'RECONCILE',
    },
  });

  d.logger.info('[billing-plan-change] scheduled change applied', {
    subscriptionId: sub.id,
    tenantId: sub.tenantId,
    toPlanCode: newPlanCode,
    effectiveDate: sub.pendingEffectiveDate,
  });
  return 'applied';
}

async function writePlanChangeEvent(sub, now, detail, d) {
  try {
    await d.prisma.tenantSubscriptionEvent.create({
      data: {
        notificationId: `reconcile:${BILLING_EVENT.RECONCILE_PLAN_CHANGE_APPLIED}:${sub.id}:${detail.effectiveDate}`,
        eventType: BILLING_EVENT.RECONCILE_PLAN_CHANGE_APPLIED,
        eventDate: now,
        arbSubscriptionId: sub.arbSubscriptionId ?? null,
        subscriptionId: sub.id,
        payload: { synthetic: true, ...detail },
        signatureOk: true,
        receivedAt: now,
        processedAt: now,
        attempts: 1,
      },
    });
  } catch (err) {
    if (err?.code === 'P2002') return; // already recorded
    d.logger.warn('[billing-plan-change] could not write synthetic event', {
      subscriptionId: sub.id,
      message: err?.message || String(err),
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Mid-cycle upgrade with proration — OPT-IN (§6.2, §6.5)
// ───────────────────────────────────────────────────────────────────────────

/** 20-char cap at Authorize.Net; `pr-` + 16 hex = 19. Unique per ATTEMPT. */
function mintRefId() {
  return `pr-${randomBytes(8).toString('hex')}`;
}

/**
 * Charge the difference today and change the plan now. Upgrades only.
 *
 * `expectedProration` is REQUIRED and must equal the freshly recomputed
 * number: the operator commits the number the preview showed them, and a
 * preview gone stale overnight (the period rolled, the price changed) refuses
 * rather than charging an amount nobody read.
 *
 * WRITE-BEFORE-CALL (§6.2 step 2) is the safety property: the PENDING charge
 * row with our refId exists before Authorize.Net is spoken to, so a process
 * death mid-call leaves a findable row instead of a mystery on a statement.
 */
export async function changePlanWithProrationNow(input = {}, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();
  const today = todayCalendarDate(now);

  if (input.prorateNow !== true) {
    throw badRequest('Mid-cycle proration is opt-in: pass prorateNow: true, or schedule the change instead.');
  }

  const sub = await loadSchedulable(input.subscriptionId, d);
  if (sub.status !== SUBSCRIPTION_STATUS.ACTIVE) {
    throw badRequest(
      `This subscription is ${sub.status}. A mid-cycle proration charge is only offered on an ACTIVE `
      + 'subscription — money must not move against a delinquent or not-yet-charged one. Schedule the '
      + 'change for the boundary instead.',
    );
  }
  if (sub.pendingPlanCode || sub.pendingEffectiveDate) {
    throw badRequest('A change is already scheduled for this subscription. Cancel it first.');
  }
  if (!sub.currentPeriodStart || !sub.currentPeriodEnd || today > sub.currentPeriodEnd) {
    throw badRequest(
      'This subscription has no current period on record to prorate against. Schedule the change for the '
      + 'next boundary instead.',
    );
  }
  if (!sub.customerProfileId || !sub.customerPaymentProfileId) {
    throw badRequest('No stored payment profile to charge. Schedule the change instead.');
  }

  const target = await resolveTarget(sub, input, d);
  const oldAmount = round2(Number(sub.amount));
  if (target.amount <= oldAmount) {
    throw badRequest(
      'Proration only applies to an upgrade. A downgrade lands at the period boundary with no money '
      + 'movement — schedule it.',
    );
  }

  const p = computeProration({
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    today,
    oldAmount,
    newAmount: target.amount,
  });

  // The number the operator READ is the only number that may charge.
  const expected = round2(Number(input.expectedProration));
  if (!Number.isFinite(expected) || expected !== p.proration) {
    throw badRequest(
      `The proration is now $${formatMoney(p.proration)}, not the $${formatMoney(input.expectedProration ?? 0)} `
      + 'previewed. Nothing was charged — re-open the preview and commit the current number.',
    );
  }

  const actor = actorOf(input);

  // ── Below the floor: no charge at all, plan changes now (§6.2 step 1).
  if (p.proration < PRORATION_FLOOR) {
    return applyImmediatePlanChange(sub, target, { ...d, input }, {
      prorationSkipped: true,
      prorationAmount: String(p.proration),
      floor: String(PRORATION_FLOOR),
    });
  }

  const description = buildProrationChargeDescription({
    fromPlanName: sub.planNameSnapshot,
    toPlanName: target.planName,
    fromAmount: oldAmount,
    toAmount: target.amount,
    remainingDays: p.remainingDays,
    dailyDelta: p.dailyDelta,
    periodStart: today,
    periodEnd: sub.currentPeriodEnd,
  });

  // ── STEP 2 (§6.2): the ledger row EXISTS before the call is made.
  const refId = mintRefId();
  const charge = await d.prisma.tenantSubscriptionCharge.create({
    data: {
      subscriptionId: sub.id,
      tenantId: sub.tenantId,
      kind: CHARGE_KIND.PRORATION,
      status: CHARGE_STATUS.PENDING,
      amount: p.proration,
      currency: sub.currency,
      refId,
      arbSubscriptionId: sub.arbSubscriptionId,
      cardBrand: sub.cardBrand,
      cardLast4: sub.cardLast4,
      chargeDate: today,
      description,
      periodStart: today,
      periodEnd: sub.currentPeriodEnd,
      prorationDays: p.remainingDays,
      prorationDailyDelta: p.dailyDelta,
      fromPlanCode: sub.planCode,
      toPlanCode: target.planCode,
      fromAmount: oldAmount,
      toAmount: target.amount,
      source: CHARGE_SOURCE.ADMIN,
      actorUserId: input.actorUserId ?? null,
    },
  });

  // ── STEP 3: the charge itself. No customer re-entry; the stored profile.
  let verdict;
  try {
    verdict = await d.chargeCustomerProfile({
      customerProfileId: sub.customerProfileId,
      customerPaymentProfileId: sub.customerPaymentProfileId,
      amount: p.proration,
      refId,
      description: `Ride Fleet Manager — ajuste de plan ${sub.planCode} → ${target.planCode}`,
      invoiceNumber: refId,
    });
  } catch (err) {
    // UNKNOWN STATE — the §6.5 dangerous case. We do not know whether money
    // moved. NO AUTOMATIC RETRY, EVER: retrying an unknown-state card charge
    // is how somebody gets charged twice. The row keeps our refId so a human
    // resolves it against the Authorize.Net portal, and the plan does not
    // change.
    logAuthnetFailure('chargeCustomerProfile(proration)', err, {
      subscriptionId: sub.id,
      tenantId: sub.tenantId,
    });
    await d.prisma.tenantSubscriptionCharge.update({
      where: { id: charge.id },
      data: { status: CHARGE_STATUS.ERROR },
    });
    await d.recordAudit({
      tenantId: sub.tenantId,
      ...actor,
      action: AUDIT_ACTIONS.SUBSCRIPTION_PRORATION_CHARGE,
      targetType: 'TenantSubscriptionCharge',
      targetId: charge.id,
      outcome: AUDIT_OUTCOME.FAILURE,
      metadata: {
        subscriptionId: sub.id,
        amount: String(p.proration),
        refId,
        failure: 'UNKNOWN_STATE',
        planChangeApplied: false,
      },
    });
    await d.notifyOwner('NO_CHARGE_OBSERVED', sub, {
      detectedBy: `proration charge for ${sub.planCode} → ${target.planCode}: the call failed or timed out `
        + `in an UNKNOWN state. refId ${refId}. It will NOT be retried automatically — check the `
        + 'Authorize.Net portal for a transaction with that reference before doing anything.',
    });
    throw badRequest(
      'Authorize.Net did not answer, so it is unknown whether the card was charged. The plan was NOT '
      + `changed and the attempt will NOT be retried automatically. Look up reference ${refId} in the `
      + 'Authorize.Net portal; the charge row here stays visible until a human resolves it.',
    );
  }

  if (!verdict.approved) {
    // A DECLINE IS AN ANSWER (§6.5): the plan change does not happen, and that
    // is the whole compensating behaviour. A retry mints a NEW attempt row
    // with a NEW refId — this one is spent.
    await d.prisma.tenantSubscriptionCharge.update({
      where: { id: charge.id },
      data: {
        status: verdict.declined ? CHARGE_STATUS.DECLINED : CHARGE_STATUS.ERROR,
        transId: verdict.transId,
        responseCode: verdict.responseCode,
      },
    });
    await d.recordAudit({
      tenantId: sub.tenantId,
      ...actor,
      action: AUDIT_ACTIONS.SUBSCRIPTION_PRORATION_CHARGE,
      targetType: 'TenantSubscriptionCharge',
      targetId: charge.id,
      outcome: AUDIT_OUTCOME.FAILURE,
      metadata: {
        subscriptionId: sub.id,
        amount: String(p.proration),
        refId,
        failure: verdict.declined ? 'DECLINED' : (verdict.held ? 'HELD' : 'ERROR'),
        responseCode: verdict.responseCode,
        planChangeApplied: false,
      },
    });
    throw badRequest(
      verdict.declined
        ? 'The card declined the proration charge, so the plan was not changed. The subscription stays '
          + 'exactly as it was. Fix the card (send a new-card link) or schedule the change for the boundary '
          + 'with no charge.'
        : 'Authorize.Net did not approve the charge, so the plan was not changed. Nothing was applied.',
    );
  }

  // ── Money is in hand. Settle the ledger row…
  await d.prisma.tenantSubscriptionCharge.update({
    where: { id: charge.id },
    data: {
      status: CHARGE_STATUS.SETTLED,
      transId: verdict.transId,
      authCode: verdict.authCode,
      responseCode: verdict.responseCode,
      settledAt: now,
    },
  });

  await d.recordAudit({
    tenantId: sub.tenantId,
    ...actor,
    action: AUDIT_ACTIONS.SUBSCRIPTION_PRORATION_CHARGE,
    targetType: 'TenantSubscriptionCharge',
    targetId: charge.id,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: {
      subscriptionId: sub.id,
      amount: String(p.proration),
      refId,
      transId: verdict.transId,
      fromPlanCode: sub.planCode,
      toPlanCode: target.planCode,
    },
  });

  // ── …then the plan itself: ARB amount + our row.
  return applyImmediatePlanChange(sub, target, { ...d, input }, {
    prorationSkipped: false,
    prorationAmount: String(p.proration),
    prorationChargeId: charge.id,
    transId: verdict.transId,
  });
}

/**
 * Apply the new plan NOW: ARB amount first, then our row. Shared by the
 * below-floor path (no charge) and the settled-proration path.
 *
 * THE REVERSE AMBIGUITY (§6.5): if money settled and THIS ARB update then
 * fails, we have taken money for a plan ARB is not yet charging. The design's
 * refund-after-24h is replaced by something with no money movement at all:
 * our row adopts the new plan immediately (it is the plan the customer just
 * paid for), and the pending fields are set to TODAY so the daily sweep
 * retries the idempotent ARB update until it lands. The customer's NEXT
 * charge is at most one reconcile-cycle late in re-pricing, always in the
 * customer's favour (old, lower amount), and no refund path — with its own
 * ambiguous-money failure modes — ever runs.
 */
async function applyImmediatePlanChange(sub, target, d, auditExtra = {}) {
  const now = d.now();
  const input = d.input || {};
  let arbUpdated = true;

  try {
    await d.updateSubscriptionAmount(sub.arbSubscriptionId, target.amount);
  } catch (err) {
    arbUpdated = false;
    logAuthnetFailure('ARBUpdateSubscription(amount)', err, {
      subscriptionId: sub.id,
      tenantId: sub.tenantId,
    });
  }

  await d.prisma.tenantSubscription.update({
    where: { id: sub.id },
    data: {
      planCode: target.planCode,
      planNameSnapshot: target.planName,
      amount: target.amount,
      ...(arbUpdated
        ? { pendingPlanCode: null, pendingAmount: null, pendingEffectiveDate: null }
        : {
          // The retry vehicle: the daily sweep re-runs the idempotent ARB
          // update until it lands, then clears these.
          pendingPlanCode: target.planCode,
          pendingAmount: target.amount,
          pendingEffectiveDate: todayCalendarDate(now),
        }),
    },
  });

  await d.recordAudit({
    tenantId: sub.tenantId,
    ...actorOf(input),
    action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CHANGE_APPLY,
    targetType: 'TenantSubscription',
    targetId: sub.id,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: {
      fromPlanCode: sub.planCode,
      toPlanCode: target.planCode,
      fromAmount: String(sub.amount),
      toAmount: String(target.amount),
      effectiveDate: todayCalendarDate(now),
      arbSubscriptionId: sub.arbSubscriptionId,
      source: 'ADMIN',
      arbAmountUpdatePending: !arbUpdated,
      ...auditExtra,
    },
  });

  if (!arbUpdated) {
    await d.notifyOwner('DRIFT', sub, {
      wasStatus: sub.status,
      arbStatus: 'unreachable',
      becameStatus: sub.status,
      detectedBy: `plan change ${sub.planCode} → ${target.planCode} applied here, but ARBUpdateSubscription `
        + 'failed — ARB still bills the OLD amount. The daily sweep retries the update automatically; '
        + 'until it lands the customer is charged the lower figure.',
    });
  }

  return {
    subscriptionId: sub.id,
    planCode: target.planCode,
    amount: String(target.amount),
    arbAmountUpdatePending: !arbUpdated,
    ...auditExtra,
  };
}

export const billingPlanChange = {
  PRORATION_FLOOR,
  daysBetween,
  computeProration,
  buildProrationChargeDescription,
  nextPeriodBoundary,
  previewPlanChange,
  scheduleSubscriptionPlanChange,
  cancelPendingPlanChange,
  applyDuePlanChanges,
  applyOnePlanChange,
  changePlanWithProrationNow,
};
