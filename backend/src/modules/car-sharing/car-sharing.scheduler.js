import { carSharingService } from './car-sharing.service.js';

const DEFAULT_CHECK_HOUR_UTC = 10; // Run at 10:00 UTC daily
let handoffReminderTimer = null;
let handoffSweepInProgress = false;

function remindersEnabled() {
  return String(process.env.CAR_SHARING_HANDOFF_REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DEFAULT_CHECK_HOUR_UTC, 0, 0, 0));
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

async function runHandoffReminderSweep() {
  if (handoffSweepInProgress) {
    console.log('[car-sharing] handoff reminder sweep skipped — already in progress');
    return;
  }
  handoffSweepInProgress = true;
  try {
    const result = await carSharingService.sendHandoffConfirmationReminders({ warningHours: 24 });
    console.log(`[car-sharing] handoff reminders: ${result.sent} sent, ${result.skipped} skipped, ${result.total} alerts`);
  } catch (error) {
    console.error('[car-sharing] handoff reminder sweep failed', error);
  } finally {
    handoffSweepInProgress = false;
    // Schedule next run for tomorrow
    handoffReminderTimer = setTimeout(() => {
      runHandoffReminderSweep().catch(() => null);
    }, msUntilNextRun());
  }
}

export function startHandoffReminderScheduler() {
  if (!remindersEnabled()) {
    console.log('[car-sharing] handoff reminder scheduler disabled');
    return;
  }
  if (handoffReminderTimer) return;
  const delay = msUntilNextRun();
  const hoursUntil = Math.round(delay / (60 * 60 * 1000));
  handoffReminderTimer = setTimeout(() => {
    runHandoffReminderSweep().catch(() => null);
  }, delay);
  console.log(`[car-sharing] handoff reminder scheduler started — next run in ~${hoursUntil}h (daily at ${DEFAULT_CHECK_HOUR_UTC}:00 UTC)`);
}

export function stopHandoffReminderScheduler() {
  if (handoffReminderTimer) {
    clearTimeout(handoffReminderTimer);
    handoffReminderTimer = null;
  }
}
