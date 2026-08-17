/**
 * Shuttle tracker link invites — the IO half (worker only).
 *
 * Sweeps every ~15 minutes: reservations picking up within LINK_LEAD_HOURS at
 * a location whose tracker is ON, that have never had a link, get one minted
 * and delivered by email AND SMS (Hector, 2026-08-15). Decisions live in
 * shuttle-link-invite.js; house scheduler rules apply (overlap guard, startup
 * delay, fail-open per reservation).
 *
 * DELIVERY RULE: the link row is minted first (it is the dedupe anchor), then
 * both channels are attempted. Email failing is tolerated if SMS went out and
 * vice versa — but if NEITHER was delivered, the link row is deleted so the
 * next sweep retries instead of leaving a customer with a link that exists
 * only in the database. SMS being unconfigured for a tenant is normal, not an
 * error: most tenants are email-only until they add provider creds.
 *
 * NATURALLY INERT: no tenant has a ShuttleTrackerConfig with mode != OFF until
 * the fase-4 settings UI ships, so this sweep no-ops in production today. No
 * feature flag needed — the config rows ARE the flag.
 */
import crypto from 'crypto';
import { resolveEmailBrand } from '../../lib/email-template.js';
import {
  LINK_LEAD_HOURS, linkExpiresAt, pickCandidates, reachable,
  buildLinkEmail, buildLinkSms,
} from './shuttle-link-invite.js';

const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_STARTUP_DELAY_SECONDS = 120;

let timer = null;
let startupTimer = null;
let sweepInProgress = false;

let _prisma = null;
async function resolveDefaultPrisma() {
  if (_prisma) return _prisma;
  _prisma = (await import('../../lib/prisma.js')).prisma;
  return _prisma;
}
let _mailer = null;
async function resolveDefaultMailer() {
  if (_mailer) return _mailer;
  const mod = await import('../../lib/mailer.js');
  _mailer = { sendEmail: mod.sendEmail };
  return _mailer;
}
let _smsSend = null;
async function resolveDefaultSms() {
  if (_smsSend) return _smsSend;
  const mod = await import('../sms/sms.service.js');
  _smsSend = (args) => mod.smsService.sendCustom(args);
  return _smsSend;
}
let _logger = null;
async function getLogger() {
  if (_logger) return _logger;
  try {
    const mod = await import('../../lib/logger.js');
    _logger = mod.default || mod;
  } catch { _logger = { info: () => {}, warn: () => {}, error: () => {} }; }
  return _logger;
}

function enabled() {
  return String(process.env.SHUTTLE_LINK_INVITES_ENABLED || 'true').toLowerCase() !== 'false';
}
function intervalMs() {
  const m = Number(process.env.SHUTTLE_LINK_INVITES_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES);
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
}
function startupDelayMs() {
  const s = Number(process.env.SHUTTLE_LINK_INVITES_STARTUP_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}
function trackerBaseUrl() {
  return (process.env.SHUTTLE_TRACKER_BASE_URL
    || process.env.CUSTOMER_PORTAL_BASE_URL
    || process.env.APP_BASE_URL
    || process.env.FRONTEND_BASE_URL
    || 'http://localhost:3000').replace(/\/$/, '');
}

/** One sweep. Deps injectable for tests: { prisma, mailer, smsSend, now, resolveBrand }. */
export async function runShuttleLinkInviteSweep(deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  const mailer = deps.mailer || (await resolveDefaultMailer());
  const smsSend = deps.smsSend || (await resolveDefaultSms());
  const resolveBrand = deps.resolveBrand || resolveEmailBrand;
  const now = deps.now ? deps.now() : new Date();
  const logger = await getLogger();

  const counts = {
    trackedLocations: 0, candidates: 0, invited: 0,
    emailed: 0, smsed: 0, skippedNoContact: 0, deduped: 0, failed: 0,
  };

  // The config rows are the feature flag: no ON location, nothing to do.
  const configs = await prisma.shuttleTrackerConfig.findMany({
    where: { mode: { not: 'OFF' } },
    select: { locationId: true, tenantId: true },
  });
  counts.trackedLocations = configs.length;
  if (!configs.length) return counts;

  const windowEnd = new Date(now.getTime() + LINK_LEAD_HOURS * 3600_000);
  const rows = await prisma.reservation.findMany({
    where: {
      status: { in: ['NEW', 'CONFIRMED'] },
      pickupAt: { gt: now, lte: windowEnd },
      pickupLocationId: { in: configs.map((c) => c.locationId) },
    },
    select: {
      id: true, tenantId: true, reservationNumber: true, pickupAt: true, returnAt: true,
      customer: { select: { firstName: true, lastName: true, email: true, phone: true, locale: true } },
      pickupLocation: { select: { name: true } },
    },
    take: 500,
  });
  counts.candidates = rows.length;
  if (!rows.length) return counts;

  const existing = await prisma.shuttleTrackerLink.findMany({
    where: { reservationId: { in: rows.map((r) => r.id) } },
    select: { reservationId: true },
  });
  const fresh = pickCandidates(rows, existing.map((l) => l.reservationId));
  counts.deduped = rows.length - fresh.length;

  const brandCache = new Map();
  const brandFor = async (tenantId) => {
    if (brandCache.has(tenantId)) return brandCache.get(tenantId);
    let b; try { b = await resolveBrand({ tenantId }); } catch { b = undefined; }
    brandCache.set(tenantId, b); return b;
  };

  for (const row of fresh) {
    if (!reachable(row.customer)) { counts.skippedNoContact += 1; continue; }
    let minted = null;
    try {
      const token = crypto.randomBytes(24).toString('base64url');
      minted = await prisma.shuttleTrackerLink.create({
        data: {
          tenantId: row.tenantId,
          reservationId: row.id,
          token,
          expiresAt: linkExpiresAt(row, now),
        },
      });
      const link = `${trackerBaseUrl()}/shuttle/${token}`;
      const customerName = `${row.customer?.firstName || ''} ${row.customer?.lastName || ''}`.trim() || 'Customer';
      const locale = row.customer?.locale;
      const locationName = row.pickupLocation?.name || '';

      let emailed = false;
      const email = String(row.customer?.email || '').trim();
      if (email) {
        try {
          const brand = await brandFor(row.tenantId);
          const msg = buildLinkEmail({
            reservationNumber: row.reservationNumber, customerName, link, locale, locationName,
          }, brand);
          await mailer.sendEmail({ tenantId: row.tenantId, to: email, ...msg });
          emailed = true;
          counts.emailed += 1;
        } catch (err) {
          logger.warn?.('[shuttle-link-invite] email failed', { reservationId: row.id, msg: err.message });
        }
      }

      let smsed = false;
      const phone = String(row.customer?.phone || '').trim();
      if (phone) {
        try {
          const brand = await brandFor(row.tenantId);
          await smsSend({
            to: phone,
            body: buildLinkSms({ link, locale, locationName, companyName: brand?.companyName }),
            tenantId: row.tenantId,
          });
          smsed = true;
          counts.smsed += 1;
        } catch (err) {
          // "SMS is not configured for this tenant" lands here — expected, not
          // an incident; email is the floor, SMS is the bonus channel.
          logger.info?.('[shuttle-link-invite] sms not sent', { reservationId: row.id, msg: err.message });
        }
      }

      if (!emailed && !smsed) {
        // Nobody got the link — un-mint so the next sweep retries instead of
        // permanently deduping on a row the customer never saw.
        await prisma.shuttleTrackerLink.delete({ where: { id: minted.id } }).catch(() => {});
        counts.failed += 1;
        continue;
      }
      counts.invited += 1;
    } catch (err) {
      if (minted) await prisma.shuttleTrackerLink.delete({ where: { id: minted.id } }).catch(() => {});
      counts.failed += 1;
      logger.warn?.('[shuttle-link-invite] invite failed', { reservationId: row.id, msg: err.message });
    }
  }

  logger.info?.('[shuttle-link-invite] sweep done', counts);
  return counts;
}

async function tick() {
  if (sweepInProgress) return;
  sweepInProgress = true;
  try {
    await runShuttleLinkInviteSweep();
  } catch (err) {
    (await getLogger()).warn?.('[shuttle-link-invite] tick error', { msg: err.message });
  } finally {
    sweepInProgress = false;
  }
}

export function startShuttleLinkInviteScheduler() {
  if (!enabled()) return;
  if (startupTimer || timer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
    timer = setInterval(tick, intervalMs());
  }, startupDelayMs());
}
export function stopShuttleLinkInviteScheduler() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

export const _internal = { intervalMs, enabled, trackerBaseUrl };
