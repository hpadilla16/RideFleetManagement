/**
 * Reconciliation — the net under a webhook that never arrives.
 *
 * Everything in this file must work with ZERO webhooks ever having been
 * delivered. That is not a stretch goal; it is the design constraint, because
 * the failure that actually kills a billing system is the one that makes every
 * other detector look healthy while nothing works: the endpoint silently
 * unreachable, the webhook subscription switched off in the portal, the
 * Signature Key rotated so that every genuine delivery is rejected with a 401
 * and stored nowhere. In all three of those, the webhook path reports perfect
 * health — it reports nothing, and nothing is what it is supposed to report
 * when nothing is wrong.
 *
 * FOUR PASSES, IN THIS ORDER AND FOR THIS REASON:
 *
 *   1. UNPROCESSED EVENTS. Cheapest, and it can resolve drift before we go
 *      looking for it. An event that failed to apply yesterday is information
 *      we already paid for.
 *   2. STATUS DRIFT (detector 2). One cheap ARB call per live subscription.
 *   3. MISSING CHARGES (detector 3). One expensive ARB call, only for
 *      subscriptions that actually look wrong.
 *   4. HEARTBEAT. Free, and it is the only thing in the system that notices
 *      the pipe itself is dead.
 *
 * THE ASYMMETRY RULE, AND IT IS THE MOST IMPORTANT DECISION IN THIS FILE
 * ---------------------------------------------------------------------------
 * The design says "on any divergence from our stored status, adopt ARB's". That
 * is right for divergences that make things WORSE and wrong for divergences
 * that make things BETTER, so it is split here:
 *
 *   ESCALATION  (ARB says suspended/canceled/terminated/expired and we thought
 *               the subscription was fine) → ADOPT IMMEDIATELY. ARB is the
 *               source of truth about whether money moves, and every hour we
 *               spend disagreeing is an hour of service given away.
 *
 *   DE-ESCALATION (ARB says active and we had it PAST_DUE or SUSPENDED)
 *               → RECORD AND ALERT, DO NOT ADOPT. A status is not a payment.
 *               Clearing a delinquency requires EVIDENCE THAT MONEY MOVED —
 *               a settled charge row — and pass 3 is what finds that evidence.
 *               Auto-clearing here would wipe `pastDueSince` on the strength of
 *               a word, restore a non-payer's access, and destroy the only
 *               record of how long they had been late.
 *
 * The same asymmetry is why `TRIALING` is never "corrected" to `ACTIVE` by an
 * ARB status of `active`: a deferred-start subscription IS active at ARB from
 * the moment it is created, and TRIALING is our own refinement of that state
 * which ARB has no word for. Treating them as a divergence would raise a drift
 * alert for every trialing customer on day one — and an alert that fires on
 * healthy rows is an alert people learn to close without reading.
 *
 * NOTHING IN THIS FILE CHARGES ANYBODY. It reads from Authorize.Net and writes
 * to our tables. The compensating actions that move money (refund, retry,
 * proration) are later phases.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { withTimeout } from '../../lib/with-timeout.js';
import { recordAudit, AUDIT_ACTIONS } from '../audit/audit.service.js';
import {
  getSubscriptionStatus as arbGetSubscriptionStatus,
  getSubscription as arbGetSubscription,
  logAuthnetFailure,
} from './authorize-net.js';
import {
  SUBSCRIPTION_STATUS,
  CHARGE_KIND,
  CHARGE_STATUS,
  CHARGE_SOURCE,
  buildScheduledChargeDescription,
} from './billing.service.js';
import {
  BILLING_EVENT,
  ARB_STATUS_TO_SUBSCRIPTION,
  RESPONSE_CODE,
  rollPeriod,
} from './billing-events.js';
import { processStoredEvent } from './billing-webhooks.service.js';
import { notifyOwner } from './billing-notify.js';
import { todayCalendarDate, addCalendarDays } from './billing-dates.js';

/** Statuses worth polling. PENDING_AUTHORIZATION has no ARB subscription yet. */
const POLLABLE = [
  SUBSCRIPTION_STATUS.TRIALING,
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PAST_DUE,
  SUBSCRIPTION_STATUS.SUSPENDED,
];

/**
 * How long after `nextChargeDate` a missing charge becomes suspicious.
 *
 * Two days, per design §2.3. ARB settles overnight and a webhook can be a few
 * hours late, so a shorter window would cry wolf on every ordinary billing day.
 */
const SILENCE_GRACE_DAYS = Number(process.env.BILLING_SILENCE_GRACE_DAYS || 2);

/** Give up retrying an event after this many attempts and ask a human. */
const MAX_EVENT_ATTEMPTS = 10;

/** No verified webhook platform-wide in this long means the pipe is dead. */
const HEARTBEAT_WINDOW_MS = Number(process.env.BILLING_HEARTBEAT_HOURS || 72) * 60 * 60 * 1000;

const ARB_CALL_TIMEOUT_MS = 20 * 1000;
const SUBSCRIPTION_TIMEOUT_MS = 45 * 1000;

/** Bounded per pass; the daily cadence drains any backlog. */
const BATCH = 200;

function deps(overrides = {}) {
  return {
    prisma: overrides.prisma || prisma,
    logger: overrides.logger || logger,
    now: overrides.now || (() => new Date()),
    recordAudit: overrides.recordAudit || recordAudit,
    notifyOwner: overrides.notifyOwner || notifyOwner,
    getSubscriptionStatus: overrides.getSubscriptionStatus || arbGetSubscriptionStatus,
    getSubscription: overrides.getSubscription || arbGetSubscription,
    processStoredEvent: overrides.processStoredEvent || processStoredEvent,
    ...overrides,
  };
}

/**
 * Run one full reconciliation. Exported so the scheduler, a test and (later) a
 * "Forzar reconciliación" button all drive the identical code path.
 */
export async function runBillingReconcile(overrides = {}) {
  const d = deps(overrides);
  const now = d.now();
  const counts = {
    eventsRetried: 0,
    eventsExhausted: 0,
    polled: 0,
    driftEscalated: 0,
    driftRefused: 0,
    silenceChecked: 0,
    chargesMaterialised: 0,
    declinesFound: 0,
    noChargeObserved: 0,
    pollErrors: 0,
    heartbeatAlert: 0,
  };

  await sweepUnprocessedEvents(now, counts, overrides);
  await sweepStatusDrift(now, counts, overrides);
  await sweepMissingCharges(now, counts, overrides);
  await checkWebhookHeartbeat(now, counts, overrides);

  d.logger.info('[billing-reconcile] sweep done', counts);
  return counts;
}

// ───────────────────────────────────────────────────────────────────────────
// Pass 1 — events that were stored but never applied
// ───────────────────────────────────────────────────────────────────────────

/**
 * The reason the webhook endpoint can safely answer 200 to an event it failed
 * to process. Authorize.Net's retries are finite; this one is not.
 */
async function sweepUnprocessedEvents(now, counts, overrides) {
  const d = deps(overrides);
  const pending = await d.prisma.tenantSubscriptionEvent.findMany({
    where: { processedAt: null, attempts: { lt: MAX_EVENT_ATTEMPTS } },
    orderBy: { receivedAt: 'asc' },
    take: BATCH,
  });

  for (const row of pending) {
    try {
      await d.processStoredEvent(row, { now }, overrides);
      counts.eventsRetried += 1;
    } catch (err) {
      // processStoredEvent already stamps its own failure; this catch exists so
      // one poisoned row cannot end the pass for every other row behind it.
      counts.pollErrors += 1;
      d.logger.warn('[billing-reconcile] event retry failed', {
        notificationId: row.notificationId,
        message: err?.message || String(err),
      });
    }
  }

  const exhausted = await d.prisma.tenantSubscriptionEvent.count({
    where: { processedAt: null, attempts: { gte: MAX_EVENT_ATTEMPTS } },
  });
  if (exhausted > 0) {
    counts.eventsExhausted = exhausted;
    // Ten failures is not a transient fault. Something about these events is
    // structurally wrong and only a person can decide what.
    d.logger.error('[billing-reconcile] BILLING_EVENTS_STUCK', {
      message: `${exhausted} billing webhook event(s) have failed ${MAX_EVENT_ATTEMPTS} times and are no longer being retried.`,
      count: exhausted,
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pass 2 — DETECTOR 2: what does Authorize.Net actually think?
// ───────────────────────────────────────────────────────────────────────────

async function sweepStatusDrift(now, counts, overrides) {
  const d = deps(overrides);

  const live = await d.prisma.tenantSubscription.findMany({
    where: { status: { in: POLLABLE }, arbSubscriptionId: { not: null } },
    take: BATCH,
  });

  // THE WORST POSSIBLE BUG, CHECKED EXPLICITLY: a row we believe is CANCELLED
  // whose subscription is still live at Authorize.Net — cancelled in our
  // database and still charging the customer every month. Nothing else in the
  // system would ever look at these rows again, which is exactly why they are
  // pulled back in here. Bounded to recent cancellations so the cost does not
  // grow forever; an old one that was going to keep charging would have been
  // caught within days.
  const recentlyStopped = await d.prisma.tenantSubscription.findMany({
    where: {
      status: { in: [SUBSCRIPTION_STATUS.CANCELLED, SUBSCRIPTION_STATUS.EXPIRED] },
      arbSubscriptionId: { not: null },
      cancelledAt: { gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) },
    },
    take: BATCH,
  });

  for (const sub of [...live, ...recentlyStopped]) {
    try {
      const arbStatus = await withTimeout(
        d.getSubscriptionStatus(sub.arbSubscriptionId),
        ARB_CALL_TIMEOUT_MS,
        `ARBGetSubscriptionStatus ${sub.id}`,
      );
      counts.polled += 1;
      await applyDrift(sub, arbStatus, now, counts, overrides);
    } catch (err) {
      counts.pollErrors += 1;
      // Codes and ids only. Authorize.Net echoes offending values into message
      // text and this runs unattended against every live subscription.
      logAuthnetFailure('ARBGetSubscriptionStatus', err, {
        subscriptionId: sub.id,
        tenantId: sub.tenantId,
      });
    }
  }
}

/**
 * Compare one subscription against ARB's answer and act — or deliberately
 * refuse to. See the asymmetry rule in the file header.
 */
export async function applyDrift(sub, arbStatus, now, counts = {}, overrides = {}) {
  const d = deps(overrides);
  if (!arbStatus) {
    // ARB answered without a status. A shape change we must SEE, not smooth
    // over: silently treating "no answer" as "fine" is how a detector stops
    // detecting without anyone noticing.
    d.logger.error('[billing-reconcile] ARB returned no status', {
      subscriptionId: sub.id,
      tenantId: sub.tenantId,
    });
    return 'no-status';
  }

  const mapped = ARB_STATUS_TO_SUBSCRIPTION[arbStatus] || null;
  await d.prisma.tenantSubscription.update({
    where: { id: sub.id },
    data: { arbStatusSnapshot: arbStatus, lastReconciledAt: now },
  });

  if (!mapped) {
    d.logger.error('[billing-reconcile] UNMAPPED ARB status', {
      subscriptionId: sub.id,
      arbStatus,
      message: 'Authorize.Net reported a subscription status this build does not know.',
    });
    return 'unmapped';
  }

  if (mapped === sub.status) return 'agree';

  // TRIALING is our refinement of "active at ARB", not a disagreement with it.
  if (arbStatus === 'active' && sub.status === SUBSCRIPTION_STATUS.TRIALING) return 'agree';

  const worse = isEscalation(sub.status, mapped);

  if (!worse) {
    // DE-ESCALATION — recorded, alerted, NOT adopted. A status is not a payment.
    counts.driftRefused = (counts.driftRefused || 0) + 1;
    d.logger.warn('[billing-reconcile] drift NOT adopted (de-escalation needs a settled charge)', {
      subscriptionId: sub.id,
      tenantId: sub.tenantId,
      ours: sub.status,
      arbStatus,
      message: 'Authorize.Net reports this subscription is healthier than our record. '
        + 'Clearing a delinquency requires evidence that money moved; pass 3 looks for it.',
    });
    await writeSyntheticEvent(BILLING_EVENT.RECONCILE_STATUS_DRIFT, sub, now, {
      ours: sub.status, arbStatus, adopted: false,
    }, overrides);
    return 'refused';
  }

  // ESCALATION — adopt ARB, loudly.
  counts.driftEscalated = (counts.driftEscalated || 0) + 1;
  const patch = {
    status: mapped,
    lastReconciledAt: now,
    arbStatusSnapshot: arbStatus,
  };
  if (mapped === SUBSCRIPTION_STATUS.PAST_DUE) {
    if (!sub.pastDueSince) patch.pastDueSince = now;
    patch.lastFailureAt = now;
    patch.lastFailureCode = 'ARB_SUSPENDED';
  }
  if (mapped === SUBSCRIPTION_STATUS.CANCELLED || mapped === SUBSCRIPTION_STATUS.EXPIRED) {
    patch.cancelledAt = sub.cancelledAt || now;
    patch.cancelReason = sub.cancelReason || `ARB_${String(arbStatus).toUpperCase()}`;
    // No next charge is coming. Leaving a stale date would keep feeding
    // detector 3 a charge to hunt for that can never happen.
    patch.nextChargeDate = null;
  }

  const updated = await d.prisma.tenantSubscription.update({ where: { id: sub.id }, data: patch });

  d.logger.error('[billing-reconcile] STATUS DRIFT — adopted Authorize.Net', {
    subscriptionId: sub.id,
    tenantId: sub.tenantId,
    was: sub.status,
    arbStatus,
    became: mapped,
    message: 'Authorize.Net and our record disagreed about a live subscription. '
      + 'ARB is the source of truth about whether money moves, so its answer was adopted. '
      + 'A divergence almost always means a webhook never arrived.',
  });

  await writeSyntheticEvent(BILLING_EVENT.RECONCILE_STATUS_DRIFT, sub, now, {
    ours: sub.status, arbStatus, adopted: true, became: mapped,
  }, overrides);

  await d.recordAudit({
    tenantId: sub.tenantId,
    action: AUDIT_ACTIONS.SUBSCRIPTION_RECONCILE_DRIFT,
    targetType: 'TenantSubscription',
    targetId: sub.id,
    metadata: {
      from: sub.status,
      to: mapped,
      arbStatus,
      source: 'RECONCILE',
      arbSubscriptionId: sub.arbSubscriptionId,
    },
  });

  await d.notifyOwner('DRIFT', updated, {
    wasStatus: sub.status,
    arbStatus,
    becameStatus: mapped,
    detectedBy: 'reconcile detector 2 (ARB status poll)',
  });

  return 'escalated';
}

/**
 * Is moving from `from` to `to` a step in the WORSE direction?
 *
 * Ranked, not compared pairwise, so a status added later cannot accidentally
 * read as an improvement. CANCELLED and EXPIRED sit at the bottom because from
 * a revenue standpoint there is nowhere lower: the money has stopped.
 */
const SEVERITY = {
  [SUBSCRIPTION_STATUS.ACTIVE]: 0,
  [SUBSCRIPTION_STATUS.TRIALING]: 0,
  [SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION]: 1,
  [SUBSCRIPTION_STATUS.PAST_DUE]: 2,
  [SUBSCRIPTION_STATUS.SUSPENDED]: 3,
  [SUBSCRIPTION_STATUS.EXPIRED]: 4,
  [SUBSCRIPTION_STATUS.CANCELLED]: 4,
  [SUBSCRIPTION_STATUS.SUPERSEDED]: 4,
};

export function isEscalation(from, to) {
  return (SEVERITY[to] ?? 0) > (SEVERITY[from] ?? 0);
}

// ───────────────────────────────────────────────────────────────────────────
// Pass 3 — DETECTOR 3: the silence detector
// ───────────────────────────────────────────────────────────────────────────

/**
 * THE DETECTOR THAT NEEDS NO WEBHOOKS AT ALL.
 *
 * A charge date has come and gone and our ledger has nothing to show for it.
 * That question can be answered entirely from our own tables plus one ARB read,
 * so it survives the webhook endpoint being unreachable for a week — and it is
 * the reason this module does not depend on the INFERRED belief about whether a
 * declined ARB payment produces a payment webhook at all.
 *
 * Three outcomes, and the third is the interesting one:
 *   - ARB shows an APPROVED transaction → we simply missed the webhook.
 *     Materialise the charge, roll the period, clear any delinquency. This is
 *     the path that legitimately un-does a PAST_DUE, because it is the path
 *     that has the money in its hand.
 *   - ARB shows a DECLINE → PAST_DUE with the issuer's reason code.
 *   - ARB shows NOTHING for a date that should have charged → PAST_DUE with
 *     `NO_CHARGE_OBSERVED` and a loud alert. That state means either
 *     Authorize.Net did not charge or our understanding of how it charges is
 *     wrong, and no automation should be trusted to decide which.
 */
async function sweepMissingCharges(now, counts, overrides) {
  const d = deps(overrides);
  const today = todayCalendarDate(now);
  const cutoff = addCalendarDays(today, -SILENCE_GRACE_DAYS);

  const candidates = await d.prisma.tenantSubscription.findMany({
    where: {
      status: { in: [SUBSCRIPTION_STATUS.TRIALING, SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE] },
      arbSubscriptionId: { not: null },
      // Calendar dates are VARCHAR(10) 'YYYY-MM-DD', so a STRING comparison is
      // a chronological one. That is a deliberate property of the format
      // (billing-dates.js), not a coincidence being exploited.
      nextChargeDate: { lt: cutoff },
    },
    take: BATCH,
  });

  for (const sub of candidates) {
    try {
      await withTimeout(
        checkOneSubscriptionForMissingCharge(sub, now, counts, overrides),
        SUBSCRIPTION_TIMEOUT_MS,
        `billing silence detector ${sub.id}`,
      );
      counts.silenceChecked += 1;
    } catch (err) {
      counts.pollErrors += 1;
      logAuthnetFailure('ARBGetSubscription', err, {
        subscriptionId: sub.id,
        tenantId: sub.tenantId,
      });
    }
  }
}

export async function checkOneSubscriptionForMissingCharge(sub, now, counts = {}, overrides = {}) {
  const d = deps(overrides);

  // Do we already have money on file for this period? If so there is nothing
  // silent about it and we spend no ARB call.
  const covering = await d.prisma.tenantSubscriptionCharge.findFirst({
    where: {
      subscriptionId: sub.id,
      status: CHARGE_STATUS.SETTLED,
      chargeDate: { gte: sub.nextChargeDate },
    },
  });
  if (covering) return 'covered';

  const detail = await d.getSubscription(sub.arbSubscriptionId, { includeTransactions: true });
  const relevant = (detail?.transactions || []).filter(
    (t) => t.submitTimeUTC && String(t.submitTimeUTC).slice(0, 10) >= sub.nextChargeDate,
  );

  const approved = relevant.find((t) => t.responseCode === RESPONSE_CODE.APPROVED);
  if (approved) {
    // WE MISSED A WEBHOOK. The money moved; catch the ledger up.
    await materialiseCharge(sub, approved, now, overrides);
    counts.chargesMaterialised = (counts.chargesMaterialised || 0) + 1;

    const period = rollPeriod(sub, now);
    const wasBehind = sub.status === SUBSCRIPTION_STATUS.PAST_DUE
      || sub.status === SUBSCRIPTION_STATUS.SUSPENDED;
    const updated = await d.prisma.tenantSubscription.update({
      where: { id: sub.id },
      data: {
        status: SUBSCRIPTION_STATUS.ACTIVE,
        ...period,
        pastDueSince: null,
        failedAttempts: 0,
        lastFailureCode: null,
        lastFailureText: null,
        lastReconciledAt: now,
        ...(sub.suspendedAt ? { suspendedAt: null } : {}),
      },
    });

    d.logger.warn('[billing-reconcile] MISSING CHARGE RECOVERED — a webhook never arrived', {
      subscriptionId: sub.id,
      tenantId: sub.tenantId,
      transId: approved.transId,
      chargeDate: sub.nextChargeDate,
      message: 'Authorize.Net had already taken this payment. The ledger was behind, not the customer.',
    });
    await writeSyntheticEvent(BILLING_EVENT.RECONCILE_MISSING_CHARGE, sub, now, {
      transId: approved.transId, recovered: true,
    }, overrides);
    if (wasBehind) {
      await d.notifyOwner('RECOVERED', updated, { detectedBy: 'reconcile detector 3 (silence detector)' });
    }
    return 'recovered';
  }

  const declined = relevant.find(
    (t) => t.responseCode === RESPONSE_CODE.DECLINED || t.responseCode === RESPONSE_CODE.ERROR,
  );
  if (declined) {
    counts.declinesFound = (counts.declinesFound || 0) + 1;
    await markPastDue(sub, now, `AUTHNET_${declined.responseReasonCode ?? 'DECLINED'}`,
      'reconcile detector 3 (declined transaction at ARB)', overrides);
    return 'declined';
  }

  // NOTHING AT ALL. Not an approval, not a decline — no transaction for a date
  // that should have billed. This is the one a human has to look at.
  counts.noChargeObserved = (counts.noChargeObserved || 0) + 1;
  const updated = await markPastDue(sub, now, 'NO_CHARGE_OBSERVED',
    'reconcile detector 3 (no transaction observed)', overrides);
  d.logger.error('[billing-reconcile] NO_CHARGE_OBSERVED', {
    subscriptionId: sub.id,
    tenantId: sub.tenantId,
    nextChargeDate: sub.nextChargeDate,
    arbStatus: detail?.status || null,
    message: 'A charge date passed with no transaction of ANY kind at Authorize.Net. '
      + 'Either ARB did not charge, or our model of how it charges is wrong. A person must look.',
  });
  await writeSyntheticEvent(BILLING_EVENT.RECONCILE_NO_CHARGE_OBSERVED, sub, now, {
    nextChargeDate: sub.nextChargeDate, arbStatus: detail?.status || null,
  }, overrides);
  await d.notifyOwner('NO_CHARGE_OBSERVED', updated, {
    graceDays: SILENCE_GRACE_DAYS,
    detectedBy: 'reconcile detector 3 (silence detector)',
  });
  return 'no-charge-observed';
}

/**
 * Write the ledger row for a transaction we learned about from ARB rather than
 * from a webhook. Upserted on transId, which is why the same charge cannot be
 * counted twice even when the missing webhook finally shows up tomorrow.
 */
async function materialiseCharge(sub, tx, now, overrides = {}) {
  const d = deps(overrides);
  if (!tx.transId) return null;
  const period = rollPeriod(sub, now);
  const description = buildScheduledChargeDescription({
    planName: sub.planNameSnapshot,
    amount: sub.amount,
    currency: sub.currency,
    intervalUnit: sub.intervalUnit,
    intervalLength: sub.intervalLength,
    chargeDate: sub.nextChargeDate,
    periodStart: period.currentPeriodStart,
    periodEnd: period.currentPeriodEnd,
  });

  return d.prisma.tenantSubscriptionCharge.upsert({
    where: { transId: tx.transId },
    create: {
      subscriptionId: sub.id,
      tenantId: sub.tenantId,
      kind: sub.status === SUBSCRIPTION_STATUS.TRIALING ? CHARGE_KIND.TRIAL : CHARGE_KIND.RECURRING,
      status: CHARGE_STATUS.SETTLED,
      // The SNAPSHOT amount. ARB's transaction list does not carry one we trust
      // more, and the catalog is editable so it can never be the source here.
      amount: sub.amount,
      currency: sub.currency,
      transId: tx.transId,
      arbSubscriptionId: sub.arbSubscriptionId,
      arbPaymentNum: tx.payNum ?? null,
      responseCode: tx.responseCode == null ? null : String(tx.responseCode),
      cardBrand: sub.cardBrand,
      cardLast4: sub.cardLast4,
      chargeDate: sub.nextChargeDate,
      settledAt: tx.submitTimeUTC ? new Date(tx.submitTimeUTC) : now,
      description,
      periodStart: period.currentPeriodStart,
      periodEnd: period.currentPeriodEnd,
      toPlanCode: sub.planCode,
      toAmount: sub.amount,
      source: CHARGE_SOURCE.RECONCILE,
    },
    update: { status: CHARGE_STATUS.SETTLED, settledAt: tx.submitTimeUTC ? new Date(tx.submitTimeUTC) : now },
  });
}

async function markPastDue(sub, now, failureCode, detectedBy, overrides = {}) {
  const d = deps(overrides);
  const alreadyStronger = sub.status === SUBSCRIPTION_STATUS.SUSPENDED;
  const updated = await d.prisma.tenantSubscription.update({
    where: { id: sub.id },
    data: {
      ...(alreadyStronger ? {} : { status: SUBSCRIPTION_STATUS.PAST_DUE }),
      ...(sub.pastDueSince ? {} : { pastDueSince: now }),
      failedAttempts: { increment: 1 },
      lastFailureAt: now,
      // A CODE. Never Authorize.Net's prose — this runs unattended and the
      // provider echoes offending values into message text.
      lastFailureCode: failureCode,
      lastFailureText: null,
      lastReconciledAt: now,
    },
  });

  // ONCE PER TRANSITION: only a row that actually moved gets a notification and
  // an audit entry. A subscription that is already PAST_DUE and stays PAST_DUE
  // through a second daily sweep must not mail the owner again — otherwise the
  // reconciler would send one alarm per day forever for one unpaid bill, which
  // is how an alert channel becomes noise people mute.
  if (updated.status !== sub.status) {
    await d.recordAudit({
      tenantId: sub.tenantId,
      action: AUDIT_ACTIONS.SUBSCRIPTION_STATE_CHANGE,
      targetType: 'TenantSubscription',
      targetId: sub.id,
      metadata: {
        from: sub.status,
        to: updated.status,
        source: 'RECONCILE',
        failureCode,
        arbSubscriptionId: sub.arbSubscriptionId,
      },
    });
    await d.notifyOwner('PAST_DUE', updated, { detectedBy });
  }
  return updated;
}

// ───────────────────────────────────────────────────────────────────────────
// Pass 4 — the heartbeat
// ───────────────────────────────────────────────────────────────────────────

/**
 * Has ANY verified webhook arrived, platform-wide, in the heartbeat window?
 *
 * Nothing else in the system detects "the endpoint is silently unreachable",
 * and that is the failure that makes every other detector look healthy while
 * nothing works — the drift poll finds nothing because it runs on stale rows
 * the poll itself is refreshing, the ledger is quiet because no money events
 * arrive, and the panel is green.
 *
 * GATED ON THERE BEING SOMETHING TO HEAR — AND THAT GATE IS NARROWER THAN IT
 * FIRST LOOKS (tightened 2026-08-27, billing Phase 3).
 *
 * Phase 2 armed this on "any live subscription exists". That was right while
 * nothing was enrolled and wrong the moment anything was, because a live
 * subscription does NOT imply expected webhook traffic:
 *
 *   - A DEFERRED START. Ride's first real subscription is authorised on 26 Aug
 *     with a first charge on 1 Sep. It is live at Authorize.Net and correct in
 *     every way, and it will produce exactly one event (subscription.created)
 *     and then nothing for six days. Under the old gate that is a
 *     BILLING_WEBHOOK_SILENCE alarm on 29, 30 and 31 August — three false
 *     alarms before the customer has been charged once.
 *   - LOW VOLUME GENERALLY. One monthly subscription produces traffic around
 *     one day in thirty. A 72-hour silence window would alarm on the other
 *     twenty-seven, every month, forever.
 *
 * An alarm that fires on healthy rows is an alarm people learn to close without
 * reading — the same argument this file already makes about never "correcting"
 * TRIALING to ACTIVE. So the gate is not "is anything enrolled" but "was money
 * supposed to move already": a live subscription whose charge date has come and
 * gone. If a charge date has passed and NOT ONE verified webhook has arrived
 * platform-wide, the pipe really is suspect.
 *
 * What this costs, stated plainly: the heartbeat no longer notices a dead pipe
 * during a genuinely quiet stretch. It could not have noticed it truthfully
 * anyway — with nothing due, silence and death are indistinguishable — and the
 * first passed charge date re-arms it, one day ahead of detector 3.
 */
async function checkWebhookHeartbeat(now, counts, overrides) {
  const d = deps(overrides);
  const today = todayCalendarDate(now);
  const liveSubscriptions = await d.prisma.tenantSubscription.count({
    where: {
      status: { in: POLLABLE },
      arbSubscriptionId: { not: null },
      // Calendar-date STRING comparison is chronological by design
      // (billing-dates.js), the same property pass 3 relies on. A null
      // nextChargeDate — a cancelled or expired row — never arms this.
      nextChargeDate: { lt: today },
    },
  });
  if (liveSubscriptions === 0) return;

  /**
   * ONLY EVENTS THAT ACTUALLY CAME FROM AUTHORIZE.NET COUNT.
   *
   * This ledger holds two kinds of row. Real deliveries carry Authorize.Net's own
   * event names, every one of which begins `net.authorize.` — see BILLING_EVENT.
   * The reconciler's own decisions are written into the SAME table (deliberately:
   * a correction should be visible next to the webhooks it compensated for) under
   * `reconcile.*` names, and those are not deliveries at all.
   *
   * Counting them here made this detector self-blinding in exactly the situation
   * it exists for (found by the deferred-start suite, 2026-08-27): a charge date
   * passes with no webhook, detector 3 raises NO_CHARGE_OBSERVED and writes a
   * synthetic row — and that row is then read back as proof the pipe is alive.
   * The reconciler would have been quietly reassuring itself with its own alarm.
   */
  const since = new Date(now.getTime() - HEARTBEAT_WINDOW_MS);
  const fromAuthorizeNet = { eventType: { startsWith: 'net.authorize.' }, signatureOk: true };
  const verified = await d.prisma.tenantSubscriptionEvent.count({
    where: { ...fromAuthorizeNet, receivedAt: { gte: since } },
  });
  if (verified > 0) return;

  counts.heartbeatAlert = 1;
  const last = await d.prisma.tenantSubscriptionEvent.findFirst({
    where: fromAuthorizeNet,
    orderBy: { receivedAt: 'desc' },
  });

  d.logger.error('[billing-reconcile] BILLING_WEBHOOK_SILENCE', {
    windowHours: HEARTBEAT_WINDOW_MS / 3600000,
    liveSubscriptions,
    lastEventAt: last?.receivedAt?.toISOString() || null,
    message: 'Zero verified billing webhooks platform-wide while a charge date has already passed. '
      + 'Check the Authorize.Net portal subscription, the endpoint DNS, and whether the Signature Key rotated.',
  });
  await d.notifyOwner('WEBHOOK_SILENCE', {}, {
    lastEventAt: last?.receivedAt || null,
    liveSubscriptions,
  });
}

// ───────────────────────────────────────────────────────────────────────────

/**
 * Record a reconciler decision in the SAME ledger as real webhooks.
 *
 * A correction that lives only in a log line is a correction nobody will find
 * when they are looking at the subscription that was corrected. Putting it in
 * TenantSubscriptionEvent means the panel shows "here is what ARB said, here is
 * what we did about it" next to the webhooks it was compensating for.
 *
 * The notificationId is DETERMINISTIC — `reconcile:<kind>:<subId>:<date>` — so
 * the unique index makes a second sweep on the same day a no-op instead of a
 * duplicate row. The reconciler gets the same replay safety as the webhook path
 * and gets it from the same index.
 */
async function writeSyntheticEvent(eventType, sub, now, detail, overrides = {}) {
  const d = deps(overrides);
  const day = todayCalendarDate(now);
  try {
    await d.prisma.tenantSubscriptionEvent.create({
      data: {
        notificationId: `reconcile:${eventType}:${sub.id}:${day}`,
        eventType,
        eventDate: now,
        arbSubscriptionId: sub.arbSubscriptionId ?? null,
        subscriptionId: sub.id,
        payload: { synthetic: true, ...detail },
        signatureOk: true,
        receivedAt: now,
        // Already done by the time it is written — it IS the record of an
        // action, not a request for one.
        processedAt: now,
        attempts: 1,
      },
    });
  } catch (err) {
    if (err?.code === 'P2002') return; // already recorded this sweep
    d.logger.warn('[billing-reconcile] could not write synthetic event', {
      eventType,
      subscriptionId: sub.id,
      message: err?.message || String(err),
    });
  }
}

export const billingReconcile = {
  runBillingReconcile,
  applyDrift,
  checkOneSubscriptionForMissingCharge,
  isEscalation,
  SILENCE_GRACE_DAYS,
};
