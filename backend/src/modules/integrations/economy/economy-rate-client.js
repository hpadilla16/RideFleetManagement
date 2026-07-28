/**
 * RezLight rate-portal client (2026-07-28). The TRANSPORT half of the outbound
 * rate push: read the rate grid, write values, read them back. All decisions
 * live in economy-rate-map.js; this module only talks to the portal.
 *
 * Contract discovered by recon + proven by a live canary (see the memory doc
 * economy-rate-push-contract):
 *   page      /RezAlliance/RateIntegration        (anti-CSRF token source)
 *   read      .../LoadRateIntegrationGridDisplayData
 *   write     .../ApplyRates
 * Every field value is JSON.stringify'd — including single strings — and the
 * grid is keyed per CALENDAR DATE (7 day-columns from the selected date).
 *
 * DANGER: ApplyRates answers {"success":true,"message":"The rates have been
 * updated."} EVEN WHEN IT SILENTLY IGNORES THE VALUE (verified 2026-07-28:
 * writing "" to clear a cell reported success and changed nothing). Callers
 * MUST re-read with readRateGrid and compare — never trust the response body.
 */
import { authedFetch, scrapeVerificationToken } from './economy.service.js';

const RATE_PAGE = '/RezAlliance/RateIntegration';
const BASE = '/RezAlliance/RateIntegration/';
export const ENDPOINTS = Object.freeze({
  display: 'LoadRateIntegrationGridDisplayData',
  edit: 'LoadRateIntegrationGridEditData',
  apply: 'ApplyRates',
});
const ALL_DAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

export class EconomyRatePortalError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'EconomyRatePortalError'; this.status = status; }
}

/** yyyy-mm-dd -> the noon-UTC ISO the portal's date pickers emit. */
export function toPortalDate(isoDate) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))
    ? new Date(`${isoDate}T12:00:00Z`)
    : new Date(isoDate);
  if (!Number.isFinite(d.valueOf())) throw new EconomyRatePortalError(`invalid date: ${isoDate}`);
  return d.toISOString();
}

/** mm/dd/yy (portal grid header) -> yyyy-mm-dd. */
export function headerToIsoDate(header) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(String(header || '').trim());
  if (!m) return null;
  return `20${m[3]}-${m[1]}-${m[2]}`;
}

async function fetchToken(tenantId, deps) {
  if (deps.token) return deps.token;
  const res = await (deps.authedFetch || authedFetch)(tenantId, RATE_PAGE);
  const html = res.status < 400 ? await res.text() : '';
  const token = (deps.scrapeToken || scrapeVerificationToken)(html);
  if (!token) throw new EconomyRatePortalError('anti-CSRF token not found on the rate page');
  return token;
}

async function portalPost(tenantId, endpoint, fields, deps = {}) {
  const token = await fetchToken(tenantId, deps);
  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', token);
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const res = await (deps.authedFetch || authedFetch)(tenantId, `${BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' },
    body: body.toString(),
  });
  const text = await res.text();
  if (res.status >= 400) throw new EconomyRatePortalError(`${endpoint} HTTP ${res.status}`, res.status);
  return text;
}

/**
 * Parse a display-grid HTML fragment into { classes, dates, grid }.
 * grid = { CLASS: { 'yyyy-mm-dd': '20.00' | '' } }. Exported for tests.
 */
export function parseRateGrid(html) {
  const text = String(html || '');
  const headers = [...text.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // Header row is [ALL, mm/dd/yy x7]; only the dated columns are addressable.
  const dates = headers.map(headerToIsoDate);
  const grid = {};
  const classes = [];
  for (const row of text.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cls = (row[1].match(/class="class-items"><input[^>]*value="([^"]+)"/) || [, null])[1];
    if (!cls) continue;
    classes.push(cls);
    // Row shape: one button cell (the class) + one text cell per dated column.
    // The leading "ALL" header labels the class column, so after dropping the
    // undated headers the Nth date lines up with the Nth text input.
    const values = [...row[1].matchAll(/type="text"[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    const dateCols = dates.filter(Boolean);
    const perDate = {};
    dateCols.forEach((iso, i) => { perDate[iso] = values[i] === undefined ? '' : values[i]; });
    grid[cls] = perDate;
  }
  return { classes, dates: dates.filter(Boolean), grid };
}

/**
 * Read the current daily grid for one location, starting at `startDate`
 * (the portal returns that day plus the following six).
 */
export async function readRateGrid(tenantId, {
  provider, location, rate = 'STND', sysGroup = 'ALL', startDate, plan = 'DY',
}, deps = {}) {
  const html = await portalPost(tenantId, ENDPOINTS.display, {
    provider: JSON.stringify(String(provider)),
    location: JSON.stringify(String(location)),
    rate: JSON.stringify(String(rate)),
    sysGroup: JSON.stringify(String(sysGroup)),
    displaySelectedDate: JSON.stringify(toPortalDate(startDate)),
    plan: JSON.stringify(String(plan)),
    selectedClasses: JSON.stringify([]),
  }, deps);
  return parseRateGrid(html);
}

/**
 * Write ONE (class, date) daily value. Deliberately narrow: the portal applies
 * `currentData` across every selected location/rate/day, so a wide selection
 * would fan a single mistake across the whole calendar. One cell per call
 * keeps every write individually auditable and individually verifiable.
 *
 * Returns the raw response — which CANNOT be trusted; verify with readRateGrid.
 */
export async function applyRateCell(tenantId, {
  provider, location, rate = 'STND', sysGroup = 'ALL',
  classCode, rateDate, dailyValue, plan = 'DY',
}, deps = {}) {
  const value = Number(dailyValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new EconomyRatePortalError(`refusing to publish a non-positive value for ${classCode} ${rateDate}`);
  }
  const iso = toPortalDate(rateDate);
  const raw = await portalPost(tenantId, ENDPOINTS.apply, {
    provider: JSON.stringify(String(provider)),
    sysGroup: JSON.stringify(String(sysGroup)),
    selectedLocations: JSON.stringify([String(location)]),
    selectedRates: JSON.stringify([String(rate)]),
    selectedDays: JSON.stringify([...ALL_DAYS]),
    selectedClasses: JSON.stringify([String(classCode)]),
    selectedPlans: JSON.stringify([String(plan)]),
    startDate: JSON.stringify(iso),
    endDate: JSON.stringify(iso),
    currentData: JSON.stringify([{
      carclass: String(classCode),
      dailyValue: value.toFixed(2),
      weeklyValue: '', monthlyValue: '', weekendValue: '', extradayValue: '', holidayValue: '',
    }]),
  }, deps);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* portal may answer HTML on error */ }
  return { raw, claimedSuccess: !!parsed?.success, message: parsed?.message || null };
}
