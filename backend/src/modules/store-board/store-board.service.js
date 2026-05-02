import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import { settingsService } from '../settings/settings.service.js';

/**
 * Action Board service.
 *
 * Two surfaces:
 *
 *   1. Public kiosk endpoint — `getBoardByToken({token, date, tz})`. The TV
 *      mounted in the store hits this every 30s; the URL token IS the auth
 *      (no JWT). Resolves the token, bumps lastSeenAt, returns the day's
 *      pickups + returns + tomorrow-AM peek for the location bound to the
 *      token.
 *
 *   2. Admin token CRUD — `mintToken`, `listTokens`, `revokeToken`. These
 *      are JWT-protected at the route layer; the service trusts the caller
 *      has been scope-checked already.
 *
 * Date / timezone handling:
 *   The kiosk knows its browser timezone (Intl.DateTimeFormat().resolvedOptions().timeZone)
 *   and sends `?date=YYYY-MM-DD&tz=America/Puerto_Rico`. The server uses
 *   that pair to compute the UTC range for "today" and "tomorrow morning"
 *   in the requested timezone. If tz is omitted, defaults to
 *   America/Puerto_Rico (current GoKar / Triangle tenants).
 *
 * Cache:
 *   The board response is cached for 10s per (tokenId, date, tz). With
 *   30s polling per kiosk and one kiosk per location, each TTL window
 *   serves at most 3 cache hits — but with 5 stores eventually polling
 *   different locations the cache layer provides clean isolation between
 *   them and keeps the door open for cross-worker sharing once Redis is
 *   enabled.
 *
 * Status mapping (UI-friendly labels):
 *   Pickups
 *     NEW, CONFIRMED        -> 'Confirmed'   (future scheduled pickup)
 *     CHECKED_OUT           -> 'Checked Out' (pickup completed)
 *     NO_SHOW               -> 'No-Show'     (alert; >threshold late, no contact)
 *   Returns
 *     CHECKED_OUT           -> 'Late' if returnAt < now
 *                              'Due Now' if returnAt within +/- 30m of now
 *                              'Scheduled' otherwise
 *     CHECKED_IN            -> 'Returned'   (return completed)
 */

const DEFAULT_TZ = 'America/Puerto_Rico';
// 10s cache. Kiosk polls every 30s, so a hot store with multiple TVs (or a
// supervisor refreshing) collapses to one DB read per 10s window.
const BOARD_TTL_MS = 10 * 1000;
// "Due Now" window — returns within this many minutes either side of now
// get a yellow Due-Now badge. Beyond +threshold it becomes Late.
const DUE_NOW_WINDOW_MS = 30 * 60 * 1000;
// Tomorrow-morning cutoff. Pickups between 00:00 and this hour the next
// day are surfaced under "Mañana AM" so afternoon staff can see what's
// coming first thing.
const TOMORROW_AM_END_HOUR = 12;

function generateToken() {
  // 24 random bytes -> 32 URL-safe base64 chars. Same shape as the addendum
  // signature token. Single-use? No — kiosk tokens are long-lived and used
  // every 30 seconds for the lifetime of the display.
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Compute the UTC instant for `localDate 00:00:00` in the given IANA timezone.
 * Used as the lower bound for "today" queries.
 *
 * Approach: format an arbitrary UTC instant in the target tz and read back
 * the offset, then apply it to the requested local midnight. Doing it via
 * Intl avoids pulling in moment-timezone for one helper.
 */
function localDateToUtcStart(localDate, tz) {
  // localDate is "YYYY-MM-DD" in the kiosk's local zone.
  // We want the UTC instant such that, when formatted in `tz`, it reads
  // YYYY-MM-DD 00:00:00.
  const [y, m, d] = String(localDate).split('-').map((s) => parseInt(s, 10));
  if (!y || !m || !d) throw new Error('Invalid date — expected YYYY-MM-DD');

  // Start with the assumption that the offset is zero, then iterate up to
  // 2 times to converge (DST transitions are the only reason we'd need
  // more than one pass). For non-DST zones (PR included) one pass is exact.
  let utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(new Date(utcGuess));
    const get = (type) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
    const seenY = get('year');
    const seenM = get('month');
    const seenD = get('day');
    const seenH = get('hour') === 24 ? 0 : get('hour'); // some envs return 24
    const seenMin = get('minute');
    const seenS = get('second');
    // How many ms is this off from the requested local midnight?
    const seenAsUtc = Date.UTC(seenY, seenM - 1, seenD, seenH, seenMin, seenS);
    const targetAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
    const offsetMs = seenAsUtc - targetAsUtc;
    if (offsetMs === 0) break;
    utcGuess -= offsetMs;
  }
  return new Date(utcGuess);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function deriveBoardStatus(reservation, now, side) {
  const status = String(reservation.status || '').toUpperCase();
  if (side === 'pickup') {
    if (status === 'NEW' || status === 'CONFIRMED') return 'Confirmed';
    if (status === 'CHECKED_OUT') return 'Checked Out';
    if (status === 'NO_SHOW') return 'No-Show';
    if (status === 'CANCELLED') return 'Cancelled';
    return status;
  }
  // returns side
  if (status === 'CHECKED_IN') return 'Returned';
  if (status === 'CHECKED_OUT') {
    const returnTime = new Date(reservation.returnAt).getTime();
    const diff = returnTime - now.getTime();
    if (diff < 0) return 'Late';
    if (diff <= DUE_NOW_WINDOW_MS) return 'Due Now';
    return 'Scheduled';
  }
  return status;
}

/**
 * Project a Prisma reservation row to the lean shape the kiosk renders.
 * Strips internal IDs the UI doesn't need and pre-computes the board
 * status so the frontend doesn't have to repeat the time-based logic.
 */
function shapeForBoard(reservation, now, side) {
  const customer = reservation.customer || {};
  const vehicle = reservation.vehicle || {};
  const customerName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Customer';
  const vehicleDesc = vehicle.year || vehicle.make || vehicle.model
    ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')
    : null;
  return {
    id: reservation.id,
    reservationNumber: reservation.reservationNumber,
    customerName,
    vehicle: vehicleDesc,
    plate: vehicle.plate || null,
    pickupAt: reservation.pickupAt,
    returnAt: reservation.returnAt,
    rawStatus: reservation.status,
    boardStatus: deriveBoardStatus(reservation, now, side)
  };
}

const reservationListSelect = {
  id: true,
  tenantId: true,
  reservationNumber: true,
  status: true,
  pickupAt: true,
  returnAt: true,
  pickupLocationId: true,
  returnLocationId: true,
  // Inline lean projections — matches the cost profile used by the
  // optimized list/page endpoints. No idPhotoUrl/insuranceDocumentUrl
  // to keep the row size small at scale.
  customer: {
    select: { firstName: true, lastName: true }
  },
  vehicle: {
    select: { year: true, make: true, model: true, plate: true }
  }
};

export const storeBoardService = {
  /**
   * Resolve a kiosk token and return the full board payload for the
   * day in the location's timezone.
   *
   * Throws if the token is missing, unknown, or revoked.
   */
  async getBoardByToken({ token, date, tz, now: nowOverride } = {}) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) {
      const err = new Error('Token is required');
      err.statusCode = 400;
      throw err;
    }
    const cleanTz = String(tz || DEFAULT_TZ).trim() || DEFAULT_TZ;

    // Resolve token (no cache — token rotation has to take effect immediately).
    const row = await prisma.storeBoardToken.findUnique({ where: { token: cleanToken } });
    if (!row) {
      const err = new Error('Invalid kiosk token');
      err.statusCode = 404;
      throw err;
    }
    if (row.revokedAt) {
      const err = new Error('Kiosk token has been revoked');
      err.statusCode = 403;
      throw err;
    }

    const now = nowOverride instanceof Date ? nowOverride : new Date();

    // If date wasn't provided, derive today in the requested timezone from
    // the server's idea of "now". Frontend will normally send it, but we
    // tolerate omission so a curl probe still works.
    const localDate = String(date || '').trim() || formatLocalDate(now, cleanTz);

    const cacheKey = `store-board:${row.id}:${localDate}:${cleanTz}`;
    return cache.getOrSet(cacheKey, async () => {
      // Bump lastSeenAt opportunistically — single fire-and-forget update.
      // Wrapped in catch so a transient DB blip doesn't fail the whole
      // board fetch (the kiosk would just see "last seen" stop advancing).
      prisma.storeBoardToken
        .update({ where: { id: row.id }, data: { lastSeenAt: now } })
        .catch(() => { /* swallow — informational column only */ });

      const todayStart = localDateToUtcStart(localDate, cleanTz);
      const tomorrowStart = addDays(todayStart, 1);
      const dayAfter = addDays(todayStart, 2);

      const tomorrowAmEnd = new Date(tomorrowStart);
      tomorrowAmEnd.setUTCHours(tomorrowAmEnd.getUTCHours() + TOMORROW_AM_END_HOUR);

      // Pull all rows we might need in two queries — one keyed on pickupAt,
      // one on returnAt. We could OR them in a single query, but separating
      // makes index usage predictable and the row counts are tiny per
      // location per day.
      // Pull data + tenant branding in parallel. The agreement settings
      // table is where companyName + companyLogoUrl live (per-tenant
      // overridable), so the kiosk header reuses the same brand the
      // customer sees on their printed contract — single source of truth
      // means the TV display matches the paperwork they just signed.
      const tenantScope = row.tenantId ? { tenantId: row.tenantId } : {};
      const [pickupsAll, returnsAll, location, tenantRow, brandCfg] = await Promise.all([
        prisma.reservation.findMany({
          where: {
            tenantId: row.tenantId,
            pickupLocationId: row.locationId,
            workflowMode: 'RENTAL', // Hector decision: rentals only, no Trip / car-sharing
            status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT', 'NO_SHOW'] },
            pickupAt: { gte: todayStart, lt: dayAfter }
          },
          orderBy: { pickupAt: 'asc' },
          select: reservationListSelect
        }),
        prisma.reservation.findMany({
          where: {
            tenantId: row.tenantId,
            returnLocationId: row.locationId,
            workflowMode: 'RENTAL',
            // Returns we care about: vehicles still in customer hands that
            // are due back today, plus those that already came back today.
            // Tomorrow's returns intentionally NOT shown here — Hector
            // confirmed the morning peek is for pickups only.
            status: { in: ['CHECKED_OUT', 'CHECKED_IN'] },
            returnAt: { gte: todayStart, lt: tomorrowStart }
          },
          orderBy: { returnAt: 'asc' },
          select: reservationListSelect
        }),
        prisma.location.findUnique({
          where: { id: row.locationId },
          select: { id: true, name: true, code: true, city: true, state: true }
        }),
        prisma.tenant.findUnique({
          where: { id: row.tenantId },
          select: { id: true, name: true, slug: true }
        }),
        // Pulls companyName / companyLogoUrl from the agreement settings
        // table. Falls back to {} if there's no record for this tenant
        // (the kiosk frontend has its own initials fallback).
        settingsService.getRentalAgreementConfig(tenantScope).catch(() => ({}))
      ]);

      // Split today's pickups vs tomorrow-AM peek by date boundary.
      const todayPickups = [];
      const tomorrowAmPickups = [];
      for (const r of pickupsAll) {
        const ts = new Date(r.pickupAt).getTime();
        if (ts < tomorrowStart.getTime()) {
          todayPickups.push(shapeForBoard(r, now, 'pickup'));
        } else if (ts < tomorrowAmEnd.getTime()) {
          tomorrowAmPickups.push(shapeForBoard(r, now, 'pickup'));
        }
        // Anything past tomorrowAmEnd is intentionally dropped from the
        // board — full day-2 view is out of scope.
      }

      const returns = returnsAll.map((r) => shapeForBoard(r, now, 'return'));

      // Roll-up counts the kiosk can render in the column-header chips
      // without re-counting client-side.
      const summary = {
        pickups: rollupPickups(todayPickups),
        returns: rollupReturns(returns)
      };

      // Brand display: prefer the agreement-config companyName (admins
      // sometimes set a customer-facing brand that differs from the legal
      // tenant name), fall back to Tenant.name, then to slug. Logo is
      // optional — frontend renders initials when it's missing.
      const tenantDisplay = {
        id: row.tenantId,
        name: brandCfg?.companyName || tenantRow?.name || tenantRow?.slug || 'Ride Fleet',
        logoUrl: brandCfg?.companyLogoUrl || null
      };

      return {
        generatedAt: now.toISOString(),
        date: localDate,
        timezone: cleanTz,
        tenant: tenantDisplay,
        location: location || { id: row.locationId },
        kiosk: { id: row.id, label: row.label },
        pickups: todayPickups,
        tomorrowAmPickups,
        returns,
        summary
      };
    }, BOARD_TTL_MS);
  },

  // ─────── Admin token CRUD ────────────────────────────────────────────

  async mintToken({ tenantId, locationId, label, createdBy }) {
    if (!tenantId) throw new Error('tenantId is required');
    if (!locationId) throw new Error('locationId is required');
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel) throw new Error('label is required');

    // Verify the location belongs to this tenant — defense in depth so an
    // admin-tier user with one tenant can't mint a token against another
    // tenant's location even via a hand-rolled API call.
    const location = await prisma.location.findFirst({
      where: { id: locationId, tenantId }
    });
    if (!location) {
      const err = new Error('Location not found in this tenant');
      err.statusCode = 404;
      throw err;
    }

    // Retry up to 3 times on the (extremely unlikely) collision on the
    // unique token index. 24 random bytes → P(collision) ≈ 2^-192 per
    // mint, but the loop costs nothing.
    let attempts = 0;
    let lastErr = null;
    while (attempts < 3) {
      try {
        return await prisma.storeBoardToken.create({
          data: {
            tenantId,
            locationId,
            label: cleanLabel,
            token: generateToken(),
            createdBy: createdBy || null
          }
        });
      } catch (err) {
        lastErr = err;
        attempts++;
      }
    }
    throw lastErr || new Error('Failed to mint kiosk token');
  },

  async listTokens({ tenantId, includeRevoked = false } = {}) {
    if (!tenantId) throw new Error('tenantId is required');
    return prisma.storeBoardToken.findMany({
      where: {
        tenantId,
        ...(includeRevoked ? {} : { revokedAt: null })
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  async revokeToken({ id, tenantId }) {
    if (!id) throw new Error('id is required');
    if (!tenantId) throw new Error('tenantId is required');
    const existing = await prisma.storeBoardToken.findFirst({
      where: { id, tenantId }
    });
    if (!existing) {
      const err = new Error('Kiosk token not found');
      err.statusCode = 404;
      throw err;
    }
    if (existing.revokedAt) return existing; // idempotent
    return prisma.storeBoardToken.update({
      where: { id },
      data: { revokedAt: new Date() }
    });
  }
};

// ─────── Helpers ───────────────────────────────────────────────────────

function rollupPickups(items) {
  const counts = { confirmed: 0, ready: 0, inProgress: 0, checkedOut: 0, noShow: 0, cancelled: 0 };
  for (const it of items) {
    switch (it.boardStatus) {
      case 'Confirmed': counts.confirmed++; break;
      case 'Checked Out': counts.checkedOut++; break;
      case 'No-Show': counts.noShow++; break;
      case 'Cancelled': counts.cancelled++; break;
      default: break;
    }
  }
  return counts;
}

function rollupReturns(items) {
  const counts = { scheduled: 0, dueNow: 0, late: 0, returned: 0 };
  for (const it of items) {
    switch (it.boardStatus) {
      case 'Scheduled': counts.scheduled++; break;
      case 'Due Now':   counts.dueNow++;    break;
      case 'Late':      counts.late++;      break;
      case 'Returned':  counts.returned++;  break;
      default: break;
    }
  }
  return counts;
}

/**
 * Format a UTC `Date` as YYYY-MM-DD in the given IANA timezone.
 * Used when the kiosk omits `?date=` and we need to derive today.
 */
function formatLocalDate(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}
