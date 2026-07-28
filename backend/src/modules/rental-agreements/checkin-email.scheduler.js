/**
 * Delayed post-check-in email scheduler (2026-07-28, LAX #8).
 *
 * When a pickup location sets `checkinEmailDelayHours` (locationConfig),
 * checkin-close stamps Reservation.checkinEmailDueAt instead of emailing
 * inline. This sweep delivers due emails, deciding receipt-vs-invoice from
 * the agreement balance AT SEND TIME — by then the 24h autocharge may have
 * settled the balance, in which case the autocharge worker already sent its
 * success receipt AND stamped checkinEmailSentAt, so we send nothing (the
 * customer gets exactly one post-check-in email either way).
 *
 * Dedupe is column-based (checkinEmailSentAt), same shape as the
 * precheckin-invite scheduler. The stamp is written BEFORE the send and
 * reverted on failure so the next sweep retries instead of double-sending.
 * Fail-open per reservation. Started from worker.js.
 */

const DEFAULT_INTERVAL_MINUTES = 10;
const DEFAULT_STARTUP_DELAY_SECONDS = 120;
const BALANCE_ZERO_EPSILON = 0.01;
const BATCH_SIZE = 100;

let timer = null;
let startupTimer = null;
let sweepInProgress = false;

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}
let _senders = null;
async function resolveDefaultSenders() {
  if (_senders) return _senders;
  const mod = await import('./checkin-emails.service.js');
  _senders = { sendReceiptPaidInFull: mod.sendReceiptPaidInFull, sendInvoiceAfterCheckin: mod.sendInvoiceAfterCheckin };
  return _senders;
}
let _logger = null;
async function getLogger() {
  if (_logger) return _logger;
  try {
    const mod = await import('../../lib/logger.js');
    _logger = mod.default || mod;
  } catch {
    _logger = { info: () => {}, warn: () => {}, error: () => {} };
  }
  return _logger;
}

function schedulerEnabled() {
  return String(process.env.CHECKIN_EMAIL_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
}
function intervalMs() {
  const m = Number(process.env.CHECKIN_EMAIL_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES);
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
}
function startupDelayMs() {
  const s = Number(process.env.CHECKIN_EMAIL_STARTUP_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}

/** Run one sweep. Deps injectable for tests: { prisma, senders, now }. */
export async function runCheckinEmailSweep(deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  const senders = deps.senders || (await resolveDefaultSenders());
  const now = deps.now ? deps.now() : new Date();
  const logger = await getLogger();

  const rows = await prisma.reservation.findMany({
    where: {
      checkinEmailDueAt: { lte: now },
      checkinEmailSentAt: null,
    },
    select: {
      id: true,
      tenantId: true,
      rentalAgreement: { select: { id: true, balance: true } },
    },
    take: BATCH_SIZE,
  });

  const counts = { due: rows.length, receipts: 0, invoices: 0, skippedNoAgreement: 0, failed: 0 };

  for (const row of rows) {
    const agreement = row.rentalAgreement;
    if (!agreement?.id) {
      // No agreement to bill from — stamp so the row doesn't loop forever.
      counts.skippedNoAgreement += 1;
      await prisma.reservation.update({
        where: { id: row.id },
        data: { checkinEmailSentAt: now },
      }).catch(() => {});
      continue;
    }
    const balance = Number(agreement.balance || 0);
    const kind = balance <= BALANCE_ZERO_EPSILON ? 'receipt' : 'invoice';
    try {
      // Stamp first (exactly-once bias), revert on failure so the next sweep
      // retries — a transient mailer error must not double-send later.
      await prisma.reservation.update({
        where: { id: row.id },
        data: { checkinEmailSentAt: now },
      });
      if (kind === 'receipt') {
        await senders.sendReceiptPaidInFull({ reservationId: row.id, agreementId: agreement.id });
        counts.receipts += 1;
      } else {
        await senders.sendInvoiceAfterCheckin({ reservationId: row.id, agreementId: agreement.id });
        counts.invoices += 1;
      }
    } catch (err) {
      counts.failed += 1;
      await prisma.reservation.update({
        where: { id: row.id },
        data: { checkinEmailSentAt: null },
      }).catch(() => {});
      logger.warn?.('[checkin-email] delayed send failed (will retry next sweep)', {
        reservationId: row.id, kind, msg: err.message,
      });
    }
  }

  if (counts.due > 0) logger.info?.('[checkin-email] sweep done', counts);
  return counts;
}

async function tick() {
  if (sweepInProgress) return;
  sweepInProgress = true;
  try {
    await runCheckinEmailSweep();
  } catch (err) {
    const logger = await getLogger();
    logger.warn?.('[checkin-email] tick error', { msg: err.message });
  } finally {
    sweepInProgress = false;
  }
}

export async function startCheckinEmailScheduler() {
  const logger = await getLogger();
  if (!schedulerEnabled()) {
    logger.info?.('[checkin-email] scheduler disabled (CHECKIN_EMAIL_SCHEDULER_ENABLED=false)');
    return;
  }
  if (timer || startupTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
    timer = setInterval(tick, intervalMs());
  }, startupDelayMs());
  logger.info?.(`[checkin-email] scheduler started every ${Math.round(intervalMs() / 60000)} minute(s)`);
}

export function stopCheckinEmailScheduler() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}
