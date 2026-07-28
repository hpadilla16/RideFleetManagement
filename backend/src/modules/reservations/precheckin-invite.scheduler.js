/**
 * Pre-check-in auto-invite scheduler (2026-06-28).
 *
 * Opt-in, per-tenant. When a tenant enables `precheckinAutoEmail` in Settings, this
 * periodic sweep EMAILS the customer the pre-check-in link automatically N hours
 * before pickup (leadHours: 24/48/72), and — if enabled — a single follow-up
 * reminder closer to pickup (reminderLeadHours) when they haven't completed it yet.
 *
 * Dedupe is column-based (Reservation.precheckinAutoInviteSentAt / precheckinAutoReminderSentAt)
 * so each reservation gets at most one auto-invite and one auto-reminder. Manual sends are
 * respected: if an advisor already issued a customerInfoToken, the auto-invite is skipped.
 * Fail-open per reservation/tenant. Started from worker.js.
 */

import crypto from 'crypto';
import { renderBrandedEmail, resolveEmailBrand } from '../../lib/email-template.js';
import { settingsService } from '../settings/settings.service.js';
import { parseLocationConfig } from '../../lib/location-config.js';

const DEFAULT_INTERVAL_HOURS = 1;
const DEFAULT_STARTUP_DELAY_SECONDS = 90;
const MAX_LEAD_HOURS = 72;          // widest preset; bounds the candidate query window
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 2; // 48h, mirrors the manual request

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

function autoEnabled() {
  return String(process.env.PRECHECKIN_AUTOEMAIL_ENABLED || 'true').toLowerCase() !== 'false';
}
function intervalMs() {
  const h = Number(process.env.PRECHECKIN_AUTOEMAIL_INTERVAL_HOURS || DEFAULT_INTERVAL_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_INTERVAL_HOURS) * 60 * 60 * 1000;
}
function startupDelayMs() {
  const s = Number(process.env.PRECHECKIN_AUTOEMAIL_STARTUP_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}
function portalBaseUrl() {
  return (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}
function isSpanish(locale) {
  return String(locale || '').toLowerCase().startsWith('es');
}

export function buildInviteEmail(kind, { reservationNumber, customerName, link, locale }, brand) {
  const es = isSpanish(locale);
  const reminder = kind === 'REMINDER';
  const subject = es
    ? `${reminder ? 'Recordatorio: ' : ''}Completa tu pre-check-in${reservationNumber ? ` — Reserva ${reservationNumber}` : ''}`
    : `${reminder ? 'Reminder: ' : ''}Complete your pre-check-in${reservationNumber ? ` — Reservation ${reservationNumber}` : ''}`;
  const heading = es ? 'Completa tu pre-check-in' : 'Complete your pre-check-in';
  const greeting = es ? `Hola ${customerName || ''},`.trim() : `Hello ${customerName || ''},`.trim();
  const intro = reminder
    ? (es
        ? 'Aún no has completado tu pre-check-in. Termínalo antes de recogerlo para agilizar tu visita al mostrador.'
        : "You haven't finished your pre-check-in yet. Complete it before pickup to speed up your time at the counter.")
    : (es
        ? 'Completa tu pre-check-in antes de recoger tu vehículo para agilizar tu visita al mostrador.'
        : 'Complete your pre-check-in before pickup to speed up your time at the counter.');
  const ctaLabel = es ? 'Completar pre-check-in' : 'Complete pre-check-in';
  const bodyHtml = `${greeting}<br/><br/>${intro}`;
  const text = `${greeting}\n\n${intro}\n\n${ctaLabel}: ${link}`;
  const { html } = renderBrandedEmail({
    brand,
    heading,
    bodyHtml,
    cta: link ? { label: ctaLabel, url: link } : null,
  });
  return { subject, text, html };
}

/** Run one sweep. Deps injectable for tests: { prisma, mailer, now, getConfig, resolveBrand }. */
export async function runPrecheckinInviteSweep(deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  const mailer = deps.mailer || (await resolveDefaultMailer());
  const now = deps.now ? deps.now() : new Date();
  const logger = await getLogger();
  const getConfig = deps.getConfig || ((scope) => settingsService.getPrecheckinAutoEmail(scope));
  const resolveBrand = deps.resolveBrand || resolveEmailBrand;

  const windowEnd = new Date(now.getTime() + MAX_LEAD_HOURS * 60 * 60 * 1000);
  const rows = await prisma.reservation.findMany({
    where: {
      status: { in: ['NEW', 'CONFIRMED'] },
      customerInfoCompletedAt: null,
      pickupAt: { gt: now, lte: windowEnd },
    },
    select: {
      id: true, tenantId: true, reservationNumber: true, pickupAt: true,
      customerInfoToken: true, precheckinAutoInviteSentAt: true, precheckinAutoReminderSentAt: true,
      customer: { select: { firstName: true, lastName: true, email: true, locale: true } },
      pickupLocation: { select: { locationConfig: true } },
    },
    take: 500,
  });

  const counts = { candidates: rows.length, invited: 0, reminded: 0, skippedNoEmail: 0, skippedDisabled: 0, skippedLocationDisabled: 0, deduped: 0, failed: 0 };
  const cfgCache = new Map();
  const brandCache = new Map();
  const cfgFor = async (tenantId) => {
    if (cfgCache.has(tenantId)) return cfgCache.get(tenantId);
    let c; try { c = await getConfig({ tenantId }); } catch { c = null; }
    cfgCache.set(tenantId, c); return c;
  };
  const brandFor = async (tenantId) => {
    if (brandCache.has(tenantId)) return brandCache.get(tenantId);
    let b; try { b = await resolveBrand({ tenantId }); } catch { b = undefined; }
    brandCache.set(tenantId, b); return b;
  };

  for (const row of rows) {
    const email = String(row.customer?.email || '').trim();
    if (!email || !row.tenantId) { counts.skippedNoEmail += 1; continue; }
    const cfg = await cfgFor(row.tenantId);
    if (!cfg?.enabled) { counts.skippedDisabled += 1; continue; }
    // 2026-07-28 (LAX #7): per-location kill switch. Absent key = enabled, so
    // only a location explicitly set to false (LAX) opts out — every other
    // location keeps the tenant-level behavior unchanged.
    if (parseLocationConfig(row.pickupLocation?.locationConfig).precheckinAutoEmailEnabled === false) {
      counts.skippedLocationDisabled += 1;
      continue;
    }

    const hoursToPickup = (new Date(row.pickupAt).getTime() - now.getTime()) / (60 * 60 * 1000);
    const customerName = `${row.customer?.firstName || ''} ${row.customer?.lastName || ''}`.trim() || 'Customer';
    const locale = row.customer?.locale;

    let kind = null;
    if (!row.precheckinAutoInviteSentAt && !row.customerInfoToken && hoursToPickup <= cfg.leadHours) {
      kind = 'INVITE';
    } else if (cfg.reminderEnabled && cfg.reminderLeadHours < cfg.leadHours && row.precheckinAutoInviteSentAt && !row.precheckinAutoReminderSentAt && hoursToPickup <= cfg.reminderLeadHours) {
      kind = 'REMINDER';
    }
    if (!kind) { counts.deduped += 1; continue; }

    try {
      // Mint a fresh token for an invite, or reuse the existing one for a reminder (re-mint if absent).
      const token = (kind === 'REMINDER' && row.customerInfoToken) ? row.customerInfoToken : crypto.randomBytes(24).toString('hex');
      const link = `${portalBaseUrl()}/customer/precheckin?token=${token}`;
      const data = (kind === 'INVITE')
        ? { customerInfoToken: token, customerInfoTokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS), precheckinAutoInviteSentAt: now }
        : { ...(row.customerInfoToken ? {} : { customerInfoToken: token, customerInfoTokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS) }), precheckinAutoReminderSentAt: now };
      await prisma.reservation.update({ where: { id: row.id }, data });
      const brand = await brandFor(row.tenantId);
      const { subject, text, html } = buildInviteEmail(kind, { reservationNumber: row.reservationNumber, customerName, link, locale }, brand);
      await mailer.sendEmail({ to: email, subject, text, html });
      if (kind === 'INVITE') counts.invited += 1; else counts.reminded += 1;
    } catch (err) {
      counts.failed += 1;
      logger.warn?.('[precheckin-invite] send failed', { reservationId: row.id, kind, msg: err.message });
    }
  }

  logger.info?.('[precheckin-invite] sweep done', counts);
  return counts;
}

async function tick() {
  if (sweepInProgress) return;
  sweepInProgress = true;
  try {
    await runPrecheckinInviteSweep();
  } catch (err) {
    const logger = await getLogger();
    logger.warn?.('[precheckin-invite] tick error', { msg: err.message });
  } finally {
    sweepInProgress = false;
  }
}

export function startPrecheckinInviteScheduler() {
  if (!autoEnabled()) return;
  if (startupTimer || timer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
    timer = setInterval(tick, intervalMs());
  }, startupDelayMs());
}
export function stopPrecheckinInviteScheduler() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

export const _internal = { intervalMs, autoEnabled, buildInviteEmail };
