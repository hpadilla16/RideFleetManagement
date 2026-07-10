/**
 * NU Car Rentals (affiliates portal) back-office client.
 *
 * Wraps fetch() calls against the NU affiliates ASP.NET WebForms + Telerik
 * portal (affiliates.nucarrentals.com). All network I/O lives here so the
 * worker, scheduler and (future) routes stay thin and testable.
 *
 * Public API:
 *   - setCredentials(tenantId, {username, password}, userId) → encrypts + upserts
 *   - getCredentials(tenantId)                               → { username, password }
 *   - login(tenantId)                                        → seeds the cookie jar
 *   - authedFetch(tenantId, path, opts)                      → re-login-once on bounce
 *   - fetchReservationList(tenantId, {dateFrom, dateTo})     → [normalizedRow, ...]
 *   - testAuth(tenantId)                                     → { ok, status }
 *
 * Authentication (proven in ops/nu-poc/login-poc.mjs against the live portal):
 *   WebForms login. GET the login page → scrape ALL hidden inputs WITH their
 *   values (__VIEWSTATE, __VIEWSTATEGENERATOR, __EVENTVALIDATION, the Telerik
 *   TSM/ClientState hiddens). POST them back, PLUS the plain txtLoginID/txtPSWD
 *   fields AND their `<field>_ClientState` JSON blobs (the Telerik RadTextBox
 *   reads its value from the ClientState hidden, NOT the plain input) AND the
 *   Button1 submit. Success = a 302 chain that does NOT bounce back to login.
 *   Auth is SESSION-based (ASP.NET_SessionId) — there is NO forms-auth cookie.
 *   Re-login is detected by a bounce to AffiliateLOGIN.
 *
 * NO Puppeteer, NO cheerio, NO proxy — plain fetch + a tiny cookie jar + regex
 * (modeled on ops/nu-poc/login-poc.mjs, proven working from the droplet IP).
 *
 * See doc/nu-integration-plan-2026-07-09.md
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { decrypt, encrypt } from '../../../lib/integration-crypto.js';
import { parseDateTimeInTz } from '../../../lib/date-utils.js';
import {
  SOURCE_SYSTEM,
  BASE_URL,
  LOGIN_PATH,
  RESERVATIONS_PATH,
  LOGIN_USER_FIELD,
  LOGIN_PASS_FIELD,
  LOGIN_SUBMIT_FIELD,
  LOGIN_SUBMIT_VALUE,
  DATE_START_PICKER,
  DATE_END_PICKER,
  REFRESH_GRID_TARGET,
  TIME_ZONE,
  HEADER_ANCHORS,
  isPrepaidFromCode,
} from './nu.constants.js';

export { SOURCE_SYSTEM, BASE_URL };

// ---------------------------------------------------------------------------
// Stealth / UA helpers (mirror Economy). NU has no anti-bot; keeping the pool
// means the worker shares the exact run-lifecycle shape.
// ---------------------------------------------------------------------------
export const USER_AGENT_POOL = Object.freeze([
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
]);

export function pickUserAgent() {
  if (process.env.NU_USER_AGENT) return process.env.NU_USER_AGENT;
  const idx = Math.floor(Math.random() * USER_AGENT_POOL.length);
  return USER_AGENT_POOL[idx];
}

export function randomDelay(minMs, maxMs) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || 0);
  if (hi <= lo) return lo;
  return Math.floor(lo + Math.random() * (hi - lo));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NuAuthExpiredError extends Error {
  constructor(message = 'NU (affiliates portal) session expired or invalid') {
    super(message);
    this.name = 'NuAuthExpiredError';
  }
}

/**
 * Raised when the RadGrid renders but its header columns have DRIFTED from the
 * validated positional mapping (see HEADER_ANCHORS). Distinct from an auth/empty
 * failure so the worker records the run as needing ATTENTION rather than a silent
 * "OK 0" — importing a shifted mapping would corrupt estimatedTotal / isPrepaid.
 */
export class NuLayoutError extends Error {
  constructor(message = 'NU RadGrid layout drifted from the expected column mapping') {
    super(message);
    this.name = 'NuLayoutError';
  }
}

// ---------------------------------------------------------------------------
// Credential storage (Postgres-backed, AES-256-GCM). Stores a JSON
// {username, password} blob. Mirrors economy.service.js exactly.
// ---------------------------------------------------------------------------

export async function setCredentials(tenantId, creds, userId = null) {
  if (!tenantId) throw new Error('tenantId required');
  const username = (creds?.username ?? '').toString().trim();
  const password = (creds?.password ?? '').toString();
  if (!username) throw new Error('username required');
  if (!password) throw new Error('password required');

  const encryptedPayload = encrypt(JSON.stringify({ username, password }));
  const row = await prisma.integrationCredential.upsert({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
    create: {
      tenantId,
      sourceSystem: SOURCE_SYSTEM,
      encryptedPayload,
      rotatedAt: new Date(),
      rotatedByUserId: userId,
    },
    update: {
      encryptedPayload,
      rotatedAt: new Date(),
      rotatedByUserId: userId,
      lastTestedAt: null,
      lastTestStatus: null,
    },
  });
  cookieJars.delete(tenantId);
  logger.info('[nu] credentials rotated', { tenantId, credentialId: row.id });
  return row;
}

// Test seam: tests can inject a credentials resolver so login/authedFetch can
// be exercised without a live DB.
let _credentialsResolver = null;

export async function getCredentials(tenantId) {
  if (_credentialsResolver) return _credentialsResolver(tenantId);
  if (!tenantId) throw new NuAuthExpiredError('tenantId required to load NU credentials');
  const row = await prisma.integrationCredential.findUnique({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
  });
  if (!row) throw new NuAuthExpiredError(`No IntegrationCredential row for tenant ${tenantId}`);
  if (!row.encryptedPayload) {
    throw new NuAuthExpiredError(`IntegrationCredential.encryptedPayload empty for tenant ${tenantId}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(decrypt(row.encryptedPayload));
  } catch (err) {
    throw new NuAuthExpiredError(
      `Failed to decrypt/parse NU credentials for tenant ${tenantId}: ${err.message}`
    );
  }
  if (!parsed?.username || !parsed?.password) {
    throw new NuAuthExpiredError(`NU credentials for tenant ${tenantId} missing username/password`);
  }
  return { username: parsed.username, password: parsed.password };
}

async function recordTestStatus(tenantId, status) {
  await prisma.integrationCredential.update({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
    data: { lastTestedAt: new Date(), lastTestStatus: status },
  }).catch(() => {/* swallow — caller already reporting */});
}

// ---------------------------------------------------------------------------
// In-memory per-tenant cookie jar. Map<tenantId, Map<cookieName, value>>.
// NU auth is the ASP.NET_SessionId cookie (session-based, no forms-auth cookie).
// ---------------------------------------------------------------------------
const cookieJars = new Map();

function jarFor(tenantId) {
  let jar = cookieJars.get(tenantId);
  if (!jar) {
    jar = new Map();
    cookieJars.set(tenantId, jar);
  }
  return jar;
}

function absorbSetCookie(tenantId, res) {
  const jar = jarFor(tenantId);
  let cookies = [];
  try {
    cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  } catch { /* ignore */ }
  if (!cookies.length) {
    const sc = res.headers.get('set-cookie');
    if (sc) cookies = [sc];
  }
  for (const c of cookies) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeaderFor(tenantId) {
  const jar = cookieJars.get(tenantId);
  if (!jar || jar.size === 0) return '';
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function hasSessionCookie(tenantId) {
  const jar = cookieJars.get(tenantId);
  return !!jar && jar.has('ASP.NET_SessionId');
}

export function _resetCookieJarsForTests() {
  cookieJars.clear();
}

// ---------------------------------------------------------------------------
// WebForms hidden-field scraping. NU (like all ASP.NET WebForms) requires the
// hidden fields to be RE-POSTED with their real values (__VIEWSTATE,
// __VIEWSTATEGENERATOR, __EVENTVALIDATION, the Telerik TSM + *_ClientState
// hiddens). We scrape EVERY hidden input's name+value.
// ---------------------------------------------------------------------------

/**
 * Parse a WebForms <form>: action + a { name -> value } map of ALL <input>
 * fields (hidden + visible). Value defaults to '' for value-less inputs.
 * Pure. Exported for tests.
 */
export function parseWebFormsForm(html) {
  const s = String(html || '');
  const form = (s.match(/<form[\s\S]*?<\/form>/i) || [''])[0];
  const action = (form.match(/action=["']([^"']*)["']/i) || [, ''])[1];
  const fields = {};
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/name=["']([^"']*)["']/i) || [, ''])[1];
    if (!name) continue;
    const type = (tag.match(/type=["']([^"']*)["']/i) || [, 'text'])[1].toLowerCase();
    const value = (tag.match(/value=["']([\s\S]*?)["']/i) || [, ''])[1];
    // First occurrence wins (WebForms renders each control once).
    if (!(name in fields)) fields[name] = { value, type };
  }
  return { action, fields };
}

/**
 * Build the Telerik RadInput ClientState JSON for a value. The RadTextBox /
 * RadDatePicker $dateInput reads its submitted value from this hidden JSON, NOT
 * the plain input. Mirrors ops/nu-poc/login-poc.mjs exactly. Pure. Exported.
 */
export function buildClientState(value) {
  const v = value == null ? '' : String(value);
  return JSON.stringify({
    enabled: true,
    emptyMessage: '',
    validationText: v,
    valueAsString: v,
    lastSetTextBoxValue: v,
  });
}

// ---------------------------------------------------------------------------
// Raw fetch wrapper (uses the tenant jar, no auto-relogin — that's authedFetch).
// Test seam: a stub fetch can be injected via __test.setFetch.
// ---------------------------------------------------------------------------
let _fetch = (...args) => globalThis.fetch(...args);

export const __test = {
  setFetch(fn) {
    _fetch = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args);
  },
  setCredentialsResolver(fn) {
    _credentialsResolver = typeof fn === 'function' ? fn : null;
  },
  hasSessionCookie,
  cookieHeaderFor,
};

function absUrl(path) {
  if (!path) return `${BASE_URL}/`;
  if (path.startsWith('http')) return path;
  return `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

async function rawFetch(tenantId, url, opts = {}) {
  const userAgent = opts.userAgent || pickUserAgent();
  const headers = {
    'User-Agent': userAgent,
    ...(cookieHeaderFor(tenantId) ? { Cookie: cookieHeaderFor(tenantId) } : {}),
    ...(opts.headers ?? {}),
  };
  const res = await _fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body,
    redirect: 'manual',
    signal: opts.signal,
  });
  absorbSetCookie(tenantId, res);
  return res;
}

/**
 * A response is a "bounce to login" when a 3xx redirect points at the NU login
 * page (or a body/URL clearly is the login page). NU has no forms-auth cookie,
 * so an expired session round-trips back to AffiliateLOGIN.
 */
function isLoginBounce(res, bodyText = '') {
  if (!res) return false;
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (/AffiliateLOGIN|login/i.test(loc)) return true;
  }
  if (bodyText && /AffiliateLOGIN\.aspx|name=["']txtPSWD["']/i.test(bodyText)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Login — seeds the cookie jar. Mirrors ops/nu-poc/login-poc.mjs EXACTLY.
// ---------------------------------------------------------------------------
export async function login(tenantId, opts = {}) {
  const { username, password } = await getCredentials(tenantId);
  const userAgent = opts.userAgent || pickUserAgent();
  const loginUrl = absUrl(LOGIN_PATH);

  // 1) GET the login page → scrape ALL hidden fields with values.
  const getRes = await rawFetch(tenantId, loginUrl, { userAgent });
  const loginHtml = getRes.status < 400 ? await getRes.text() : '';
  const { action, fields } = parseWebFormsForm(loginHtml);

  // 2) POST: re-send every non-submit field with its scraped value, then set
  //    the credential fields + their Telerik ClientState hiddens + the submit.
  const body = new URLSearchParams();
  for (const [name, meta] of Object.entries(fields)) {
    if (meta.type === 'submit' || meta.type === 'image') continue; // submit added below
    body.set(name, meta.value || '');
  }
  body.set(LOGIN_USER_FIELD, username);
  body.set(LOGIN_PASS_FIELD, password);
  // Telerik RadTextBox reads its value from the *_ClientState hidden JSON, NOT
  // the plain input — always set both ClientState blobs (proven in the PoC).
  body.set(`${LOGIN_USER_FIELD}_ClientState`, buildClientState(username));
  body.set(`${LOGIN_PASS_FIELD}_ClientState`, buildClientState(password));
  body.set(LOGIN_SUBMIT_FIELD, (fields[LOGIN_SUBMIT_FIELD]?.value) || LOGIN_SUBMIT_VALUE);

  const actionUrl = action ? absUrl(action.replace(/^\.\//, '/')) : loginUrl;
  const postRes = await rawFetch(tenantId, actionUrl, {
    method: 'POST',
    userAgent,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE_URL,
      referer: loginUrl,
    },
    body: body.toString(),
  });
  const postBody = await postRes.text().catch(() => '');

  // Success = the POST redirected (302) to a page that is NOT login. NU auth is
  // session-based (ASP.NET_SessionId), so a session cookie must exist AND the
  // redirect must not point back to AffiliateLOGIN.
  const loc = postRes.headers.get('location') || '';
  const redirected = postRes.status >= 300 && postRes.status < 400;
  const bounced = isLoginBounce(postRes, postBody);

  // Follow the redirect chain to confirm the landing page is 200 (not a re-bounce).
  let landedOk = false;
  if (redirected && !bounced && loc) {
    let cur = absUrl(loc);
    for (let hop = 0; hop < 6 && cur; hop++) {
      const rr = await rawFetch(tenantId, cur, { userAgent });
      if (rr.status >= 300 && rr.status < 400 && rr.headers.get('location')) {
        if (/AffiliateLOGIN|login/i.test(rr.headers.get('location'))) { landedOk = false; break; }
        cur = absUrl(rr.headers.get('location'));
        continue;
      }
      const body2 = rr.status < 400 ? await rr.text().catch(() => '') : '';
      landedOk = rr.status < 400 && !/AffiliateLOGIN\.aspx|name=["']txtPSWD["']/i.test(body2);
      break;
    }
  }

  if (!hasSessionCookie(tenantId) || bounced || !landedOk) {
    cookieJars.delete(tenantId);
    throw new NuAuthExpiredError(
      `Login for tenant ${tenantId} did not establish an authenticated NU session (bad credentials?)`
    );
  }
  logger.info('[nu] login ok', { tenantId });
  return true;
}

// ---------------------------------------------------------------------------
// authedFetch — ensures a session, retries login ONCE on bounce.
// ---------------------------------------------------------------------------
export async function authedFetch(tenantId, path, opts = {}) {
  const url = absUrl(path);

  if (!hasSessionCookie(tenantId)) {
    await login(tenantId, { userAgent: opts.userAgent });
  }

  let res = await rawFetch(tenantId, url, opts);
  if (isLoginBounce(res)) {
    logger.info('[nu] session bounce, re-login once', { tenantId, path });
    cookieJars.delete(tenantId);
    await login(tenantId, { userAgent: opts.userAgent });
    res = await rawFetch(tenantId, url, opts);
    if (isLoginBounce(res)) {
      throw new NuAuthExpiredError(`Re-login did not restore session for tenant ${tenantId}`);
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// RadGrid parser.
//
// The reservations page renders a single Telerik RadGrid (id contains RadGrid1
// AND class contains rgMasterTable). Data rows are <tr> whose class CONTAINS
// "rgRow" or "rgAltRow" (the live markup renders "rgRow PadAllSides" / "rgAltRow",
// so a contains-match is required, NOT an exact class="rgRow"). Each data row has
// exactly 20 <td> cells, the FIRST TWO of which are structural (row-select /
// expand) and are IGNORED. Column order (confirmed live 2026-07-09):
//   0,1 structural (ignore)
//   2  Confirmation ("617-…-NU")   3  Last Name   4  First Name
//   5  PU   6  Flight ("UN" → empty)
//   7  TAKEN date (ISO Y-MM-DD)    8  TAKEN time (HH:MM 24h)
//   9  RENTAL date (=PICKUP, ISO) 10  RENTAL time (HH:MM)
//  11  RETURN date (=DROPOFF, ISO) 12  RETURN time (HH:MM)
//  13  Class (ACRISS 4-letter)    14  Status
//  15  Total ($, money → estimatedTotal)
//  16  COMBINED "Code + rate" in ONE cell — e.g. "OP 39", "PP 40", "36" (no
//      letters), "PP 70". code = the PP/OP token if present, rate = the trailing
//      integer if present. blank (number-only, no PP/OP) = pay-at-destination.
//  17  ratePlan / system code ("SYS30","SYS5","SYS4"… informational)
//  18  AltConfirmation# (e.g. "US904718150"; empty for most rows)
//  19  Phone ("p 0017168071101" — leading "p"/icon artifact then digits;
//      "p -" / "p" = no phone). DIGITS only; < 7 digits → no phone.
//
// Dates are already ISO Y-MM-DD and times HH:MM 24h; date+time pairs are joined
// and interpreted in America/New_York → UTC. Cells are matched robustly against
// RadGrid whitespace/nbsp/nested-span noise.
// ---------------------------------------------------------------------------

/** Strip tags + decode the handful of entities RadGrid emits, collapse ws. */
function cellText(rawTd) {
  return String(rawTd || '')
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

/** Extract the <td> cell texts from one <tr>...</tr> block, in order. */
function extractCells(rowHtml) {
  const cells = [];
  for (const m of String(rowHtml).matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
    cells.push(cellText(m[1]));
  }
  return cells;
}

/**
 * Extract the RadGrid HEADER cell texts (in order) from a grid scope. Prefers an
 * explicit rgHeader row; falls back to the first <tr> that actually contains a
 * <th>. Returns null when no header row can be found (caller proceeds best-effort
 * WITHOUT the column-drift guard). Pure. Exported for tests.
 */
export function extractHeaderCells(scopeHtml) {
  const s = String(scopeHtml || '');
  let inner = (s.match(/<tr\b[^>]*class=["'][^"']*\brgHeader\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/i) || [])[1];
  if (inner == null) {
    for (const m of s.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      if (/<th\b/i.test(m[1])) { inner = m[1]; break; }
    }
  }
  if (inner == null) return null;
  const cells = [];
  for (const m of inner.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)) cells.push(cellText(m[1]));
  return cells.length ? cells : null;
}

/**
 * Compare extracted header cells against HEADER_ANCHORS. Returns the list of
 * mismatched anchors ([] = aligned). Substring, case-insensitive. Pure. Exported.
 */
export function headerAnchorMismatch(headerCells) {
  const cells = Array.isArray(headerCells) ? headerCells : [];
  const bad = [];
  for (const [idxStr, label] of Object.entries(HEADER_ANCHORS)) {
    const idx = Number(idxStr);
    const got = (cells[idx] || '').toLowerCase();
    if (!got.includes(String(label).toLowerCase())) {
      bad.push({ idx, expected: label, got: cells[idx] ?? null });
    }
  }
  return bad;
}

const _toInt = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the Telerik RadGrid pager/info label for the TOTAL item count and the
 * page count. Telerik renders an info part (rgInfoPart) like "items 1 to 20 of
 * 459" / "459 items" / "1 items", and a pager (rgPager) that can carry
 * "Page 1 of 23". Returns { totalItems, pageCount } (null when unknown). Pure.
 * Exported for tests.
 */
export function parsePagerInfo(html) {
  const s = String(html || '');
  const infoPart = (s.match(/<[^>]*class=["'][^"']*rgInfoPart[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i) || [, ''])[1] || '';
  const pagerBlock = (s.match(/<[^>]*class=["'][^"']*rgPager[^"']*["'][\s\S]*?<\/(?:div|table|td)>/i) || [''])[0] || '';
  const text = cellText(`${infoPart} ${pagerBlock}`);

  let totalItems = null;
  let m = text.match(/\bto\s+[\d,]+\s+of\s+([\d,]+)/i)   // "items 1 to 20 of 459"
    || text.match(/\bof\s+([\d,]+)\s+items?\b/i)         // "of 459 items"
    || text.match(/\b([\d,]+)\s+items?\b/i);             // "459 items" / "1 items"
  if (m) totalItems = _toInt(m[1]);

  let pageCount = null;
  m = text.match(/page\s+\d+\s+of\s+([\d,]+)/i);          // "Page 1 of 23"
  if (m) pageCount = _toInt(m[1]);

  return { totalItems, pageCount };
}

/** Attach a non-enumerable diagnostics blob to a rows array (kept off deepEqual). */
function attachDiagnostics(rows, diagnostics) {
  Object.defineProperty(rows, 'diagnostics', {
    value: diagnostics, enumerable: false, configurable: true, writable: true,
  });
  return rows;
}

/**
 * Parse an NU RadGrid HTML page into normalized row objects. Isolates the
 * master table (id contains RadGrid1 / class rgMasterTable), iterates each
 * data row (class contains rgRow / rgAltRow) and maps the ordered 20 cells to
 * fields — the first TWO cells are structural and ignored. Tolerant of an empty
 * AltConfirmation#, "UN" flight, and blank Code. Dates+times are combined and
 * interpreted in America/New_York → UTC Date. Pure. Exported.
 *
 * @returns {Array<object>} normalized rows (see field list below)
 */
export function parseRadGrid(html, { timeZone = TIME_ZONE } = {}) {
  const s = String(html || '');
  if (!s) return [];

  // Narrow to the master grid table if we can find it (id ...RadGrid1 or the
  // rgMasterTable class). Falls back to the whole doc so a class-name drift
  // doesn't silently drop every row.
  let scope = s;
  const masterByClass = s.match(/<table[^>]*class=["'][^"']*rgMasterTable[^"']*["'][\s\S]*?<\/table>/i);
  const masterById = s.match(/<table[^>]*id=["'][^"']*RadGrid1[^"']*["'][\s\S]*?<\/table>/i);
  if (masterByClass) scope = masterByClass[0];
  else if (masterById) scope = masterById[0];
  const gridPresent = !!(masterByClass || masterById);

  // FIX A — column-drift guard. Verify the header anchors sit where the positional
  // mapping expects them. If the grid was FOUND but the anchors have drifted,
  // refuse to import (throwing NuLayoutError) rather than silently corrupting
  // estimatedTotal / isPrepaid with a shifted mapping. If NO header can be
  // extracted at all we proceed best-effort (headerFound=false → loud WARN by the
  // caller) — a missing header alone must not hard-fail.
  const headerCells = extractHeaderCells(scope);
  const headerFound = !!headerCells;
  if (gridPresent && headerFound) {
    const mismatches = headerAnchorMismatch(headerCells);
    if (mismatches.length) {
      throw new NuLayoutError(
        'NU RadGrid header drift — anchor column(s) moved: '
        + mismatches.map((b) => `#${b.idx} expected "${b.expected}" got "${b.got ?? ''}"`).join('; ')
        + '. Refusing to import a shifted mapping (would corrupt estimatedTotal / isPrepaid).'
      );
    }
  }

  const rows = [];
  let unexpectedCodeTokens = 0; // FIX C — non-PP/OP/number cell[16] tokens seen
  // Match each data <tr> whose class CONTAINS a RadGrid data-row marker. The
  // live markup is class="rgRow PadAllSides" / class="rgAltRow", so match the
  // token anywhere in the class list — never an exact class="rgRow".
  const rowRe = /<tr\b[^>]*class=["'][^"']*\brg(?:Row|AltRow)\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;
  for (const m of scope.matchAll(rowRe)) {
    const cells = extractCells(m[1]);
    if (cells.length < 20) continue; // not a real data row (20 cells expected)

    // cells[0], cells[1] are structural (row-select / expand) → ignored.
    const confirmation = cells[2] || '';
    if (!confirmation) continue; // must have a confirmation ref

    const lastName = cells[3] || '';
    const firstName = cells[4] || '';
    const pu = cells[5] || '';
    const flightRaw = cells[6] || '';
    const takenDate = cells[7] || '';
    const takenTime = cells[8] || '';
    const pickupDate = cells[9] || '';   // = RENTAL
    const pickupTime = cells[10] || '';
    const dropoffDate = cells[11] || ''; // = RETURN
    const dropoffTime = cells[12] || '';
    const acriss = cells[13] || '';
    const status = cells[14] || '';
    const total = cells[15] || '';
    // cell[16] is a COMBINED "Code + rate" cell: "OP 39", "PP 40", "36", "PP 70".
    // code = the PP/OP token if present; rate = the trailing integer if present.
    const raw16 = cells[16] || '';
    const codeMatch = raw16.match(/\b(PP|OP)\b/i);
    const code = codeMatch ? codeMatch[1].toUpperCase() : '';
    const rate = (raw16.match(/(\d+)\s*$/) || [])[1] || '';
    // FIX C — telemetry: a non-empty cell[16] that is NEITHER a PP/OP token NOR a
    // pure number is an UNEXPECTED token. Today it would be silently bucketed as
    // pay-at-destination (isPrepaid stays false) — count it so a future NU prepaid-
    // indicator change is caught before the counter collects on a paid booking.
    // No PII: we only tally, never log the token text.
    const trimmed16 = raw16.trim();
    if (trimmed16 && !codeMatch && !/^\d+(?:\.\d+)?$/.test(trimmed16)) {
      unexpectedCodeTokens++;
    }
    const ratePlan = cells[17] || '';         // system code ("SYS30"…), informational
    const altConfirmation = cells[18] || '';
    const phoneRaw = cells[19] || '';

    // "UN" flight = unknown → treat as no flight.
    const flight = /^UN$/i.test(flightRaw.trim()) ? '' : flightRaw.trim();

    rows.push({
      confirmation: confirmation.trim(),
      lastName: lastName.trim(),
      firstName: firstName.trim(),
      pu: pu.trim(),
      flight,
      bookedAt: combineDateTimeToUtc(takenDate, takenTime, timeZone),
      pickupAt: combineDateTimeToUtc(pickupDate, pickupTime, timeZone),
      dropoffAt: combineDateTimeToUtc(dropoffDate, dropoffTime, timeZone),
      acriss: acriss.trim().toUpperCase() || null,
      status: status.trim() || null,
      total: parseMoney(total),
      code,
      isPrepaid: isPrepaidFromCode(code),
      rate: rate || null,
      ratePlan: ratePlan.trim() || null,
      altConfirmation: altConfirmation.trim() || null,
      phone: cleanPhone(phoneRaw),
    });
  }

  // FIX B — parser-health diagnostics (non-enumerable so it never leaks into
  // deepEqual / JSON of the rows). The caller (fetchReservationList → worker)
  // turns these into loud WARNs + a distinct ExternalSyncRun record so a parser/
  // format break or a paging truncation surfaces instead of a silent "OK 0".
  const { totalItems, pageCount } = parsePagerInfo(s);
  const totalCount = totalItems; // number | null (null = pager total unknown)
  const truncated = (totalCount != null && totalCount > rows.length)
    || (totalCount == null && pageCount != null && pageCount > 1);
  // Grid rendered but ZERO rows parsed AND the total is not a confirmed 0 → an
  // anomaly (parser/format break or paging loss), NOT a clean empty window.
  const emptyGridAnomaly = gridPresent && rows.length === 0 && totalCount !== 0;

  return attachDiagnostics(rows, {
    gridPresent,
    headerFound,
    parsedRows: rows.length,
    totalCount,
    pageCount,
    truncated,
    emptyGridAnomaly,
    unexpectedCodeTokens,
  });
}

/**
 * Combine an M/D/YYYY date cell + an h:mm[ AM|PM] time cell into a UTC Date,
 * interpreting the wall-clock in `timeZone` (FLL Eastern). Returns null if the
 * date is unparseable. Pure. Exported for tests.
 */
export function combineDateTimeToUtc(dateStr, timeStr, timeZone = TIME_ZONE) {
  const d = String(dateStr || '').trim();
  if (!d) return null;
  const dm = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!dm) {
    // Fall back to a permissive parse (ISO etc.).
    const dt = parseDateTimeInTz(`${d}${timeStr ? ` ${timeStr}` : ''}`.trim(), timeZone);
    return dt && Number.isFinite(dt.valueOf()) ? dt : null;
  }
  let [, mo, day, yr] = dm;
  if (yr.length === 2) yr = `20${yr}`;
  const { hh, mi } = parse12hTime(timeStr);
  const iso = `${yr.padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    + `T${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`;
  const dt = parseDateTimeInTz(iso, timeZone);
  return dt && Number.isFinite(dt.valueOf()) ? dt : null;
}

/** Parse an "h:mm AM/PM" or "HH:mm" time cell → { hh, mi } (24h). Blank → 00:00. */
function parse12hTime(timeStr) {
  const t = String(timeStr || '').trim();
  if (!t) return { hh: 0, mi: 0 };
  const m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!m) return { hh: 0, mi: 0 };
  let hh = Number(m[1]);
  const mi = Number(m[2]);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  if (!Number.isFinite(hh) || hh < 0 || hh > 23) hh = 0;
  return { hh, mi: Number.isFinite(mi) ? mi : 0 };
}

/**
 * Parse a "$1,234.50" money cell → a plain decimal string (no symbols/commas),
 * or null when there is no meaningful amount. Pure. Exported for tests.
 */
export function parseMoney(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^0-9.\-]/g, '').trim();
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return s;
}

/**
 * Clean a phone cell like "p 0017168071101" (a leading "p"/icon artifact then
 * digits; "p -" / "p" = no phone). Extract DIGITS only; fewer than 7 digits →
 * no phone (null). Pure. Exported for tests.
 */
export function cleanPhone(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

// ---------------------------------------------------------------------------
// List fetch — date-range postback on affiliates.aspx.
//
// GET affiliates.aspx (fresh viewstate) → POST every scraped hidden field back,
// OVERRIDING the START/END RadDatePicker's FULL set of coordinated hidden fields
// (the server reads the *_dateInput_ClientState blob, not the plain $dateInput —
// setting only $dateInput silently returns 0 rows), leaving RadRadioButtonList1
// at its scraped "Rental Date" default, and firing the btnRefreshGrid event
// target. Then parse the returned RadGrid HTML.
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Turn parseRadGrid diagnostics into LOUD WARNs (PII-free) at fetch time. The
 * worker separately marks the ExternalSyncRun for the same signals. No-op when
 * diagnostics are absent (e.g. an empty-config run). Exported for the worker's
 * shared use is unnecessary — it stays local to the service layer.
 */
function warnOnParseDiagnostics(tenantId, diag, ctx = {}) {
  if (!diag) return;
  if (diag.gridPresent && !diag.headerFound) {
    logger.warn('[nu] RadGrid header row not found — parsed best-effort WITHOUT the column-drift guard', {
      tenantId, ...ctx,
    });
  }
  if (diag.truncated) {
    logger.warn('[nu] RadGrid returned FEWER rows than the pager total — page truncation, reservations may be MISSING', {
      tenantId, parsedRows: diag.parsedRows, totalCount: diag.totalCount, pageCount: diag.pageCount, ...ctx,
    });
  }
  if (diag.emptyGridAnomaly) {
    logger.warn('[nu] RadGrid present but ZERO rows parsed with a non-zero/unknown total — possible parser/format break', {
      tenantId, totalCount: diag.totalCount, ...ctx,
    });
  }
  if (diag.unexpectedCodeTokens > 0) {
    logger.warn('[nu] RadGrid Code cell had unexpected non-PP/OP/number token(s) — prepaid rule may need review', {
      tenantId, unexpectedCodeTokens: diag.unexpectedCodeTokens, ...ctx,
    });
  }
}

/** Y/M/D wall-clock parts of a Date in the NU (Eastern) timezone, as numbers. */
function nuDateParts(date, timeZone = TIME_ZONE) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { Y: get('year'), M: get('month'), D: get('day') };
}

/**
 * Build the FULL set of Telerik RadDatePicker override fields for ONE picker,
 * keyed by NAME SUFFIX (robust to the ctl00$…$ / ctl00_…_ naming-container
 * prefix). Rules are ordered MOST-specific FIRST so the bare picker suffix never
 * clobbers the $dateInput / _dateInput_ClientState / _calendar_* hiddens. The
 * *_dateInput_ClientState blob is the field the server actually reads — the
 * previously-missing piece that left the filter empty. Pure. Exported for tests.
 *
 * For date 2026-08-08 (Y=2026, M=8, D=8) the START picker emits:
 *   …$RadDatePickerSTART$dateInput            → "08/8/2026"       (MM/d/yyyy)
 *   …RadDatePickerSTART_dateInput_ClientState → {…"valueAsString":"2026-08-08-00-00-00"…}
 *   …RadDatePickerSTART_calendar_AD           → [[1980,1,1],[2099,12,30],[2026,8,8]]
 *   …RadDatePickerSTART_calendar_SD           → []
 *   …$RadDatePickerSTART                       → "2026-08-08"      (ISO)
 */
export function radDatePickerOverrides(pickerId, date, timeZone = TIME_ZONE) {
  const { Y, M, D } = nuDateParts(date, timeZone);
  const iso = `${Y}-${pad2(M)}-${pad2(D)}`;   // "2026-08-08"
  const display = `${pad2(M)}/${D}/${Y}`;     // "08/8/2026" (MM/d/yyyy: month padded, day NOT)
  const stamped = `${iso}-00-00-00`;          // "2026-08-08-00-00-00"
  const clientState = JSON.stringify({
    enabled: true,
    emptyMessage: '',
    validationText: stamped,
    valueAsString: stamped,
    minDateStr: '1980-01-01-00-00-00',
    maxDateStr: '2099-12-31-00-00-00',
    lastSetTextBoxValue: display,
  });
  const calendarAd = JSON.stringify([[1980, 1, 1], [2099, 12, 30], [Y, M, D]]);
  return [
    { suffix: `$${pickerId}$dateInput`, value: display },
    { suffix: `${pickerId}_dateInput_ClientState`, value: clientState },
    { suffix: `${pickerId}_calendar_AD`, value: calendarAd },
    { suffix: `${pickerId}_calendar_SD`, value: '[]' },
    { suffix: `$${pickerId}`, value: iso },
  ];
}
export async function fetchReservationList(tenantId, { dateFrom = null, dateTo = null, userAgent } = {}) {
  const ua = userAgent || pickUserAgent();

  // 1) Fresh authed GET → scrape the viewstate/hidden fields for the postback.
  const pageRes = await authedFetch(tenantId, RESERVATIONS_PATH, { userAgent: ua });
  const pageHtml = pageRes.status < 400 ? await pageRes.text() : '';
  if (isLoginBounce(pageRes, pageHtml)) {
    throw new NuAuthExpiredError(`Reservations page bounced to login for tenant ${tenantId}`);
  }
  const { action, fields } = parseWebFormsForm(pageHtml);

  // No date window (testAuth probe): just parse whatever the fresh GET rendered.
  if (!dateFrom && !dateTo) {
    const rows = parseRadGrid(pageHtml);
    logger.info('[nu] reservation list fetched (no window, initial grid)', {
      tenantId, rows: rows.length,
    });
    return rows;
  }

  // 2) Build the date-range postback body: re-send EVERY scraped hidden field
  //    with its preserved value (VIEWSTATE, EVENTVALIDATION, the
  //    RadRadioButtonList1 ClientState hiddens that keep "Rental Date" selected,
  //    …), OVERRIDING only the START/END RadDatePicker fields (matched by name
  //    suffix so we're robust to the exact naming-container prefix). Then fire
  //    the refresh-grid event target.
  const overrideRules = [
    ...radDatePickerOverrides(DATE_START_PICKER, dateFrom),
    ...radDatePickerOverrides(DATE_END_PICKER, dateTo),
  ];
  const body = new URLSearchParams();
  for (const [name, meta] of Object.entries(fields)) {
    if (meta.type === 'submit' || meta.type === 'image') continue;
    // Most-specific suffix wins (rules are pre-ordered per picker).
    const rule = overrideRules.find((r) => name.endsWith(r.suffix));
    body.set(name, rule ? rule.value : (meta.value || ''));
  }
  // Fire the (type=button) refresh via the WebForms event target.
  body.set('__EVENTTARGET', REFRESH_GRID_TARGET);
  body.set('__EVENTARGUMENT', '');

  // ISO window labels for logging (PII-free).
  const fromParts = nuDateParts(dateFrom);
  const toParts = nuDateParts(dateTo);
  const fromStr = `${fromParts.Y}-${pad2(fromParts.M)}-${pad2(fromParts.D)}`;
  const toStr = `${toParts.Y}-${pad2(toParts.M)}-${pad2(toParts.D)}`;

  const actionUrl = action ? absUrl(action.replace(/^\.\//, '/')) : absUrl(RESERVATIONS_PATH);
  const res = await authedFetch(tenantId, actionUrl, {
    method: 'POST',
    userAgent: ua,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE_URL,
      referer: absUrl(RESERVATIONS_PATH),
    },
    body: body.toString(),
  });
  const gridHtml = res.status < 400 ? await res.text() : '';
  if (isLoginBounce(res, gridHtml)) {
    throw new NuAuthExpiredError(`Date-range postback bounced to login for tenant ${tenantId}`);
  }

  // parseRadGrid throws NuLayoutError on a drifted header (FIX A) — let it
  // propagate so the worker records the run as ATTENTION, not a silent OK 0.
  const parsed = parseRadGrid(gridHtml);
  const diag = parsed.diagnostics || null;
  warnOnParseDiagnostics(tenantId, diag, { dateFrom: fromStr, dateTo: toStr });

  const filtered = filterByPickupWindow(parsed, dateFrom, dateTo);
  // Carry the diagnostics forward onto the (new) filtered array so the worker can
  // record the parser-health signal on the ExternalSyncRun.
  if (diag) attachDiagnostics(filtered, diag);
  logger.info('[nu] reservation list fetched (date-range postback)', {
    tenantId,
    dateFrom: fromStr,
    dateTo: toStr,
    parsed: parsed.length,
    afterWindow: filtered.length,
    totalCount: diag?.totalCount ?? null,
    truncated: diag?.truncated ?? false,
  });
  return filtered;
}

/**
 * Filter normalized rows to pickupAt in [dateFrom, dateTo] inclusive. Null
 * bounds mean unbounded on that side. Rows with an unparseable pickupAt are
 * DROPPED when a window is supplied. Pure. Exported for tests.
 */
export function filterByPickupWindow(rows, dateFrom, dateTo) {
  if (!Array.isArray(rows)) return [];
  if (!dateFrom && !dateTo) return rows;
  const fromMs = dateFrom ? new Date(dateFrom).getTime() : null;
  const toMs = dateTo ? new Date(dateTo).getTime() : null;
  return rows.filter((row) => {
    const t = row?.pickupAt instanceof Date ? row.pickupAt.getTime() : null;
    if (t == null || Number.isNaN(t)) return false;
    if (fromMs != null && t < fromMs) return false;
    if (toMs != null && t > toMs) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Auth probe — login + a fresh grid read. Records OK / EXPIRED / ERROR.
// ---------------------------------------------------------------------------
export async function testAuth(tenantId) {
  try {
    await login(tenantId);
    // A no-window fetch confirms the session can render the reservations grid.
    await fetchReservationList(tenantId, {});
    await recordTestStatus(tenantId, 'OK');
    return { ok: true, status: 'OK' };
  } catch (err) {
    if (err instanceof NuAuthExpiredError) {
      await recordTestStatus(tenantId, 'EXPIRED');
      return { ok: false, status: 'EXPIRED', message: err.message };
    }
    await recordTestStatus(tenantId, 'ERROR');
    return { ok: false, status: 'ERROR', message: err.message };
  }
}
