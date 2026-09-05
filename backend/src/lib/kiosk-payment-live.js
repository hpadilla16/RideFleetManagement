/**
 * Is kiosk payment LIVE — for a transaction, and for a person's counter?
 *
 * Pure, dependency-free on purpose: auth.service.js builds /api/auth/me from
 * it, and auth is the lowest layer — it must not pull the kiosk feature module
 * (prisma, logger, KioskError) into its boot chain. The kiosk payment guard
 * imports the same functions, so the guard and the /me flag can never disagree
 * about what "live" means.
 */

const envFlag = (name) => String(process.env[name] || '').toLowerCase() === 'true';
const envList = (name) => String(process.env[name] || '').split(',').map((v) => v.trim()).filter(Boolean);

/**
 * The ENVIRONMENT half of the gate — kill switch, prod double key, expiry
 * window — as a reason string, or null when it is open.
 */
export function kioskPaymentEnvGateReason(now = Date.now()) {
  // 1 + 2 — kill switch, with a production double key.
  if (!envFlag('KIOSK_PAYMENT_LIVE')) return 'FLAG_OFF';
  if (process.env.NODE_ENV === 'production' && !envFlag('KIOSK_PAYMENT_LIVE_ALLOW_PROD')) return 'PROD_DOUBLE_KEY_MISSING';
  // 6 — auto-expiring flag: an ISO timestamp past which the switch self-disables.
  const until = String(process.env.KIOSK_PAYMENT_LIVE_UNTIL || '').trim();
  if (!until) return 'NO_EXPIRY_SET';
  const untilTs = new Date(until).getTime();
  if (!Number.isFinite(untilTs)) return 'BAD_EXPIRY';
  if (now > untilTs) return 'WINDOW_EXPIRED';
  return null;
}

export const kioskPaymentLocationAllowlist = () => envList('KIOSK_PAYMENT_LOCATION_ALLOWLIST');

/**
 * Live at one of THESE locations? Gate open AND the allowlist names one of
 * them. For a SCOPED person this is the whole answer. For an UNSCOPED person
 * (no locationIds) use kioskPaymentLiveForUser, which knows the tenant.
 * Fail-closed on every branch: no allowlist, no live.
 */
export function kioskPaymentLiveForLocations(locationIds = [], now = Date.now()) {
  if (kioskPaymentEnvGateReason(now)) return false;
  const allowed = kioskPaymentLocationAllowlist();
  if (!allowed.length) return false;
  const mine = (Array.isArray(locationIds) ? locationIds : []).map((v) => String(v)).filter(Boolean);
  if (!mine.length) return true; // caller vouches the person sees every location (SUPER_ADMIN)
  return mine.some((id) => allowed.includes(id));
}

/**
 * Live at THIS person's counter — the /api/auth/me answer.
 *
 * The allowlist is ONE env var for every tenant, so an unscoped tenant ADMIN
 * must be checked against their OWN tenant's locations, or Zezgo would see
 * "live" the day International's counter is allowlisted (Innovation,
 * 2026-09-05). The query runs only when the gate is open, the allowlist is
 * non-empty, the person is unscoped and has a tenant — zero cost while the
 * switch is off, and a SUPER_ADMIN (no tenant) never touches the database
 * here. `deps.prisma` is injectable for tests.
 */
export async function kioskPaymentLiveForUser({ tenantId = null, locationIds = [] } = {}, deps = {}) {
  if (kioskPaymentEnvGateReason()) return false;
  const allowed = kioskPaymentLocationAllowlist();
  if (!allowed.length) return false;
  const mine = (Array.isArray(locationIds) ? locationIds : []).map((v) => String(v)).filter(Boolean);
  if (mine.length) return mine.some((id) => allowed.includes(id));
  if (!tenantId) return true; // SUPER_ADMIN: every tenant, every location
  const prisma = deps.prisma || (await import('./prisma.js')).prisma;
  const rows = await prisma.location.findMany({ where: { tenantId, id: { in: allowed } }, select: { id: true } });
  return rows.length > 0;
}
