/**
 * Billing reconciliation scheduler — worker-only.
 *
 * Shape copied from long-term-billing.scheduler.js: interval timer + overlap
 * guard + startup delay, started and stopped from worker.js. The worker is a
 * single process in its own container, so there is no worker-0 guard to write
 * here — the API cluster in main.js needs one and this does not.
 *
 * CADENCE: DAILY. The design says daily is enough and it is, because the
 * reconciler is a BACKSTOP, not the primary path: webhooks answer in seconds,
 * and the thing this catches is the case where they did not answer at all. A
 * tighter loop would spend one Authorize.Net call per subscription per run to
 * re-confirm a status that changes a handful of times a year.
 *
 * The one pass that would benefit from being hourly is the unprocessed-event
 * sweep, and it is deliberately NOT split out into its own timer here: the
 * events it retries only exist when the webhook handler already failed, which
 * is rare, and a second timer is a second thing to reason about at 3am. If the
 * stuck-event count ever becomes routine, that is the signal to split it — and
 * the count is logged every run precisely so that signal is visible.
 *
 * STARTUP DELAY of 3 minutes: the reconciler makes an external call per live
 * subscription, and a container that has just booted is the worst moment to add
 * that load. It also means a crash-loop cannot hammer Authorize.Net.
 *
 * INERT UNTIL CONFIGURED. With no live subscriptions every pass finds nothing
 * and makes zero external calls, so this can ship turned on before the first
 * tenant is ever enrolled. BILLING_RECONCILE_ENABLED=false switches it off
 * entirely without a deploy.
 */
import logger from '../../lib/logger.js';
import { runBillingReconcile } from './billing-reconcile.service.js';

const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_STARTUP_DELAY_SECONDS = 180;
const HOUR_MS = 60 * 60 * 1000;

let timer = null;
let startupTimer = null;
let sweepInProgress = false;

function autoEnabled() {
  return String(process.env.BILLING_RECONCILE_ENABLED || 'true').toLowerCase() !== 'false';
}

function intervalMs() {
  const hours = Number(process.env.BILLING_RECONCILE_INTERVAL_HOURS || DEFAULT_INTERVAL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_INTERVAL_HOURS) * HOUR_MS;
}

function startupDelayMs() {
  const s = Number(process.env.BILLING_RECONCILE_STARTUP_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}

/**
 * OVERLAP GUARD. A run that outlives its own interval — a hundred subscriptions
 * against a slow Authorize.Net — must not have a second run start underneath
 * it. Two concurrent reconcilers would race on the same rows and could
 * materialise the same recovery twice; the transId unique index would stop the
 * double ledger row, but the two would still fight over the subscription's
 * status, and the loser's write would be the one that stuck.
 */
async function tick() {
  if (sweepInProgress) {
    logger.warn('[billing-reconcile] previous sweep still running — skipping this tick');
    return;
  }
  sweepInProgress = true;
  try {
    await runBillingReconcile();
  } catch (err) {
    // The sweep isolates its own per-subscription failures; reaching here means
    // something structural broke. Warn and let the next tick try: a reconciler
    // that dies permanently is a reconciler that stops being a safety net
    // exactly when one is needed.
    logger.warn('[billing-reconcile] tick error', { message: err?.message || String(err) });
  } finally {
    sweepInProgress = false;
  }
}

export function startBillingReconcileScheduler() {
  if (!autoEnabled()) {
    logger.info('[billing-reconcile] scheduler disabled by BILLING_RECONCILE_ENABLED');
    return;
  }
  if (startupTimer || timer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
    timer = setInterval(tick, intervalMs());
    if (timer.unref) timer.unref();
  }, startupDelayMs());
  if (startupTimer.unref) startupTimer.unref();
  logger.info('[billing-reconcile] scheduler started', {
    intervalHours: intervalMs() / HOUR_MS,
    startupDelaySeconds: startupDelayMs() / 1000,
  });
}

export function stopBillingReconcileScheduler() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

export const _internal = { intervalMs, autoEnabled, startupDelayMs, tick };
