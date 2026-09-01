/**
 * Dunning — the only automation in this codebase that switches a paying
 * customer's business off. Tenant Subscriptions Phase 5 (2026-08-28).
 *
 * ── THE TIMELINE, AND WHY IT HAS NO RETRIES IN IT ──────────────────────────
 *
 * With Automatic Retry on, a declined ARB payment SUSPENDS the subscription at
 * Authorize.Net; ARB then retries nightly, but ONLY once the card has been
 * updated, and the subscription stays suspended indefinitely until it is. There
 * is no fixed retry count and no way to schedule attempts
 * (billing-events.js:11-15). So:
 *
 *   Day 0   first decline  → PAST_DUE. A notice appears on the tenant's own
 *                            dashboard telling them to update their payment
 *                            method. ACCESS IS UNAFFECTED.
 *   Days 0–6 grace         → ARB retries continuously, and for free, the moment
 *                            they fix the card. We do nothing but wait.
 *   Day 6   still unpaid   → SUSPEND. Staff logins locked (when enforcement is
 *                            on), with a message to contact Ride.
 *
 * WE DO NOT FIRE OUR OWN RETRIES. A scheduled `chargeCustomerProfile` of ours
 * would collide with ARB's nightly attempt and risk double-charging the same
 * card for the same period. The 6 days is OUR number — the escalation clock is
 * `pastDueSince`, which is ours — and it is configurable.
 *
 * ── OFF BY DEFAULT, AND SEPARATELY FROM THE GATE ───────────────────────────
 *
 * BILLING_DUNNING_ENABLED defaults to FALSE and is its own switch, NOT the same
 * one as TENANT_SUSPENSION_ENFORCEMENT. That separation is deliberate and it
 * matters: setting `Tenant.status='SUSPENDED'` already darkens the tenant's
 * public booking site and stops their integration syncs TODAY, with the gate
 * still off. Auto-suspension is therefore a real production action even in a
 * build where no staff member would be locked out, and it must not ride in on
 * the coat-tails of a variable that reads like "turn the login gate on".
 *
 * The intended rollout is consequently three separate, reversible steps:
 *   1. deploy (everything off)                     — nothing changes
 *   2. TENANT_SUSPENSION_ENFORCEMENT=log           — learn the allowlist
 *   3. TENANT_SUSPENSION_ENFORCEMENT=enforce       — the gate bites, manually
 *   4. BILLING_DUNNING_ENABLED=true                — and only now, automatically
 *
 * ── ORDERING INSIDE THE RECONCILER IS LOAD-BEARING ─────────────────────────
 *
 * This pass runs LAST, after the missing-charge detector. Pass 3 is the one
 * that finds a settled payment we never got a webhook for and clears the
 * delinquency. Running dunning before it would suspend a tenant who had already
 * paid, on the strength of a ledger we were about to correct in the same sweep.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { SUBSCRIPTION_STATUS } from './billing.service.js';
import { suspendTenantAccess } from './billing-admin.service.js';
import { notifyOwner } from './billing-notify.js';
import { emitNotificationSafe } from '../notifications/notifications-emit.js';

/**
 * How many days a tenant may stay PAST_DUE before access is cut.
 *
 * Six, per the owner: "3 × 2 days". Configurable because it is a commercial
 * policy, not a technical constant, and the first time it is wrong we should be
 * able to change it without a deploy.
 *
 * READ AT CALL TIME, and clamped to a MINIMUM OF 1. A misconfigured `0` would
 * mean "suspend the instant a payment declines", which deletes the entire grace
 * window the owner asked for — the one part of this timeline that exists to
 * protect the customer.
 */
export function dunningGraceDays(env = process.env) {
  const raw = Number(env.BILLING_DUNNING_GRACE_DAYS);
  if (!Number.isFinite(raw) || raw < 1) return 6;
  return Math.floor(raw);
}

/** Off by default. See the header for why this is not the gate's switch. */
export function isDunningEnabled(env = process.env) {
  return String(env.BILLING_DUNNING_ENABLED || '').trim().toLowerCase() === 'true';
}

function deps(overrides = {}) {
  return {
    prisma: overrides.prisma || prisma,
    logger: overrides.logger || logger,
    now: overrides.now || (() => new Date()),
    suspendTenantAccess: overrides.suspendTenantAccess || suspendTenantAccess,
    notifyOwner: overrides.notifyOwner || notifyOwner,
    // Notification Center emitter (2026-09-01): injectable like every other
    // dependency here so the suite can stub and assert it.
    emitNotification: overrides.emitNotification || emitNotificationSafe,
    env: overrides.env || process.env,
    ...overrides,
  };
}

/** Bounded per pass; the daily cadence drains any backlog. */
const BATCH = 200;

/**
 * One dunning sweep: suspend every tenant whose delinquency has outlived the
 * grace window.
 *
 * Returns counts rather than throwing on a per-tenant failure — one tenant that
 * cannot be suspended (a hand-suspension already in place, a vanished row) must
 * not stop the sweep for the rest.
 */
export async function runDunningSweep(overrides = {}) {
  const d = deps(overrides);
  const now = d.now();
  const counts = { eligible: 0, suspended: 0, skipped: 0, errors: 0, disabled: false };

  if (!isDunningEnabled(d.env)) {
    counts.disabled = true;
    // INFO, not WARN. This is the expected state for the whole rollout and an
    // alarm that fires every day on the normal configuration is an alarm people
    // learn to mute.
    d.logger.info('[billing-dunning] sweep skipped — BILLING_DUNNING_ENABLED is off');
    return counts;
  }

  const graceDays = dunningGraceDays(d.env);
  const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);

  const overdue = await d.prisma.tenantSubscription.findMany({
    where: {
      status: SUBSCRIPTION_STATUS.PAST_DUE,
      // A row with no clock has not started one. Suspending on a NULL would
      // read as "infinitely overdue" — the most dangerous possible reading of
      // a missing value on this particular query.
      pastDueSince: { not: null, lte: cutoff },
    },
    take: BATCH,
  });
  counts.eligible = overdue.length;

  for (const sub of overdue) {
    try {
      // BELT AND BRACES on the most dangerous null in this module. The query
      // above already excludes it, but a missing clock read as "infinitely
      // overdue" would suspend a tenant who was never late, so the guard is
      // repeated where the decision is actually made rather than trusted to a
      // predicate three lines up.
      if (!sub.pastDueSince) {
        counts.skipped += 1;
        continue;
      }
      const tenant = await d.prisma.tenant.findUnique({ where: { id: sub.tenantId } });
      if (!tenant) {
        counts.skipped += 1;
        continue;
      }
      // Already off — by this automation on an earlier pass, or by a human for
      // a reason billing cannot see. Either way there is nothing to do and
      // calling suspend would throw.
      if (tenant.status === 'SUSPENDED') {
        counts.skipped += 1;
        continue;
      }

      const days = Math.floor((now.getTime() - new Date(sub.pastDueSince).getTime()) / 86400000);
      // Through the SAME function the panel button uses. One suspension path,
      // one audit shape, one cache bust. A second implementation here would be
      // a second thing to keep correct, and the two would drift on the day
      // somebody changed one of them.
      await d.suspendTenantAccess({
        tenantId: tenant.id,
        reason: `Automatic suspension: payment past due for ${days} day(s), beyond the ${graceDays}-day grace window. `
          + `Last failure code: ${sub.lastFailureCode || 'unknown'}.`,
        actorUserId: null,
        actorEmail: null,
        // Named so the audit trail distinguishes this from a human click. The
        // question "did a person decide to switch this customer off, or did a
        // cron?" must be answerable from the row alone.
        actorRole: 'SYSTEM_DUNNING',
      }, overrides);

      counts.suspended += 1;

      d.logger.error('[billing-dunning] TENANT SUSPENDED FOR NON-PAYMENT', {
        tenantId: tenant.id,
        subscriptionId: sub.id,
        pastDueSince: sub.pastDueSince,
        graceDays,
        daysPastDue: days,
        message: 'The grace window elapsed with no settled payment. Access is cut and the tenant '
          + 'must update their payment method; Authorize.Net will not retry until they do.',
      });

      await d.notifyOwner('SUSPENDED', sub, {
        detectedBy: `dunning sweep (${graceDays}-day grace window)`,
        daysPastDue: days,
      });

      // Notification Center emitter (2026-09-01) — the in-app envelope for
      // the suspended tenant's own ADMINs (audienceRole gates it at the API;
      // no other role ever sees billing rows). Severity CRITICAL per the
      // contract: suspension = access already cut. Tenant-wide (no sede).
      // Deduped per delinquency episode (pastDueSince clock), so a re-run of
      // the sweep never duplicates. The owner email above is untouched.
      await d.emitNotification({
        tenantId: sub.tenantId,
        severity: 'CRITICAL',
        sourceType: 'BILLING',
        sourceRefId: sub.id,
        title: 'Subscription suspended — payment past due',
        body: `${days} day(s) past due, beyond the ${graceDays}-day grace window. Update the payment method to restore access.`,
        deepLink: '/dashboard',
        dedupeKey: `dunning-suspended:${sub.id}:${new Date(sub.pastDueSince).toISOString().slice(0, 10)}`,
        templateKey: 'billingSuspended',
        paramsJson: { days },
        audienceRole: 'ADMIN',
      });
    } catch (err) {
      counts.errors += 1;
      d.logger.warn('[billing-dunning] could not suspend', {
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
        message: err?.message || String(err),
      });
    }
  }

  d.logger.info('[billing-dunning] sweep done', counts);
  return counts;
}

export const billingDunning = {
  runDunningSweep,
  dunningGraceDays,
  isDunningEnabled,
};
