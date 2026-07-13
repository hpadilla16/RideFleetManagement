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
  CONTRACT_LIST_PATH,
  DETAIL_PATH,
  LOGIN_USER_FIELD,
  LOGIN_PASS_FIELD,
  LOGIN_SUBMIT_SELECTOR,
  TIME_ZONE,
  COL,
  CONTRACT_COL,
  EXPECTED_COLUMN_COUNT,
  CONTRACT_CHANNEL_FILTER,
  DETAIL_FIELD,
  DETAIL_EMAIL_PLACEHOLDER,
  DETAIL_DELAY_MIN_MS,
  DETAIL_DELAY_MAX_MS,
  toIsoFromLatam,
} from './flexways.constants.js';

export { SOURCE_SYSTEM, BASE_URL, randomDelay, sleep, DETAIL_DELAY_MIN_MS, DETAIL_DELAY_MAX_MS };

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

async function rawHttpFetch(tenantId, url, userAgent, { accept, xhr = true } = {}) {
  const res = await _fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'User-Agent': userAgent,
      Accept: accept || 'application/json,text/javascript,*/*',
      ...(xhr ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
      ...(jarFor(tenantId) ? { Cookie: jarFor(tenantId) } : {}),
    },
    ...(flexwaysDispatcher ? { dispatcher: flexwaysDispatcher } : {}),
  });
  return res;
}

// The reservations/contracts DataTables endpoints expect an XHR JSON request.
function rawGridFetch(tenantId, url, userAgent) {
  return rawHttpFetch(tenantId, url, userAgent, {
    accept: 'application/json,text/javascript,*/*', xhr: true,
  });
}

// The detail page is a plain HTML document (not XHR); ask for text/html.
function rawDetailFetch(tenantId, url, userAgent) {
  return rawHttpFetch(tenantId, url, userAgent, {
    accept: 'text/html,application/xhtml+xml,*/*', xhr: false,
  });
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

/**
 * Build the contract-list URL for one sede. Same idSede + DataTables
 * `length=-1&start=0` pagination guard as the reservations grid — a sede with
 * >10 contracts in the window must not silently import only page 1.
 */
function buildContractListUrl(idSede) {
  const u = new URL(absUrl(CONTRACT_LIST_PATH));
  if (idSede != null && String(idSede).trim() !== '') u.searchParams.set('idSede', String(idSede).trim());
  u.searchParams.set('length', '-1');
  u.searchParams.set('start', '0');
  return u.toString();
}

/** Build the per-reservation detail URL keyed by idAlquiler. */
function buildDetailUrl(idAlquiler) {
  const u = new URL(absUrl(DETAIL_PATH));
  u.searchParams.set('idAlquiler', String(idAlquiler).trim());
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

// ===========================================================================
// Fase 3.5 — contract list (carries idAlquiler) + per-reservation detail parse.
// ===========================================================================

/** Read cell `i` off a DataTables array-of-objects row (numeric-string keys). */
function contractCell(rowObj, i) {
  if (rowObj == null) return '';
  if (Array.isArray(rowObj)) return rowObj[i];
  // funcionesAjaxContratos rows are objects keyed "0".."11".
  return rowObj[i] ?? rowObj[String(i)] ?? '';
}

/**
 * Pull the ACRISS code out of a Flexways category label. Categories render as
 * "Nombre (ACRISS)" — e.g. "SUV Compact AT (CFAR)" → "CFAR". No 4-letter
 * parenthetical (e.g. a bare name) → null, so the row fails the ACRISS gate and
 * routes to MANUAL_REVIEW (fail-safe). Pure. Exported for tests.
 */
export function extractAcriss(categoryLabel) {
  const m = String(categoryLabel == null ? '' : categoryLabel).match(/\(([A-Za-z]{4})\)/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Parse a funcionesAjaxContratos.php DataTables payload (ARRAY-OF-OBJECTS) into
 * normalized contract rows carrying idAlquiler (the detail-page key). Tolerates
 * a JSON string or an already-parsed object. Rows missing idAlquiler OR ref are
 * skipped (both are required — idAlquiler to fetch the detail, ref as the
 * ExternalReservation key). Dates are interpreted in `timeZone`. Pure. Exported.
 *
 * @returns {Array<object>} normalized rows (+ non-enumerable `diagnostics`)
 */
export function parseContractList(payload, { timeZone = TIME_ZONE } = {}) {
  let json = payload;
  if (typeof payload === 'string') {
    try { json = JSON.parse(payload); } catch { json = null; }
  }
  const data = json && Array.isArray(json.data) ? json.data
    : (Array.isArray(json?.aaData) ? json.aaData : (Array.isArray(json) ? json : []));
  const recordsTotal = Number.isFinite(Number(json?.recordsTotal)) ? Number(json.recordsTotal) : null;

  const rows = [];
  let shortRows = 0;
  let missingId = 0;
  for (const rowObj of data) {
    if (rowObj == null || typeof rowObj !== 'object') { shortRows++; continue; }

    const idAlquiler = cellText(contractCell(rowObj, CONTRACT_COL.ID_ALQUILER));
    const externalRef = cellText(contractCell(rowObj, CONTRACT_COL.REF));
    if (!idAlquiler) { missingId++; continue; } // no detail key → unusable
    if (!externalRef) continue;                 // a real row must carry a ref

    const name = cellText(contractCell(rowObj, CONTRACT_COL.CUSTOMER)) || null;
    const { firstName, lastName } = splitName(name);

    rows.push({
      idAlquiler,
      externalRef,
      ref: externalRef,
      sede: cellText(contractCell(rowObj, CONTRACT_COL.SEDE)) || null,
      // ⚠ pickupAt is col 3 ("fecha booking" in the recon) — see CONTRACT_COL.
      pickupAt: latamToUtc(contractCell(rowObj, CONTRACT_COL.PICKUP_AT), timeZone),
      dropoffAt: latamToUtc(contractCell(rowObj, CONTRACT_COL.DROPOFF_AT), timeZone),
      pickupLocation: cellText(contractCell(rowObj, CONTRACT_COL.PICKUP_LOCATION)) || null,
      dropoffLocation: cellText(contractCell(rowObj, CONTRACT_COL.DROPOFF_LOCATION)) || null,
      channel: cellText(contractCell(rowObj, CONTRACT_COL.CHANNEL)) || null,
      customerName: name,
      customerFirstName: firstName,
      customerLastName: lastName,
    });
  }

  const diagnostics = {
    recordsTotal,
    parsedRows: rows.length,
    shortRows,
    missingId,
    emptyGridAnomaly: Array.isArray(data) && data.length > 0 && rows.length === 0,
    // We ask for length=-1; if the portal still paginated server-side, the page
    // count would be < recordsTotal → under-import silently (mirror of the grid).
    truncated: recordsTotal != null && Array.isArray(data) && data.length < recordsTotal,
  };
  Object.defineProperty(rows, 'diagnostics', {
    value: diagnostics, enumerable: false, configurable: true, writable: true,
  });
  return rows;
}

/** Restrict contract rows to an allow-list of channels (case-insensitive). */
export function filterByChannel(rows, channels = CONTRACT_CHANNEL_FILTER) {
  if (!Array.isArray(rows)) return [];
  if (!Array.isArray(channels) || channels.length === 0) return rows; // empty = all
  const allow = new Set(channels.map((c) => String(c).trim().toUpperCase()).filter(Boolean));
  if (allow.size === 0) return rows;
  return rows.filter((r) => allow.has(String(r?.channel || '').trim().toUpperCase()));
}

// ---------------------------------------------------------------------------
// Detail HTML parsing. The detail page is a ~1MB HTML <form>; we only need a
// handful of fields by `name`. Rather than load the whole DOM, a targeted
// attribute-aware scan pulls each <input value> and each <select>'s SELECTED
// <option> text. Robust to attribute order (name/value can appear in any order).
// Pure. Exported for tests.
// ---------------------------------------------------------------------------

/** Parse the attributes of a single start-tag into a lowercased-key map. */
function parseTagAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return attrs;
}

/** Value of the first <input name="X"> (attribute order agnostic). null if none. */
export function extractInputValue(html, name) {
  const target = String(name || '');
  if (!target) return null;
  const re = /<input\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const attrs = parseTagAttributes(m[0]);
    if (attrs.name === target) return cellText(attrs.value ?? '') || null;
  }
  return null;
}

/**
 * Text of the SELECTED <option> inside <select name="X"> … </select>. When no
 * option is explicitly marked selected, returns null (the portal always marks
 * the current value). null if the select is absent. Pure. Exported for tests.
 */
export function extractSelectedOptionText(html, name) {
  const target = String(name || '');
  if (!target) return null;
  const source = String(html || '');
  const selRe = new RegExp(
    `<select\\b[^>]*\\bname\\s*=\\s*["']?${escapeRegExp(target)}["']?[^>]*>([\\s\\S]*?)</select>`,
    'i'
  );
  const sm = selRe.exec(source);
  if (!sm) return null;
  const body = sm[1];
  const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let om;
  while ((om = optRe.exec(body))) {
    // Match the `selected` boolean attr (bare or selected="selected") but NOT a
    // `data-selected="0"`/`class="selected"` false positive — the `\b` in a
    // plain \bselected\b would match those (Innovation 2026-07-13).
    if (/(^|\s)selected(\s|=|\/|>|$)/i.test(om[1])) return cellText(om[2]) || null;
  }
  return null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "32.50" / "1,234.50" / "1.234,50" → Number. null when not a number. */
export function parseAmount(raw) {
  const s = cellText(raw);
  if (!s) return null;
  const cleaned = s.replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;
  let normalized = cleaned;
  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');
  if (hasDot && hasComma) {
    // The rightmost separator is the decimal; strip the other as a grouping sep.
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.'); // 1.234,50 → 1234.50
    } else {
      normalized = cleaned.replace(/,/g, ''); // 1,234.50 → 1234.50
    }
  } else if (hasComma) {
    // Comma-only: treat as decimal when it looks like one (1–2 trailing digits).
    normalized = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Reject the "test@test.com" placeholder; return a trimmed real email or null. */
function cleanCustomerEmail(value) {
  const e = String(value == null ? '' : value).trim();
  if (!e) return null;
  if (e.toLowerCase() === DETAIL_EMAIL_PLACEHOLDER) return null;
  return e;
}

/**
 * Parse a modificarReserva.php detail HTML document into the enrichment fields
 * the promotion matcher needs. Pure. Exported for tests.
 *
 * @returns {{
 *   customerEmail: string|null,
 *   customerIdExternal: string|null,
 *   totalAmount: number|null,
 *   currency: string|null,
 *   vehicleAcriss: string|null,
 *   vehicleCategoryLabel: string|null,
 * }}
 */
export function parseReservationDetailHtml(html) {
  const source = String(html || '');

  // Email: prefer emailCustomer (the real one); fall back to `email`, but the
  // fallback input can hold a "test@test.com" placeholder → never accept it.
  const customerEmail =
    cleanCustomerEmail(extractInputValue(source, DETAIL_FIELD.EMAIL)) ||
    cleanCustomerEmail(extractInputValue(source, DETAIL_FIELD.EMAIL_FALLBACK));

  const customerIdExternal =
    extractInputValue(source, DETAIL_FIELD.CUSTOMER_ID) ||
    extractSelectedOptionText(source, DETAIL_FIELD.CUSTOMER_ID_FALLBACK) ||
    null;

  const totalAmount =
    parseAmount(extractInputValue(source, DETAIL_FIELD.TOTAL)) ??
    parseAmount(extractInputValue(source, DETAIL_FIELD.TOTAL_FALLBACK));

  const currency = extractSelectedOptionText(source, DETAIL_FIELD.CURRENCY_SELECT) || null;

  const vehicleCategoryLabel = extractSelectedOptionText(source, DETAIL_FIELD.CATEGORY_SELECT) || null;
  const vehicleAcriss = extractAcriss(vehicleCategoryLabel);

  return {
    customerEmail: customerEmail || null,
    customerIdExternal,
    totalAmount: totalAmount ?? null,
    currency,
    vehicleAcriss,
    vehicleCategoryLabel,
  };
}

// ---------------------------------------------------------------------------
// Contract-list fetch — one sede, windowed. GET the DataTables JSON with the
// session cookie, re-login-once on a bounce, parse + channel + window filter.
// This is the list source the worker uses (it carries idAlquiler); the grid
// (fetchReservationList) is retained for the auth probe.
// ---------------------------------------------------------------------------
export async function fetchContractList(
  tenantId,
  { idSede = null, from = null, to = null, channels = CONTRACT_CHANNEL_FILTER, userAgent } = {}
) {
  const ua = userAgent || pickUserAgent();
  await ensureSession(tenantId, { userAgent: ua });

  const url = buildContractListUrl(idSede);
  let res = await rawGridFetch(tenantId, url, ua);
  let text = await res.text().catch(() => '');

  if (isLoginBounce(res, text)) {
    logger.info('[flexways] contract list bounced to login, re-login once', { tenantId, idSede });
    cookieJars.delete(tenantId);
    await doLogin(tenantId, { userAgent: ua });
    res = await rawGridFetch(tenantId, url, ua);
    text = await res.text().catch(() => '');
    if (isLoginBounce(res, text)) {
      throw new FlexwaysAuthExpiredError(`Re-login did not restore the Flexways session for tenant ${tenantId}`);
    }
  }

  const parsed = parseContractList(text, { timeZone: TIME_ZONE });
  const diag = parsed.diagnostics || null;
  if (diag?.emptyGridAnomaly) {
    logger.warn('[flexways] contract list returned rows but none usable — possible format break', { tenantId, idSede });
  }

  const byChannel = filterByChannel(parsed, channels);
  const filtered = filterByPickupWindow(byChannel, from, to);
  if (diag) {
    Object.defineProperty(filtered, 'diagnostics', {
      value: diag, enumerable: false, configurable: true, writable: true,
    });
  }
  logger.info('[flexways] contract list fetched', {
    tenantId, idSede, parsed: parsed.length, afterChannel: byChannel.length,
    afterWindow: filtered.length, recordsTotal: diag?.recordsTotal ?? null,
  });
  return filtered;
}

// ---------------------------------------------------------------------------
// Detail fetch — one reservation's HTML form, parsed for the enrichment fields
// (email / total / currency / ACRISS). Re-login-once on a bounce; on any other
// error returns null so the caller falls back to MANUAL_REVIEW (fail-safe).
// AuthExpired propagates so the worker can fail the whole run.
// ---------------------------------------------------------------------------
export async function fetchReservationDetail(tenantId, idAlquiler, { userAgent } = {}) {
  const id = String(idAlquiler == null ? '' : idAlquiler).trim();
  if (!id) return null;
  const ua = userAgent || pickUserAgent();
  await ensureSession(tenantId, { userAgent: ua });

  const url = buildDetailUrl(id);
  let res = await rawDetailFetch(tenantId, url, ua);
  let text = await res.text().catch(() => '');

  if (isLoginBounce(res, text)) {
    logger.info('[flexways] detail bounced to login, re-login once', { tenantId, idAlquiler: id });
    cookieJars.delete(tenantId);
    await doLogin(tenantId, { userAgent: ua });
    res = await rawDetailFetch(tenantId, url, ua);
    text = await res.text().catch(() => '');
    if (isLoginBounce(res, text)) {
      throw new FlexwaysAuthExpiredError(`Re-login did not restore the Flexways session for tenant ${tenantId}`);
    }
  }

  return parseReservationDetailHtml(text);
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
