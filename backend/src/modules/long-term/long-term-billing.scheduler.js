/**
 * Long-Term (Monthly) Reservations — P2 cycle-billing scheduler (2026-06-04).
 *
 * Hourly sweep (interval-timer + overlap-guard + startup-delay — same
 * pattern as dealership-loaner/loaner-reminders.scheduler.js) that runs
 * the recurring-billing engine for ACTIVE monthly plans:
 *
 *   a. REMINDERS — ACTIVE + autoRenew plans whose nextCycleStartsAt falls
 *      inside the tenant's remind-before windows (default 48h and 24h) get
 *      a renewal-reminder email. Cache-deduped per plan + cycle-start +
 *      window so each window fires at most once per upcoming cycle.
 *
 *   b. BILLING — ACTIVE + autoRenew plans with nextCycleStartsAt <= now:
 *      closeNextCycle() (creates the MONTHLY_CYCLE charge + BillingCycle
 *      row + extends returnAt), then — when tenant billingMode is AUTO —
 *      charge the agreement's card-on-file via the iPOSpays Transact API.
 *      Approval → payment rows (RentalAgreementPayment + ReservationPayment
 *      mirror) + ledger recompute + markCyclePaid + receipt email.
 *      Decline → attempts++, lastError, status FAILED. Nothing is emailed
 *      yet — the customer gets the tenant-configured grace period
 *      (default 1 day) before dunning starts.
 *
 *   c. RETRY + DUNNING — FAILED cycles are retried every sweep up to
 *      MAX_CHARGE_ATTEMPTS (3). Once graceDays past periodStart with the
 *      cycle still unpaid: overdue email every overdueEveryHours (default
 *      24h, cache-deduped) + a one-time staff notification (same
 *      env-recipient pattern as the autocharge failure notifier).
 *
 *   d. AUTO-CLEAR — the moment ANY payment lands (counter cash, manual
 *      card, whatever) and the agreement balance reaches 0, FAILED cycles
 *      flip to PAID via markCyclePaid and dunning stops automatically
 *      (PAID cycles never match the dunning query again).
 *
 *   e. MANUAL mode — tenant billingMode MANUAL still creates cycles +
 *      sends reminders, but never touches the card; staff bill from the
 *      plan panel and overdue dunning still applies to unpaid cycles.
 *
 * NOTE: no customer pay-link yet — the Hosted Payment Page flow is
 * pending Dejavoo enabling HPP on the TPN. See the TODO in
 * long-term-emails.js (overdue template) for where it goes.
 *
 * Started/stopped from worker.js. Plan: doc/long-term-reservations-plan-2026-06-03.md
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { cache } from '../../lib/cache.js';
import { iposTransactClient } from '../payment-gateway/ipos-transact-client.js';
import { longTermService } from './long-term.service.js';
import { getLongTermEmailConfig, sendLongTermEmail } from './long-term-emails.js';

const DEFAULT_INTERVAL_HOURS = 1;
const DEFAULT_STARTUP_DELAY_SECONDS = 120;
const MAX_CHARGE_ATTEMPTS = 3;

// Dedupe TTLs. Reminder keys are unique per plan+cycle+window so a long
// TTL is safe (the key changes when nextCycleStartsAt advances). Overdue
// TTL is set per-tenant from overdueEveryHours at send time.
const REMINDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STAFF_NOTIFY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // once per failed cycle
const ENDED_TTL_MS = 14 * 24 * 60 * 60 * 1000;        // once per ended plan
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let timer = null;
let startupTimer = null;
let sweepInProgress = false;

function autoEnabled() {
  return String(process.env.LONG_TERM_BILLING_ENABLED || 'true').toLowerCase() !== 'false';
}
function intervalMs() {
  const hours = Number(process.env.LONG_TERM_BILLING_INTERVAL_HOURS || DEFAULT_INTERVAL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_INTERVAL_HOURS) * HOUR_MS;
}
function startupDelayMs() {
  const s = Number(process.env.LONG_TERM_BILLING_STARTUP_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}

function round2(n) { return Number(Number(n || 0).toFixed(2)); }

// Per-tenant email config, memoized within a single sweep so 50 plans on
// the same tenant don't issue 50 appSetting reads.
function makeConfigLoader() {
  const memo = new Map();
  return async (tenantId) => {
    const key = tenantId || '__global__';
    if (!memo.has(key)) {
      memo.set(key, await getLongTermEmailConfig({ tenantId: tenantId || null }));
    }
    return memo.get(key);
  };
}

// ── Payment recording (mirror of spin-charge.service recomputeAgreementPaid,
//    which is not exported — same rules, local copy) ─────────────────────

/**
 * paidAmount = Σ RentalAgreementPayment rows with status PAID, excluding
 *              method AUTH_HOLD (a deposit hold is not money received).
 * balance    = max(0, Σ selected NON-deposit charges − paidAmount)
 *              (SECURITY_DEPOSIT charges excluded — a hold, not money owed).
 * Summing the ledger (instead of incrementing) keeps this idempotent and
 * self-healing after voids/retries — same rationale as spin-charge.
 */
async function recomputeAgreementPaid(agreementId) {
  if (!agreementId) return null;
  try {
    const [agg, charges] = await Promise.all([
      prisma.rentalAgreementPayment.aggregate({
        where: { rentalAgreementId: agreementId, status: 'PAID', method: { not: 'AUTH_HOLD' } },
        _sum: { amount: true },
      }),
      prisma.rentalAgreementCharge.findMany({
        where: { rentalAgreementId: agreementId, selected: true },
        select: { source: true, total: true },
      }),
    ]);
    const paidAmount = round2(agg?._sum?.amount || 0);
    const owedSum = charges
      .filter((c) => String(c.source || '').toUpperCase() !== 'SECURITY_DEPOSIT')
      .reduce((sum, c) => sum + Number(c.total || 0), 0);
    const balance = round2(Math.max(0, owedSum - paidAmount));
    await prisma.rentalAgreement.update({
      where: { id: agreementId },
      data: { paidAmount, balance },
    });
    return { paidAmount, balance };
  } catch (err) {
    logger.warn('[long-term-billing] agreement paid/balance recompute failed', {
      agreementId, message: err.message,
    });
    return null;
  }
}

/**
 * Record an approved cycle charge: RentalAgreementPayment (the ledger of
 * record) + ReservationPayment mirror (View Payments page) + recompute.
 * Same row shape spin-charge.service writes.
 */
async function recordCyclePayment({ agreement, reservationId, amount, norm, cycleNumber }) {
  const reference = `IPOS_LTC:${norm.authCode || norm.rrn || norm.referenceId || 'OK'}${agreement.cardOnFileLast4 ? ` ****${agreement.cardOnFileLast4}` : ''}`;
  const notes = `Monthly cycle ${cycleNumber} auto-charge (CNP card-on-file)`;
  const payment = await prisma.rentalAgreementPayment.create({
    data: {
      rentalAgreementId: agreement.id,
      method: 'CARD',
      amount: round2(amount),
      reference,
      status: 'PAID',
      notes,
    },
  });
  // Mirror is best-effort — the agreement ledger is the source of truth.
  try {
    await prisma.reservationPayment.create({
      data: {
        reservationId,
        method: 'CARD',
        amount: round2(amount),
        reference,
        status: 'PAID',
        paidAt: new Date(),
        origin: 'OTC',
        gateway: 'SPIN',
        notes,
        rentalAgreementPaymentId: payment.id,
      },
    });
  } catch (err) {
    logger.warn('[long-term-billing] reservationPayment mirror failed', {
      reservationId, paymentId: payment.id, message: err.message,
    });
  }
  await recomputeAgreementPaid(agreement.id);
  return payment;
}

// ── Charging ───────────────────────────────────────────────────────────

async function loadAgreementForPlan(plan) {
  return prisma.rentalAgreement.findFirst({
    where: {
      reservationId: plan.reservationId,
      ...(plan.tenantId ? { tenantId: plan.tenantId } : {}),
    },
    select: {
      id: true,
      tenantId: true,
      agreementNumber: true,
      balance: true,
      paidAmount: true,
      cardOnFileToken: true,
      cardOnFileBrand: true,
      cardOnFileLast4: true,
      customerFirstName: true,
      customerLastName: true,
      customerEmail: true,
      customerPhone: true,
    },
  });
}

// Tenant config for the Transact client. Tenant-level gateway columns
// don't exist yet — the client falls back to env vars — so this mirrors
// rental-agreements.service loadTenantSpinConfig (returns {}).
async function loadTenantGatewayConfig(_tenantId) {
  return {};
}

/**
 * Attempt the card-on-file charge for one cycle. On approval: payment
 * rows + recompute + markCyclePaid + receipt email. On decline/error:
 * attempts++, lastError, status FAILED (grace — no customer email here).
 * Returns 'paid' | 'failed' | 'skipped'.
 */
async function attemptCycleCharge({ plan, cycle, emailConfig, store }) {
  const agreement = await loadAgreementForPlan(plan);
  if (!agreement) {
    await markCycleFailed(cycle, 'No rental agreement linked to the reservation');
    return 'failed';
  }
  if (!agreement.cardOnFileToken) {
    await markCycleFailed(cycle, 'No card-on-file token — collect at counter');
    return 'failed';
  }

  const amount = round2(cycle.amount);
  if (!(amount > 0)) {
    // Zero-amount cycle (comped) — just mark it paid, nothing to charge.
    await longTermService.markCyclePaid({ tenantId: plan.tenantId || null }, cycle.id, {});
    return 'paid';
  }

  const tenantConfig = await loadTenantGatewayConfig(plan.tenantId);
  const customerName = [agreement.customerFirstName, agreement.customerLastName]
    .filter(Boolean).join(' ').trim();

  let norm;
  try {
    // chargeWithToken takes DOLLARS and converts to cents internally (toCents).
    const response = await iposTransactClient.chargeWithToken({
      amount,
      agreementNumber: agreement.agreementNumber || agreement.id,
      cardToken: agreement.cardOnFileToken,
      customer: {
        name: customerName,
        email: agreement.customerEmail || '',
        phone: agreement.customerPhone || '',
      },
      description: `Monthly rental cycle ${cycle.cycleNumber}`,
    }, tenantConfig);
    norm = iposTransactClient.normalizeResponse(response);
    if (!norm.approved) {
      throw new Error(norm.errMessage || norm.message || 'Card-on-file charge declined');
    }
  } catch (err) {
    logger.warn('[long-term-billing] cycle charge declined', {
      planId: plan.id, cycleId: cycle.id, cycleNumber: cycle.cycleNumber,
      attempt: (cycle.attempts || 0) + 1, message: err.message,
    });
    await markCycleFailed(cycle, err.message || String(err));
    return 'failed';
  }

  // Approved — record, recompute, mark paid, receipt.
  const payment = await recordCyclePayment({
    agreement,
    reservationId: plan.reservationId,
    amount,
    norm,
    cycleNumber: cycle.cycleNumber,
  });
  await longTermService.markCyclePaid(
    { tenantId: plan.tenantId || null },
    cycle.id,
    { paymentId: payment.id },
  );
  await prisma.auditLog.create({
    data: {
      tenantId: plan.tenantId || null,
      reservationId: plan.reservationId,
      actorUserId: null, // system-initiated
      action: 'UPDATE',
      reason: `Monthly cycle ${cycle.cycleNumber} auto-charged $${amount.toFixed(2)} to card ending ${agreement.cardOnFileLast4 || '????'}`,
      metadata: JSON.stringify({
        event: 'LONG_TERM_CYCLE_AUTOCHARGE_SUCCESS',
        planId: plan.id, cycleId: cycle.id, cycleNumber: cycle.cycleNumber, amount,
        authCode: norm.authCode, rrn: norm.rrn,
      }),
    },
  }).catch((err) => {
    logger.warn('[long-term-billing] audit log failed (charge succeeded)', {
      cycleId: cycle.id, message: err.message,
    });
  });

  // Receipt — dedupe per cycle so a markCyclePaid race never double-sends.
  const receiptKey = `lt-receipt:${cycle.id}`;
  if (!store.get(receiptKey)) {
    const res = await sendLongTermEmail('receipt', {
      plan, cycle: { ...cycle, amount }, config: emailConfig,
    });
    if (res.sent) store.set(receiptKey, '1', REMINDER_TTL_MS);
  }

  logger.info('[long-term-billing] cycle charged', {
    planId: plan.id, cycleId: cycle.id, cycleNumber: cycle.cycleNumber, amount,
  });
  return 'paid';
}

async function markCycleFailed(cycle, message) {
  try {
    await prisma.billingCycle.update({
      where: { id: cycle.id },
      data: {
        status: 'FAILED',
        attempts: { increment: 1 },
        lastError: String(message || '').slice(0, 500),
      },
    });
  } catch (err) {
    logger.warn('[long-term-billing] failed to mark cycle FAILED', {
      cycleId: cycle.id, message: err.message,
    });
  }
}

// Staff notification — same env-recipient pattern as the autocharge
// failure notifier (autocharge.worker.js notifyStaffAutochargeFailed).
async function notifyStaffCycleOverdue({ plan, cycle, agreement }) {
  const recipient = process.env.AUTOCHARGE_FAILURE_NOTIFICATION_EMAIL
    || process.env.OPS_NOTIFICATION_EMAIL
    || '';
  if (!recipient) {
    logger.warn('[long-term-billing] no AUTOCHARGE_FAILURE_NOTIFICATION_EMAIL configured — staff not notified');
    return false;
  }
  try {
    const { sendEmail } = await import('../../lib/mailer.js');
    const amount = round2(cycle.amount);
    await sendEmail({ tenantId: plan?.tenantId,
      to: recipient,
      subject: `[Monthly cycle OVERDUE] ${agreement?.agreementNumber || plan.reservationId} — $${amount.toFixed(2)} cycle ${cycle.cycleNumber}`,
      html: `
        <h3>Monthly billing cycle overdue</h3>
        <p><strong>Agreement:</strong> ${agreement?.agreementNumber || '—'}</p>
        <p><strong>Reservation ID:</strong> ${plan.reservationId}</p>
        <p><strong>Cycle:</strong> #${cycle.cycleNumber} (${new Date(cycle.periodStart).toDateString()} – ${new Date(cycle.periodEnd).toDateString()})</p>
        <p><strong>Amount due:</strong> $${amount.toFixed(2)}</p>
        <p><strong>Attempts:</strong> ${cycle.attempts || 0}</p>
        <p><strong>Last error:</strong> ${cycle.lastError || '—'}</p>
        <p>Auto-charge could not collect this cycle. The customer is receiving daily overdue notices. Collect payment manually from View Payments — overdue clears automatically once any payment brings the balance to $0.</p>
      `,
      text: `Monthly cycle #${cycle.cycleNumber} overdue for ${agreement?.agreementNumber || plan.reservationId}.\nAmount: $${amount.toFixed(2)}\nAttempts: ${cycle.attempts || 0}\nLast error: ${cycle.lastError || '-'}`,
    });
    return true;
  } catch (err) {
    logger.error('[long-term-billing] staff overdue notification failed', { cycleId: cycle.id, message: err.message });
    return false;
  }
}

// ── Sweep phases ───────────────────────────────────────────────────────

/** a. REMINDERS — 48h/24h (tenant-configurable) before nextCycleStartsAt. */
async function sweepReminders({ now, store, loadConfig, counts }) {
  // Max possible window across tenants is bounded by the config normalizer
  // (≤720h). Query once with a generous cutoff and filter per tenant config.
  const cutoff = new Date(now.getTime() + 720 * HOUR_MS);
  const plans = await prisma.longTermPlan.findMany({
    where: {
      status: 'ACTIVE',
      autoRenew: true,
      nextCycleStartsAt: { gt: now, lte: cutoff },
    },
    take: 500,
  });

  for (const plan of plans) {
    try {
      const cfg = await loadConfig(plan.tenantId);
      if (!cfg.reminder.enabled) continue;
      const dueAt = new Date(plan.nextCycleStartsAt);
      const hoursUntil = (dueAt.getTime() - now.getTime()) / HOUR_MS;

      // Pick the SMALLEST configured window that we're inside — so at
      // 23h out we send the 24h reminder, not the 48h one again.
      const windows = [...cfg.remindBeforeHours].sort((a, b) => a - b);
      const windowH = windows.find((h) => hoursUntil <= h);
      if (!windowH) continue;

      const dedupeKey = `lt-reminder:${plan.id}:${dueAt.toISOString()}:${windowH}`;
      if (store.get(dedupeKey)) { counts.remindersDeduped += 1; continue; }

      // The upcoming cycle hasn't been created yet — synthesize its
      // numbers for the merge tags from the plan.
      const lastCycle = await prisma.billingCycle.findFirst({
        where: { longTermPlanId: plan.id },
        orderBy: { cycleNumber: 'desc' },
        select: { cycleNumber: true },
      });
      const upcoming = {
        cycleNumber: (lastCycle?.cycleNumber || 0) + 1,
        periodStart: dueAt,
        periodEnd: new Date(dueAt.getTime() + plan.cycleLengthDays * DAY_MS),
        amount: Number(plan.cycleRate),
      };
      const res = await sendLongTermEmail('reminder', { plan, cycle: upcoming, config: cfg });
      if (res.sent) {
        store.set(dedupeKey, '1', REMINDER_TTL_MS);
        counts.remindersSent += 1;
      } else {
        counts.remindersSkipped += 1;
      }
    } catch (err) {
      counts.errors += 1;
      logger.warn('[long-term-billing] reminder failed', { planId: plan.id, message: err.message });
    }
  }
}

/** b. BILLING — close + (AUTO) charge cycles that are due. */
async function sweepBilling({ now, store, loadConfig, counts }) {
  const plans = await prisma.longTermPlan.findMany({
    where: {
      status: 'ACTIVE',
      autoRenew: true,
      nextCycleStartsAt: { lte: now },
    },
    orderBy: { nextCycleStartsAt: 'asc' },
    take: 100, // bounded per sweep; the hourly cadence drains any backlog
  });

  for (const plan of plans) {
    try {
      const cfg = await loadConfig(plan.tenantId);

      // closeNextCycle(user, planId, payload) — pass a tenant-scoped
      // system "user" built from the plan row so tenantScope() applies.
      const systemUser = { tenantId: plan.tenantId || null };
      let closed;
      try {
        closed = await longTermService.closeNextCycle(systemUser, plan.id, {});
      } catch (err) {
        // e.g. "No rental agreement yet" (409) — log and move on; the
        // plan stays due and is retried next sweep.
        counts.closeFailed += 1;
        logger.warn('[long-term-billing] closeNextCycle failed', {
          planId: plan.id, message: err.message,
        });
        continue;
      }
      counts.cyclesClosed += 1;

      if (cfg.billingMode === 'MANUAL') {
        // e. MANUAL mode — cycle created (status DUE), staff bill from
        // the plan panel. No card touch, no failure dunning until past
        // grace (handled by the dunning sweep below for FAILED cycles
        // only — MANUAL DUE cycles are staff's queue, not dunning's).
        counts.manualSkipped += 1;
        continue;
      }

      const result = await attemptCycleCharge({
        plan, cycle: closed.cycle, emailConfig: cfg, store,
      });
      if (result === 'paid') counts.charged += 1;
      else counts.chargeFailed += 1;
    } catch (err) {
      counts.errors += 1;
      logger.warn('[long-term-billing] billing pass failed for plan', {
        planId: plan.id, message: err.message,
      });
    }
  }
}

/**
 * c+d. RETRY, DUNNING, AUTO-CLEAR for unpaid past-due cycles.
 *
 * Covers FAILED cycles (auto-charge declined) AND DUE cycles already past
 * their due date (MANUAL-mode cycles staff hasn't billed, plus cycle 1
 * rows nobody marked paid). All plan statuses are scanned so auto-clear
 * works even after a plan is paused/ended — but retries and customer
 * emails only run for plans that are still alive.
 */
async function sweepFailedCycles({ now, store, loadConfig, counts }) {
  const cycles = await prisma.billingCycle.findMany({
    where: {
      OR: [
        { status: 'FAILED' },
        { status: 'DUE', periodStart: { lte: now } },
      ],
    },
    include: { longTermPlan: true },
    orderBy: { periodStart: 'asc' },
    take: 200,
  });

  for (const cycle of cycles) {
    const plan = cycle.longTermPlan;
    if (!plan) continue;
    try {
      const cfg = await loadConfig(plan.tenantId);
      const agreement = await loadAgreementForPlan(plan);

      // d. AUTO-CLEAR — any payment landed (balance reached 0): mark the
      // cycle PAID and stop. PAID cycles drop out of this query, so the
      // overdue emails stop automatically. Runs regardless of plan status.
      if (agreement && Number(agreement.balance || 0) <= 0) {
        await longTermService.markCyclePaid({ tenantId: plan.tenantId || null }, cycle.id, {});
        counts.autoCleared += 1;
        logger.info('[long-term-billing] cycle auto-cleared (balance 0)', {
          planId: plan.id, cycleId: cycle.id, cycleNumber: cycle.cycleNumber,
        });
        continue;
      }

      // Ended/paused plans: no retries, no customer dunning — staff
      // handles wind-down manually. (Auto-clear above still applies.)
      if (plan.status !== 'ACTIVE') continue;

      // c. RETRY — AUTO mode only, every sweep, capped at
      // MAX_CHARGE_ATTEMPTS. The cache key includes the attempt counter
      // purely as a stuck-write guard: if markCycleFailed couldn't bump
      // attempts, the unchanged key stops a same-attempt hot loop.
      if (
        cfg.billingMode === 'AUTO'
        && cycle.status === 'FAILED'
        && (cycle.attempts || 0) < MAX_CHARGE_ATTEMPTS
        && agreement?.cardOnFileToken
      ) {
        const retryKey = `lt-retry:${cycle.id}:${cycle.attempts || 0}`;
        if (!store.get(retryKey)) {
          store.set(retryKey, '1', intervalMs());
          const result = await attemptCycleCharge({ plan, cycle, emailConfig: cfg, store });
          if (result === 'paid') { counts.retriesPaid += 1; continue; }
          counts.retriesFailed += 1;
        }
      }

      // Grace: dunning starts graceDays after the cycle's periodStart
      // (the due date). Inside grace → stay quiet.
      const graceEndsAt = new Date(new Date(cycle.periodStart).getTime() + cfg.graceDays * DAY_MS);
      if (now < graceEndsAt) continue;

      // Overdue email — every overdueEveryHours, cache-deduped. The key is
      // stable per cycle; the TTL is the resend interval.
      if (cfg.overdue.enabled) {
        const overdueKey = `lt-overdue:${cycle.id}`;
        if (!store.get(overdueKey)) {
          const res = await sendLongTermEmail('overdue', { plan, cycle, config: cfg });
          if (res.sent) {
            store.set(overdueKey, '1', cfg.overdueEveryHours * HOUR_MS);
            counts.overdueSent += 1;
          }
        } else {
          counts.overdueDeduped += 1;
        }
      }

      // Staff notification — once per overdue cycle.
      const staffKey = `lt-staff-overdue:${cycle.id}`;
      if (!store.get(staffKey)) {
        const ok = await notifyStaffCycleOverdue({ plan, cycle, agreement });
        if (ok) {
          store.set(staffKey, '1', STAFF_NOTIFY_TTL_MS);
          counts.staffNotified += 1;
        }
      }
    } catch (err) {
      counts.errors += 1;
      logger.warn('[long-term-billing] dunning pass failed for cycle', {
        cycleId: cycle.id, planId: plan?.id, message: err.message,
      });
    }
  }
}

/** Plan-ended confirmation — once per plan that recently flipped ENDED. */
async function sweepEndedPlans({ now, store, loadConfig, counts }) {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const plans = await prisma.longTermPlan.findMany({
    where: { status: 'ENDED', endedAt: { gte: since } },
    take: 100,
  });
  for (const plan of plans) {
    try {
      const dedupeKey = `lt-ended:${plan.id}`;
      if (store.get(dedupeKey)) continue;
      const cfg = await loadConfig(plan.tenantId);
      if (!cfg.ended.enabled) continue;
      const lastCycle = await prisma.billingCycle.findFirst({
        where: { longTermPlanId: plan.id },
        orderBy: { cycleNumber: 'desc' },
      });
      const res = await sendLongTermEmail('ended', {
        plan,
        cycle: lastCycle || {
          cycleNumber: '', periodStart: plan.endedAt, periodEnd: plan.endedAt, amount: 0,
        },
        config: cfg,
      });
      if (res.sent) {
        store.set(dedupeKey, '1', ENDED_TTL_MS);
        counts.endedSent += 1;
      }
    } catch (err) {
      counts.errors += 1;
      logger.warn('[long-term-billing] ended email failed', { planId: plan.id, message: err.message });
    }
  }
}

/**
 * Run one full billing sweep. Deps injectable for tests: { now }.
 */
export async function runLongTermBillingSweep(deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  const store = deps.cache || cache;
  const loadConfig = makeConfigLoader();
  const counts = {
    remindersSent: 0, remindersDeduped: 0, remindersSkipped: 0,
    cyclesClosed: 0, closeFailed: 0, charged: 0, chargeFailed: 0, manualSkipped: 0,
    retriesPaid: 0, retriesFailed: 0,
    autoCleared: 0, overdueSent: 0, overdueDeduped: 0, staffNotified: 0,
    endedSent: 0, errors: 0,
  };

  await sweepReminders({ now, store, loadConfig, counts });
  await sweepBilling({ now, store, loadConfig, counts });
  await sweepFailedCycles({ now, store, loadConfig, counts });
  await sweepEndedPlans({ now, store, loadConfig, counts });

  logger.info('[long-term-billing] sweep done', counts);
  return counts;
}

async function tick() {
  if (sweepInProgress) return;
  sweepInProgress = true;
  try {
    await runLongTermBillingSweep();
  } catch (err) {
    logger.warn('[long-term-billing] tick error', { message: err.message });
  } finally {
    sweepInProgress = false;
  }
}

export function startLongTermBillingScheduler() {
  if (!autoEnabled()) return;
  if (startupTimer || timer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
    timer = setInterval(tick, intervalMs());
  }, startupDelayMs());
}

export function stopLongTermBillingScheduler() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

export const _internal = { intervalMs, autoEnabled, recomputeAgreementPaid };
