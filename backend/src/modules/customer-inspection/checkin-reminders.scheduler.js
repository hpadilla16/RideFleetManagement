/**
 * Customer CHECK-IN inspection D-1 reminder scheduler (Fase D, 2026-06-18).
 *
 * Periodic sweep that, the DAY BEFORE a rental's return, emails the customer a
 * self-inspection link (phase=CHECKIN) so check-in is fast and the agent doesn't
 * have to walk the car. Mirrors the interval-timer + overlap-guard + startup-delay
 * pattern of dealership-loaner/loaner-reminders.scheduler.js.
 *
 * Dedupe is at the DB level: customerInspectionService.sendCheckinInspection()
 * skips a reservation that already has a CHECKIN inspection, so re-running the
 * sweep (or restarts) never double-sends. Tenants without the customer-led
 * inspection setting are skipped (config checked once per tenant per sweep).
 *
 * Started from worker.js. Plan: doc/customer-inspection-plan-2026-06-11.md (Fase D).
 * ZERO money code.
 */

const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_STARTUP_DELAY_SECONDS = 150;

let timer = null;
let startupTimer = null;
let sweepInProgress = false;

let _prisma = null;
async function resolvePrisma() {
  if (_prisma) return _prisma;
  _prisma = (await import('../../lib/prisma.js')).prisma;
  return _prisma;
}

let _svc = null;
async function resolveService() {
  if (_svc) return _svc;
  _svc = (await import('./customer-inspection.service.js')).customerInspectionService;
  return _svc;
}

let _settings = null;
async function resolveSettings() {
  if (_settings) return _settings;
  _settings = (await import('../settings/settings.service.js')).settingsService;
  return _settings;
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
  return String(process.env.CHECKIN_INSPECTION_REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
}
function intervalMs() {
  const h = Number(process.env.CHECKIN_INSPECTION_REMINDERS_INTERVAL_HOURS || DEFAULT_INTERVAL_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_INTERVAL_HOURS) * 60 * 60 * 1000;
}
function startupDelayMs() {
  const s = Number(process.env.CHECKIN_INSPECTION_REMINDERS_STARTUP_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}

// [start, end) UTC for TOMORROW's calendar date in Florida (America/New_York).
function tomorrowFLWindowUtc(now = new Date()) {
  const tmr = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(tmr); // YYYY-MM-DD of "tomorrow" in FL
  const tzShort = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })
    .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value;
  const off = tzShort === 'EST' ? '-05:00' : '-04:00';
  const start = new Date(`${ymd}T00:00:00${off}`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

async function sweepOnce() {
  const log = await getLogger();
  const prisma = await resolvePrisma();
  const svc = await resolveService();
  const settings = await resolveSettings();
  const { start, end } = tomorrowFLWindowUtc();

  // Active rentals (out on rent) due back tomorrow (FL).
  const reservations = await prisma.reservation.findMany({
    where: { status: 'CHECKED_OUT', returnAt: { gte: start, lt: end } },
    select: { id: true, tenantId: true },
  });
  if (!reservations.length) {
    log.info('[checkin-reminders] no reservations returning tomorrow');
    return { scanned: 0, sent: 0, skipped: 0 };
  }

  // Resolve the customer-inspection setting once per tenant.
  const tenantEnabled = new Map();
  async function isEnabled(tenantId) {
    const key = tenantId || '__none__';
    if (tenantEnabled.has(key)) return tenantEnabled.get(key);
    let on = false;
    try { on = !!(await settings.getCustomerInspectionConfig({ tenantId: tenantId || undefined }))?.enabled; }
    catch { on = false; }
    tenantEnabled.set(key, on);
    return on;
  }

  let sent = 0; let skipped = 0;
  for (const r of reservations) {
    if (!(await isEnabled(r.tenantId))) { skipped += 1; continue; }
    try {
      const out = await svc.sendCheckinInspection({ reservationId: r.id });
      if (out?.alreadySent) skipped += 1; else sent += 1;
    } catch (e) {
      skipped += 1;
      // NO_CUSTOMER_EMAIL / DISABLED / etc. are expected per-reservation skips.
      log.warn('[checkin-reminders] skip', { reservationId: r.id, reason: e?.code || e?.message });
    }
  }
  log.info('[checkin-reminders] sweep done', { scanned: reservations.length, sent, skipped });
  return { scanned: reservations.length, sent, skipped };
}

async function guardedSweep() {
  if (sweepInProgress) return;
  sweepInProgress = true;
  try { await sweepOnce(); }
  catch (e) { (await getLogger()).error('[checkin-reminders] sweep error', { message: e?.message }); }
  finally { sweepInProgress = false; }
}

export async function startCheckinReminders() {
  const log = await getLogger();
  if (!autoEnabled()) { log.info('[checkin-reminders] disabled (CHECKIN_INSPECTION_REMINDERS_ENABLED=false)'); return; }
  if (timer || startupTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    guardedSweep();
    timer = setInterval(guardedSweep, intervalMs());
    if (timer.unref) timer.unref();
  }, startupDelayMs());
  if (startupTimer.unref) startupTimer.unref();
  log.info('[checkin-reminders] started', { intervalHours: intervalMs() / 3600000 });
}

export function stopCheckinReminders() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

// Exposed for tests / manual trigger.
export { sweepOnce as _sweepCheckinRemindersOnce };
