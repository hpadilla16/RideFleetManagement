/**
 * Flexways (MobilityPS) back-office client.
 *
 * All network / browser I/O against system.mobilityps.com lives here so the
 * worker, scheduler and routes stay thin and testable.
 *
 * Public API:
 *   - setCredentials(tenantId, {username, password}, userId) → encrypts + upserts
 *   - getCredentials(tenantId)                               → { username, password }
 *   - ensureSession(tenantId)                                → seeds the cookie jar (auto-login)
 *   - forceRelogin(tenantId)                                 → discard jar + re-login now
 *   - fetchReservationList(tenantId, {idSede, from, to})     → [normalizedRow, ...]
 *   - testAuth(tenantId)                                     → { ok, status }
 *
 * AUTHENTICATION (autonomous, patrón TL_INTERNATIONAL — no human step):
 *   Flexways guards its login <form> with reCAPTCHA v3 (invisible, score-based).
 *   v3 is NOT a challenge to solve — it scores the request by behavior. So we
 *   drive the REAL login page in the shared headless Chromium (`withPage()`): fill
 *   usuario/clave, submit, and let the page's OWN grecaptcha issue its token. We
 *   never call, forge or bypass a captcha; captcha-solving services are PROHIBITED
 *   and unnecessary. On success we harvest the session cookie(s) into an in-memory
 *   per-tenant jar (same shape as NU). The grid is then read over plain fetch with
 *   that cookie; a bounce back to login triggers a single silent re-login.
 *
 * PROXY (optional): if FLEXWAYS_PROXY_URL is set, grid fetches egress through a
 *   residential proxy (same mitigation as TL_INTERNATIONAL_PROXY_URL) in case v3
 *   scores the datacenter IP low. Unset → the droplet's own egress. The headless
 *   LOGIN uses the shared singleton browser (unproxied) per the build spec; if the
 *   live PoC shows the login itself is scored low from the datacenter IP, a
 *   dedicated proxied browser (à la getTLBrowser) is the follow-up — flagged in
 *   the plan, not implemented here.
 *
 * See doc/flexways-integration-plan-2026-07-13.md
 */

import { ProxyAgent } from 'undici';
import logger from '../../../lib/logger.js';
import { parseDateTimeInTz } from '../../../lib/date-utils.js';
import { withPage } from '../../../lib/puppeteer-browser.js';
import {
  AuthExpiredError,
  createCredentialStore,
  makePickUserAgent,
  randomDelay,
  sleep,
} from '../booking-source/http-common.js';
import {
  SOURCE_SYSTEM,
  BASE_URL,
  LOGIN_PATH,
  LIST_PATH,
  LOGIN_USER_FIELD,
  LOGIN_PASS_FIELD,
  LOGIN_SUBMIT_SELECTOR,
  TIME_ZONE,
  COL,
  EXPECTED_COLUMN_COUNT,
  toIsoFromLatam,
} from './flexways.constants.js';

export { SOURCE_SYSTEM, BASE_URL, randomDelay, sleep };

// ---------------------------------------------------------------------------
// Source-specific auth-expired signal (keeps its own name for instanceof /
// Sentry grouping, per the shared AuthExpiredError contract).
// ---------------------------------------------------------------------------
export class FlexwaysAuthExpiredError extends AuthExpiredError {
  constructor(message = 'Flexways (MobilityPS) session expired or invalid') {
    super(message);
    this.name = 'FlexwaysAuthExpiredError';
  }
}

// Stealth: rotate UA per run, pinnable via FLEXWAYS_USER_AGENT (shared pool).
export const pickUserAgent = makePickUserAgent('FLEXWAYS_USER_AGENT');

// ---------------------------------------------------------------------------
// Residential proxy dispatcher (optional). Applies ONLY to the grid fetch — the
// headless login uses the shared singleton browser. See TL_INTERNATIONAL_PROXY_URL.
// ---------------------------------------------------------------------------
const FLEXWAYS_PROXY_URL = process.env.FLEXWAYS_PROXY_URL || null;
const flexwaysDispatcher = FLEXWAYS_PROXY_URL ? new ProxyAgent(FLEXWAYS_PROXY_URL) : null;
if (FLEXWAYS_PROXY_URL) {
  logger.info?.('[flexways] residential proxy enabled for grid fetch', { proxyUrl: FLEXWAYS_PROXY_URL });
}

// ---------------------------------------------------------------------------
// In-memory per-tenant cookie jar. Map<tenantId, cookieString>. The session
// cookie is harvested from the headless login; a bounce clears it and the next
// request re-logs-in. (No forms-auth token to persist — mirror NU's in-memory jar.)
// ---------------------------------------------------------------------------
const cookieJars = new Map();

function setJar(tenantId, cookieString) {
  if (cookieString) cookieJars.set(tenantId, cookieString);
}
function jarFor(tenantId) {
  return cookieJars.get(tenantId) || '';
}
function hasSession(tenantId) {
  return !!cookieJars.get(tenantId);
}
export function _resetCookieJarsForTests() {
  cookieJars.clear();
}

// ---------------------------------------------------------------------------
// Credential storage (Postgres-backed, AES-256-GCM). Reuses the shared
// booking-source credential store; onRotated nukes the tenant's cookie jar so a
// rotation forces a fresh headless login next request.
// ---------------------------------------------------------------------------
const credentialStore = createCredentialStore({
  sourceSystem: SOURCE_SYSTEM,
  sourceLabel: 'Flexways',
  logPrefix: '[flexways]',
  AuthError: FlexwaysAuthExpiredError,
  onRotated: (tenantId) => cookieJars.delete(tenantId),
});

export const setCredentials = credentialStore.setCredentials;
export const getCredentials = credentialStore.getCredentials;
const recordTestStatus = credentialStore.recordTestStatus;

// ---------------------------------------------------------------------------
// Test seams. Tests inject a stub headless login + a stub grid fetch so the
// parser / mapper / lifecycle can be exercised without a browser or the portal.
// ---------------------------------------------------------------------------
let _fetch = (...args) => globalThis.fetch(...args);
let _browserLogin = defaultBrowserLogin; // (tenantId, {username,password,userAgent}) → cookieString

export const __test = {
  setFetch(fn) {
    _fetch = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args);
  },
  setBrowserLogin(fn) {
    _browserLogin = typeof fn === 'function' ? fn : defaultBrowserLogin;
  },
  setCredentialsResolver(fn) {
    credentialStore.setCredentialsResolver(fn);
  },
  hasSession,
  jarFor,
};

function absUrl(path) {
  if (!path) return `${BASE_URL}/`;
  if (path.startsWith('http')) return path;
  return `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

// ---------------------------------------------------------------------------
// Headless login — drive the REAL Flexways login page so grecaptcha v3 runs.
//
// Returns the harvested "k=v; k2=v2" cookie string. Throws FlexwaysAuthExpiredError
// when the post-submit URL is still the login page (bad credentials / low v3 score).
//
// The exact submit-button markup + the hidden URI/userData fields were NOT fully
// captured in the recon → we fill usuario/clave, submit via LOGIN_SUBMIT_SELECTOR,
// and let the form carry its own hidden fields (they are already in the DOM). This
// is the piece to confirm on the first live PoC.
// ---------------------------------------------------------------------------
async function defaultBrowserLogin(tenantId, { username, password, userAgent }) {
  const loginUrl = absUrl(LOGIN_PATH);
  const timeout = Number(process.env.FLEXWAYS_PUPPETEER_TIMEOUT_MS ?? 30000);

  return withPage(async (page) => {
    await page.setUserAgent(userAgent);
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout });

    // Fill the real form fields (grecaptcha v3 is invisible — it attaches its
    // token when the form submits; we do nothing to it).
    await page.type(`input[name="${LOGIN_USER_FIELD}"]`, username, { delay: randomDelay(20, 60) });
    await page.type(`input[name="${LOGIN_PASS_FIELD}"]`, password, { delay: randomDelay(20, 60) });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout }).catch(() => null),
      page.click(LOGIN_SUBMIT_SELECTOR),
    ]);

    const finalUrl = page.url();
    if (/login\.php/i.test(finalUrl)) {
      throw new FlexwaysAuthExpiredError(
        `Login for tenant ${tenantId} did not leave login.php (bad credentials or low reCAPTCHA v3 score)`
      );
    }
    const cookies = await page.cookies();
    if (!cookies || cookies.length === 0) {
      throw new FlexwaysAuthExpiredError(`No session cookie after login for tenant ${tenantId}`);
    }
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  });
}

/**
 * Ensure the tenant has a session cookie, logging in headlessly if not. Exported
 * so the worker / routes can warm the session up front.
 */
export async function ensureSession(tenantId, opts = {}) {
  if (hasSession(tenantId)) return true;
  return doLogin(tenantId, opts);
}

async function doLogin(tenantId, opts = {}) {
  const { username, password } = await getCredentials(tenantId);
  const userAgent = opts.userAgent || pickUserAgent();
  const cookieString = await _browserLogin(tenantId, { username, password, userAgent });
  if (!cookieString) {
    throw new FlexwaysAuthExpiredError(`Login produced no cookie for tenant ${tenantId}`);
  }
  setJar(tenantId, cookieString);
  logger.info('[flexways] login ok', { tenantId });
  return true;
}

/**
 * Emergency "Force re-login": discard the jar and log in again immediately.
 * Surfaced as a discreet panel button (the autonomous worker re-logs-in on its
 * own; this is the manual fallback).
 */
export async function forceRelogin(tenantId, opts = {}) {
  cookieJars.delete(tenantId);
  await doLogin(tenantId, opts);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Raw grid fetch (uses the tenant cookie + optional proxy). A 3xx→login redirect
// or an HTML (non-JSON) body signals an expired session.
// ---------------------------------------------------------------------------
function isLoginBounce(res, bodyText = '') {
  if (!res) return false;
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (/login\.php|login/i.test(loc)) return true;
  }
  if (bodyText && /login\.php|name=["']clave["']|name=["']usuario["']/i.test(bodyText)) return true;
  return false;
}

async function rawGridFetch(tenantId, url, userAgent) {
  const res = await _fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json,text/javascript,*/*',
      'X-Requested-With': 'XMLHttpRequest',
      ...(jarFor(tenantId) ? { Cookie: jarFor(tenantId) } : {}),
    },
    ...(flexwaysDispatcher ? { dispatcher: flexwaysDispatcher } : {}),
  });
  return res;
}

/**
 * Build the reservations-grid URL for one sede. idSede goes on the query string
 * (recon: idSede is the branch selector in the portal URLs). We send DataTables
 * `length=-1` (all rows) + `start=0` to defeat server-side pagination — otherwise
 * a sede with >10 pickups in the window would silently import only page 1. The
 * date-filter param names weren't captured live, so we ALSO window-filter client
 * side (below); correctness never depends on the server honoring the dates.
 */
function buildListUrl(idSede) {
  const u = new URL(absUrl(LIST_PATH));
  if (idSede != null && String(idSede).trim() !== '') u.searchParams.set('idSede', String(idSede).trim());
  // DataTables server-side pagination guard (Innovation 2026-07-13): -1 = "all".
  u.searchParams.set('length', '-1');
  u.searchParams.set('start', '0');
  return u.toString();
}

// ---------------------------------------------------------------------------
// DataTables JSON parser. `{ draw, recordsTotal, recordsFiltered, data:[[...]] }`.
// Each cell is a string that may embed HTML (icons/links) → strip tags. Maps the
// 9 positional columns to normalized fields. Pure. Exported for tests.
// ---------------------------------------------------------------------------

/** Strip tags + decode the handful of entities the grid emits, collapse ws. */
export function cellText(raw) {
  return String(raw == null ? '' : raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull a title="..."/data-original-title="..." tooltip out of a status cell. */
function extractTooltip(raw) {
  const s = String(raw == null ? '' : raw);
  const m = s.match(/(?:data-original-title|title)=["']([^"']+)["']/i);
  return m ? m[1].trim() : cellText(raw);
}

/**
 * Split a "customer + code" cell ("Joan V... VISSAHE") into { name, code }. The
 * booking code is the TRAILING all-caps alphanumeric token (>= 4 chars); the rest
 * is the display name. HEURISTIC — the per-reservation detail page is the
 * authoritative source for the full customer identity (email/phone), mapped in a
 * follow-up. Pure. Exported for tests.
 */
export function splitCustomerAndCode(raw) {
  const text = cellText(raw);
  if (!text) return { name: null, code: null };
  const m = text.match(/^(.*?)[\s—-]*\b([A-Z0-9]{4,})\s*$/);
  if (m && m[1].trim()) {
    return { name: m[1].trim(), code: m[2].trim() };
  }
  return { name: text, code: null };
}

/** first/last split of a display name (first token → first, rest → last). */
export function splitName(name) {
  const t = String(name || '').trim();
  if (!t) return { firstName: null, lastName: null };
  const parts = t.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Parse a Flexways DataTables JSON payload into normalized row objects. Tolerates
 * the payload arriving as a JSON string or an already-parsed object. Rows with no
 * ref (column 8) are skipped. Dates are interpreted in `timeZone`. Pure. Exported.
 *
 * @returns {Array<object>} normalized rows (+ non-enumerable `diagnostics`)
 */
export function parseReservationGrid(payload, { timeZone = TIME_ZONE } = {}) {
  let json = payload;
  if (typeof payload === 'string') {
    try { json = JSON.parse(payload); } catch { json = null; }
  }
  const data = json && Array.isArray(json.data) ? json.data
    : (Array.isArray(json?.aaData) ? json.aaData : (Array.isArray(json) ? json : []));
  const recordsTotal = Number.isFinite(Number(json?.recordsTotal)) ? Number(json.recordsTotal) : null;

  const rows = [];
  let shortRows = 0;
  for (const cells of data) {
    if (!Array.isArray(cells)) { shortRows++; continue; }
    if (cells.length < EXPECTED_COLUMN_COUNT) { shortRows++; /* keep parsing best-effort */ }

    const externalRef = cellText(cells[COL.REF]);
    if (!externalRef) continue; // a real row must carry a ref

    const { name, code } = splitCustomerAndCode(cells[COL.CUSTOMER]);
    const { firstName, lastName } = splitName(name);

    rows.push({
      externalRef,
      sede: cellText(cells[COL.SEDE]) || null,
      bookedAt: latamToUtc(cells[COL.BOOKED_AT], timeZone),
      pickupAt: latamToUtc(cells[COL.PICKUP_AT], timeZone),
      pickupLocation: cellText(cells[COL.PICKUP_LOCATION]) || null,
      dropoffLocation: cellText(cells[COL.DROPOFF_LOCATION]) || null,
      channel: cellText(cells[COL.CHANNEL]) || null,
      customerName: name,
      customerFirstName: firstName,
      customerLastName: lastName,
      bookingCode: code,
      status: extractTooltip(cells[COL.STATUS]) || null,
    });
  }

  const diagnostics = {
    recordsTotal,
    parsedRows: rows.length,
    shortRows,
    // grid returned rows but none had a ref → likely a format break, not empty.
    emptyGridAnomaly: Array.isArray(data) && data.length > 0 && rows.length === 0,
    // We ask for length=-1, but if the portal still paginated server-side the
    // returned page count would be < recordsTotal → we'd under-import silently.
    // Mirror of NU's FIX-B truncation signal (Innovation 2026-07-13); the worker
    // surfaces it as ATTENTION rather than a clean OK.
    truncated: recordsTotal != null && Array.isArray(data) && data.length < recordsTotal,
  };
  Object.defineProperty(rows, 'diagnostics', {
    value: diagnostics, enumerable: false, configurable: true, writable: true,
  });
  return rows;
}

/** "DD/MM/YYYY HH:mm" → UTC Date in `timeZone` (null when unparseable). */
export function latamToUtc(cell, timeZone = TIME_ZONE) {
  const iso = toIsoFromLatam(cellText(cell));
  if (!iso) return null;
  const dt = parseDateTimeInTz(iso, timeZone);
  return dt && Number.isFinite(dt.valueOf()) ? dt : null;
}

/**
 * Filter normalized rows to pickupAt in [from, to] inclusive. Null bounds are
 * unbounded on that side. Rows with an unparseable pickupAt are DROPPED when a
 * window is supplied (safer than importing a stray row). Pure. Exported.
 */
export function filterByPickupWindow(rows, from, to) {
  if (!Array.isArray(rows)) return [];
  if (!from && !to) return rows;
  const fromMs = from ? new Date(from).getTime() : null;
  const toMs = to ? new Date(to).getTime() : null;
  return rows.filter((row) => {
    const t = row?.pickupAt instanceof Date ? row.pickupAt.getTime() : null;
    if (t == null || Number.isNaN(t)) return false;
    if (fromMs != null && t < fromMs) return false;
    if (toMs != null && t > toMs) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// List fetch — one sede's grid, windowed. GET the DataTables JSON with the
// session cookie, re-login-once on a bounce, parse + client-side window filter.
// ---------------------------------------------------------------------------
export async function fetchReservationList(tenantId, { idSede = null, from = null, to = null, userAgent } = {}) {
  const ua = userAgent || pickUserAgent();
  await ensureSession(tenantId, { userAgent: ua });

  const url = buildListUrl(idSede);
  let res = await rawGridFetch(tenantId, url, ua);
  let text = await res.text().catch(() => '');

  if (isLoginBounce(res, text)) {
    logger.info('[flexways] grid bounced to login, re-login once', { tenantId, idSede });
    cookieJars.delete(tenantId);
    await doLogin(tenantId, { userAgent: ua });
    res = await rawGridFetch(tenantId, url, ua);
    text = await res.text().catch(() => '');
    if (isLoginBounce(res, text)) {
      throw new FlexwaysAuthExpiredError(`Re-login did not restore the Flexways session for tenant ${tenantId}`);
    }
  }

  const parsed = parseReservationGrid(text, { timeZone: TIME_ZONE });
  const diag = parsed.diagnostics || null;
  if (diag?.emptyGridAnomaly) {
    logger.warn('[flexways] grid returned rows but none had a ref — possible format break', { tenantId, idSede });
  }

  const filtered = filterByPickupWindow(parsed, from, to);
  if (diag) {
    Object.defineProperty(filtered, 'diagnostics', {
      value: diag, enumerable: false, configurable: true, writable: true,
    });
  }
  logger.info('[flexways] reservation list fetched', {
    tenantId, idSede, parsed: parsed.length, afterWindow: filtered.length, recordsTotal: diag?.recordsTotal ?? null,
  });
  return filtered;
}

// ---------------------------------------------------------------------------
// Auth probe — headless login + a single grid read. Records OK / EXPIRED / ERROR.
// ---------------------------------------------------------------------------
export async function testAuth(tenantId, { idSede = null } = {}) {
  try {
    cookieJars.delete(tenantId); // force a fresh login so the probe is meaningful
    await doLogin(tenantId);
    // A no-window fetch confirms the session can read the grid.
    await fetchReservationList(tenantId, { idSede });
    await recordTestStatus(tenantId, 'OK');
    return { ok: true, status: 'OK' };
  } catch (err) {
    if (err instanceof FlexwaysAuthExpiredError) {
      await recordTestStatus(tenantId, 'EXPIRED');
      return { ok: false, status: 'EXPIRED', message: err.message };
    }
    await recordTestStatus(tenantId, 'ERROR');
    return { ok: false, status: 'ERROR', message: err.message };
  }
}
