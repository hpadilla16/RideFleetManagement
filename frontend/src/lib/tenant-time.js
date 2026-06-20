/**
 * Frontend tenant-timezone helpers.
 *
 * Mirror of the backend behavior in `backend/src/lib/date-utils.js`:
 * the canonical storage shape is UTC, and we present and edit values
 * as wall-clock time in the tenant's configured timezone (default
 * America/Puerto_Rico — Puerto Rico does not observe DST).
 *
 * Why both sides need this:
 *   - `<input type="datetime-local">` produces and consumes naive
 *     "YYYY-MM-DDTHH:mm" strings. Plain `new Date(value).toISOString()`
 *     converts via the BROWSER timezone, which is correct on a staff
 *     laptop in PR but breaks for remote agents (or for anybody loading
 *     the page from a non-PR timezone).
 *   - `Date.toLocaleString()` also uses the browser timezone.
 *
 * These helpers ignore the browser timezone entirely and always work in
 * the tenant timezone passed in.
 */

export const DEFAULT_TENANT_TIMEZONE = 'America/Puerto_Rico';

/**
 * "YYYY-MM-DD" for a date in the tenant timezone, RESILIENT to a broken
 * Intl.DateTimeFormat. Some browsers / extensions monkeypatch Intl and break
 * `formatToParts` ("called on incompatible receiver"), which — when this runs
 * during render — used to crash the whole page (Sentry NEXTJSFRONTEND-T,
 * 2026-06-20). On any failure we fall back to the UTC date so one bad browser
 * can't take down the dashboard. Returns null for an invalid/empty value.
 */
export function tenantDayKey(value, tenantTz = DEFAULT_TENANT_TIMEZONE) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tenantTz,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    if (parts.year && parts.month && parts.day) {
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
  } catch {
    /* broken Intl — fall through to the UTC fallback below */
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Format a UTC datetime (Date, ISO string, etc.) as the
 * "YYYY-MM-DDTHH:mm" wall-clock string a `<input type="datetime-local">`
 * expects, interpreted in the tenant's timezone.
 *
 * Used when populating form inputs from a backend value so the agent
 * sees the time they originally typed (e.g. 11:19 AM) rather than the
 * raw UTC instant (15:19).
 */
export function utcToTenantLocalInput(value, tenantTz = DEFAULT_TENANT_TIMEZONE) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tenantTz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false
    }).formatToParts(d).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  } catch {
    return '';
  }
  // Some locales render midnight as hour="24" — clamp to "00".
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/**
 * Convert a naive wall-clock string from a `<input type="datetime-local">`
 * into an ISO UTC string, interpreting the input as the tenant's local
 * timezone.
 *
 * Inputs that already carry a Z or numeric offset are returned through
 * `new Date()` unchanged — that matches the backend `parseDateTimeInTz`
 * contract so explicit-TZ payloads keep working.
 */
const ISO_DATETIME_WITH_TZ = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

export function tenantLocalInputToUtcIso(value, tenantTz = DEFAULT_TENANT_TIMEZONE) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  if (!s) return null;

  if (ISO_DATETIME_WITH_TZ.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const m = s.match(NAIVE_ISO_DATETIME);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const [, yStr, monStr, dStr, hStr, miStr, seStr] = m;
  const Y = Number(yStr);
  const M = Number(monStr);
  const D = Number(dStr);
  const h = hStr ? Number(hStr) : 0;
  const mi = miStr ? Number(miStr) : 0;
  const se = seStr ? Number(seStr) : 0;

  const probeUtc = new Date(Date.UTC(Y, M - 1, D, h, mi, se, 0));
  if (Number.isNaN(probeUtc.getTime())) return null;

  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tenantTz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(probeUtc).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  } catch {
    return probeUtc.toISOString();
  }
  const tzHour = parts.hour === '24' ? '0' : parts.hour;
  const tzRendered = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(tzHour),
    Number(parts.minute),
    Number(parts.second)
  ));
  const offsetMs = probeUtc.getTime() - tzRendered.getTime();
  return new Date(probeUtc.getTime() + offsetMs).toISOString();
}

/**
 * Display a UTC datetime as a human-readable wall-clock string in the
 * tenant's timezone. Replaces ad-hoc `new Date(x).toLocaleString()` calls
 * so the rendering is independent of the browser timezone.
 */
export function formatTenantWallClock(value, tenantTz = DEFAULT_TENANT_TIMEZONE, options = {}) {
  if (value == null || value === '') return '-';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-US', {
    timeZone: tenantTz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...options
  });
}
