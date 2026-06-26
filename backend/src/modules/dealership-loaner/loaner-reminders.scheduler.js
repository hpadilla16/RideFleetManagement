/**
 * Loaner return-due reminder scheduler.
 *
 * Periodic sweep that EMAILS the borrower (and the pickup location) when an ACTIVE loaner agreement
 * is due back soon or already overdue. (2026-06-26: switched from SMS to email — texting isn't
 * enabled; the tenant notification goes to the location email, like the portal-request notifications.)
 *
 * Dedupe is cache-based keyed by agreement + reminder kind, so each loaner gets at most one DUE_SOON
 * and one OVERDUE reminder per window. Started from worker.js.
 */

const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_STARTUP_DELAY_SECONDS = 120;
const DEFAULT_DUE_SOON_HOURS = 24;
const DUE_SOON_TTL_MS = 36 * 60 * 60 * 1000;
const OVERDUE_TTL_MS = 24 * 60 * 60 * 1000;

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

let _mailer = null;
async function resolveDefaultMailer() {
  if (_mailer) return _mailer;
  const mod = await import('../../lib/mailer.js');
  _mailer = { sendEmail: mod.sendEmail };
  return _mailer;
}

let _cache = null;
async function resolveDefaultCache() {
  if (_cache) return _cache;
  const mod = await import('../../lib/cache.js');
  _cache = mod.cache;
  return _cache;
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

let _parseLocationConfig = null;
async function resolveParseLocationConfig() {
  if (_parseLocationConfig) return _parseLocationConfig;
  const mod = await import('../../lib/location-config.js');
  _parseLocationConfig = mod.parseLocationConfig;
  return _parseLocationConfig;
}

function autoEnabled() {
  return String(process.env.LOANER_REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
}
function intervalMs() {
  const hours = Number(process.env.LOANER_REMINDERS_INTERVAL_HOURS || DEFAULT_INTERVAL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_INTERVAL_HOURS) * 60 * 60 * 1000;
}
function startupDelayMs() {
  const s = Number(process.env.LOANER_REMINDERS_STARTUP_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}
function dueSoonWindowMs() {
  const h = Number(process.env.LOANER_REMINDERS_DUE_SOON_HOURS || DEFAULT_DUE_SOON_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_DUE_SOON_HOURS) * 60 * 60 * 1000;
}

function fmtDue(d) {
  try {
    return new Date(d).toLocaleString('en-US', { timeZone: 'America/Puerto_Rico', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function portalBaseUrl() {
  return (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function buildEmail(kind, agreement) {
  const due = fmtDue(agreement.returnAt);
  const link = agreement.portalToken
    ? `\n\nManage your loaner: ${portalBaseUrl()}/customer/loaner-status?token=${encodeURIComponent(agreement.portalToken)}`
    : '';
  const num = agreement.agreementNumber ? ` (${agreement.agreementNumber})` : '';
  if (kind === 'OVERDUE') {
    return {
      subject: `Loaner past due${num}`,
      text: `Your loaner is past due (was due back ${due}). Please return it or contact us to extend.${link}`,
    };
  }
  return {
    subject: `Loaner due back soon${num}`,
    text: `Reminder: your loaner is due back ${due}.${link}`,
  };
}

/** Run one reminder sweep. Deps injectable for tests: { prisma, mailer, cache, now }. */
export async function runLoanerRemindersSweep(deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  const mailer = deps.mailer || (await resolveDefaultMailer());
  const store = deps.cache || (await resolveDefaultCache());
  const parseLocationConfig = deps.parseLocationConfig || (await resolveParseLocationConfig());
  const now = deps.now ? deps.now() : new Date();
  const logger = await getLogger();

  const soonCutoff = new Date(now.getTime() + dueSoonWindowMs());
  const rows = await prisma.loanerAgreement.findMany({
    where: { status: 'ACTIVE', returnAt: { lte: soonCutoff } },
    select: {
      id: true, tenantId: true, customerEmail: true, returnAt: true, agreementNumber: true, portalToken: true,
      reservation: { select: { pickupLocation: { select: { name: true, locationConfig: true } } } },
    },
    take: 200,
  });

  const counts = { candidates: rows.length, sent: 0, skippedNoEmail: 0, deduped: 0, failed: 0 };

  for (const row of rows) {
    const locEmail = parseLocationConfig(row.reservation?.pickupLocation?.locationConfig)?.locationEmail || '';
    const recipients = [...new Set([row.customerEmail, locEmail].filter(Boolean))];
    if (!recipients.length || !row.tenantId) {
      counts.skippedNoEmail += 1;
      continue;
    }
    const overdue = new Date(row.returnAt) < now;
    const kind = overdue ? 'OVERDUE' : 'DUE_SOON';
    const dedupeKey = `loaner-reminder:${row.id}:${kind}`;
    if (await store.get(dedupeKey)) {
      counts.deduped += 1;
      continue;
    }
    const { subject, text } = buildEmail(kind, row);
    try {
      for (const to of recipients) {
        await mailer.sendEmail({ to, subject, text });
      }
      await store.set(dedupeKey, '1', overdue ? OVERDUE_TTL_MS : DUE_SOON_TTL_MS);
      counts.sent += 1;
    } catch (err) {
      counts.failed += 1;
      logger.warn?.('[loaner-reminders] send failed', { agreementId: row.id, kind, msg: err.message });
    }
  }

  logger.info?.('[loaner-reminders] sweep done', counts);
  return counts;
}

async function tick() {
  if (sweepInProgress) return;
  sweepInProgress = true;
  try {
    await runLoanerRemindersSweep();
  } catch (err) {
    const logger = await getLogger();
    logger.warn?.('[loaner-reminders] tick error', { msg: err.message });
  } finally {
    sweepInProgress = false;
  }
}

export function startLoanerRemindersScheduler() {
  if (!autoEnabled()) return;
  if (startupTimer || timer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
    timer = setInterval(tick, intervalMs());
  }, startupDelayMs());
}

export function stopLoanerRemindersScheduler() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

export const _internal = { intervalMs, dueSoonWindowMs, buildEmail, autoEnabled };
