/**
 * Operating-hours evaluation for a Location, in the LOCATION's wall clock.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS FOR (found live 2026-08-26)
 *
 * The reservation wizard rejected a 5:53 PM pickup at a location whose hours
 * are 08:00–18:00. The old check lived inline in reservations.service.js and
 * read the instant with `date.getHours()` / `date.getDay()` /
 * `date.toISOString().slice(0,10)` — i.e. in the SERVER's timezone, which is
 * UTC inside the backend container. A 5:53 PM Puerto-Rico pickup is stored as
 * 21:53Z, so `getHours()` returned 21, 21:53 > 18:00, and a perfectly ordinary
 * booking was refused. The same arithmetic silently moved the weekday and the
 * closed-date lookup for every evening booking west of UTC.
 *
 * Everything here is PURE — no Prisma, no settings lookup — so the regression
 * test runs in the DB-free chain. The caller resolves the timezone (location
 * config → tenant setting → default) and hands it in.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { DEFAULT_TENANT_TIMEZONE } from './date-utils.js';

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Read an instant's wall clock in `tz`: the calendar day, the weekday index
 * (0=Sunday, matching Date#getDay and cfg.closedWeekdays), and minutes since
 * local midnight.
 *
 * Falls back to the UTC reading only for an unknown IANA name — that is a
 * misconfiguration, and guessing a different offset would hide it.
 */
export function wallClockInTz(date, tz = DEFAULT_TENANT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || DEFAULT_TENANT_TIMEZONE,
      weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    }).formatToParts(d).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  } catch {
    return {
      ymd: d.toISOString().slice(0, 10),
      weekday: d.getUTCDay(),
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }
  // Intl renders local midnight as hour "24" in some ICU versions.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const minute = Number(parts.minute);
  const weekdayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday));
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: weekdayIdx >= 0 ? weekdayIdx : 0,
    minutes: hour * 60 + minute,
    hour,
    minute,
  };
}

/** "HH:MM" → minutes since midnight, or null when unparseable/absent. */
function toMinutes(value) {
  if (!value) return null;
  const [h, m] = String(value).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * The open/close window that applies on `weekday`, honoring the per-day
 * `weeklyHours` override and falling back to the flat operations window.
 * Behavior is byte-for-byte the pre-move `resolveHoursForDate`, only the
 * weekday now comes from the location's clock instead of the server's.
 */
export function resolveHoursForWeekday(cfg, weekday) {
  const weekly = cfg?.weeklyHours?.[DAY_KEYS[weekday]];
  if (weekly && typeof weekly === 'object') {
    return {
      closed: weekly.enabled === false,
      openTime: weekly.open || cfg?.operationsOpenTime,
      closeTime: weekly.close || cfg?.operationsCloseTime,
    };
  }
  return {
    closed: false,
    openTime: cfg?.operationsOpenTime,
    closeTime: cfg?.operationsCloseTime,
  };
}

/** 12-hour label for an error message: 1073 → "5:53 PM". */
export function formatLocalTime(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Can a reservation start or end at `at` for a location with `cfg`, evaluated
 * in `tz`?
 *
 * @returns {{
 *   ok: boolean,
 *   reason: null | 'CLOSED' | 'OUTSIDE_HOURS',
 *   ymd: string, timeZone: string, localTime: string,
 *   openTime: string|null, closeTime: string|null,
 * }}
 *
 * `cfg.allowOutsideHours` still waives the window check (never the closed-day
 * check) — unchanged.
 */
export function evaluateLocationWindow(cfg, at, tz = DEFAULT_TENANT_TIMEZONE) {
  const timeZone = tz || DEFAULT_TENANT_TIMEZONE;
  const clock = wallClockInTz(at, timeZone);
  // Unparseable instant: no opinion. The date validation upstream owns that.
  if (!clock) return { ok: true, reason: null, ymd: '', timeZone, localTime: '', openTime: null, closeTime: null };

  const day = resolveHoursForWeekday(cfg, clock.weekday);
  const base = {
    ymd: clock.ymd,
    timeZone,
    localTime: formatLocalTime(clock.minutes),
    openTime: day.openTime || null,
    closeTime: day.closeTime || null,
  };

  const closedWeekdays = Array.isArray(cfg?.closedWeekdays) ? cfg.closedWeekdays : [];
  const closedDates = Array.isArray(cfg?.closedDates) ? cfg.closedDates : [];
  if (closedWeekdays.includes(clock.weekday) || closedDates.includes(clock.ymd) || day.closed) {
    return { ...base, ok: false, reason: 'CLOSED' };
  }

  if (cfg?.allowOutsideHours) return { ...base, ok: true, reason: null };

  const openMins = toMinutes(day.openTime);
  const closeMins = toMinutes(day.closeTime);
  // A half-configured window is not a window — same permissive fallback the
  // inline isOutsideHours had.
  if (openMins === null || closeMins === null) return { ...base, ok: true, reason: null };

  if (clock.minutes < openMins || clock.minutes > closeMins) {
    return { ...base, ok: false, reason: 'OUTSIDE_HOURS' };
  }
  return { ...base, ok: true, reason: null };
}
