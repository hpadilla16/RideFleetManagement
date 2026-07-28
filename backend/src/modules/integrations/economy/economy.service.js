/**
 * Economy (RezLight) back-office client.
 *
 * Wraps fetch() calls against the RezLight ASP.NET MVC portal
 * (rezlight.economyrentacar.com/Production). All network I/O lives here so the
 * worker, scheduler, and (future) routes stay thin and testable.
 *
 * Public API:
 *   - setCredentials(tenantId, {username, password}, userId) → encrypts + upserts
 *   - getCredentials(tenantId)                               → { username, password }
 *   - login(tenantId)                                        → seeds the cookie jar
 *   - authedFetch(tenantId, path, opts)                      → re-login-once on expiry
 *   - fetchReservationList(tenantId, {dateFrom, dateTo})     → [row, ...] (DataTables)
 *   - fetchReservationDetail(tenantId, rgConfirmation)       → detail seam (see below)
 *   - testAuth(tenantId)                                     → { ok, status }
 *
 * Authentication (confirmed 2026-07-05, PoC + live recon):
 *   RezLight uses plain username + password (NO 2FA / captcha / IP-binding /
 *   proxy — unlike TL). We store the {username, password} as an encrypted JSON
 *   blob in IntegrationCredential.encryptedPayload (AES-256-GCM, same crypto as
 *   TL). Login = GET base '/' → scrape __RequestVerificationToken from the login
 *   <form> → POST url-encoded {username, password, token}. Success is signalled
 *   by a `.AspNet.ApplicationCookie` in the Set-Cookie response (RezLight returns
 *   200, NOT a 302). The session cookie lives in an in-memory per-tenant jar;
 *   authedFetch re-logs-in once if a request bounces to login / 401 / 403.
 *
 * NO Puppeteer, NO cheerio, NO proxy — plain fetch + a tiny cookie jar + regex
 * token scrape (modeled on ops/economy-poc/login-poc.mjs, proven working).
 *
 * See doc/economy-integration-plan-2026-07-05.md
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { decrypt, encrypt } from '../../../lib/integration-crypto.js';
import {
  SOURCE_SYSTEM,
  BASE_URL,
  LIST_PATH,
  AUTHED_PAGE_PATH,
  DETAIL_PATH,
  LOOKUP_COLUMNS,
  LOOKUP_PFILTER,
  LOOKUP_PAGE_SIZE,
  MAX_PAGES,
  RG_DATE_PICKUP_INDEX,
} from './economy.constants.js';

export { SOURCE_SYSTEM, BASE_URL };

// ---------------------------------------------------------------------------
// Detail endpoint command seam (documented constant).
//
// The list row alone (confirmation, class, locations, dates, name, email)
// carries everything needed to create the ExternalReservation. The DETAIL
// endpoint (POST /RezAlliance/Reservations, command-based) enriches with
// flight number and amounts, but the EXACT command param + payload were not
// captured in the 2026-07-05 recon. Rather than block the build, we expose the
// command as a single documented constant that a follow-up capture can adjust
// in one place. Until it's confirmed, fetchReservationDetail returns null (a
// clean seam — the worker treats a null detail as "list-row only").
// TODO(economy-detail): capture the real command/payload and flip
// DETAIL_ENABLED on (or set ECONOMY_DETAIL_COMMAND).
// ---------------------------------------------------------------------------
export const DETAIL_COMMAND = process.env.ECONOMY_DETAIL_COMMAND || null;
export const DETAIL_ENABLED = !!DETAIL_COMMAND;

// ---------------------------------------------------------------------------
// Stealth / UA helpers (mirrors TL). Rotate UA per sync run, randomize sleeps.
// Economy has no anti-bot, but keeping the helpers means the worker can share
// the exact same run-lifecycle shape as TL.
// ---------------------------------------------------------------------------
export const USER_AGENT_POOL = Object.freeze([
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
]);

export function pickUserAgent() {
  if (process.env.ECONOMY_USER_AGENT) return process.env.ECONOMY_USER_AGENT;
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

export const DETAIL_DELAY_MIN_MS = Number(process.env.ECONOMY_DETAIL_DELAY_MIN_MS ?? 500);
export const DETAIL_DELAY_MAX_MS = Number(process.env.ECONOMY_DETAIL_DELAY_MAX_MS ?? 1500);

export class EconomyAuthExpiredError extends Error {
  constructor(message = 'Economy (RezLight) session expired or invalid') {
    super(message);
    this.name = 'EconomyAuthExpiredError';
  }
}

// ---------------------------------------------------------------------------
// Credential storage (Postgres-backed, AES-256-GCM). Stores a JSON
// {username, password} blob (NOT a cookie, unlike TL).
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
      // Reset test status — caller should re-test after rotation.
      lastTestedAt: null,
      lastTestStatus: null,
    },
  });
  // Nuke any stale cookie for this tenant so the next request re-logs-in with
  // the new credentials.
  cookieJars.delete(tenantId);
  logger.info('[economy] credentials rotated', { tenantId, credentialId: row.id });
  return row;
}

// Test seam: tests can inject a credentials resolver so login/authedFetch can
// be exercised without a live DB. Production path is unchanged (null resolver).
let _credentialsResolver = null;

export async function getCredentials(tenantId) {
  if (_credentialsResolver) return _credentialsResolver(tenantId);
  if (!tenantId) throw new EconomyAuthExpiredError('tenantId required to load Economy credentials');
  const row = await prisma.integrationCredential.findUnique({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
  });
  if (!row) throw new EconomyAuthExpiredError(`No IntegrationCredential row for tenant ${tenantId}`);
  if (!row.encryptedPayload) {
    throw new EconomyAuthExpiredError(`IntegrationCredential.encryptedPayload empty for tenant ${tenantId}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(decrypt(row.encryptedPayload));
  } catch (err) {
    throw new EconomyAuthExpiredError(
      `Failed to decrypt/parse Economy credentials for tenant ${tenantId}: ${err.message}`
    );
  }
  if (!parsed?.username || !parsed?.password) {
    throw new EconomyAuthExpiredError(`Economy credentials for tenant ${tenantId} missing username/password`);
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
// Not persisted — a worker restart just re-logs-in on the next request.
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

function hasAuthCookie(tenantId) {
  const jar = cookieJars.get(tenantId);
  return !!jar && jar.has('.AspNet.ApplicationCookie');
}

// Test seam: clear all jars between tests.
export function _resetCookieJarsForTests() {
  cookieJars.clear();
}

/**
 * Drop a tenant's in-memory session so the NEXT authedFetch performs a fresh
 * login. Self-heal seam (QA 2026-07-28): RezLight can serve the LOGIN page
 * with HTTP 200 at authed paths after a server-side session kill, which
 * isLoginBounce (401/403/3xx-only) cannot see — the dead cookie then poisons
 * every subsequent run. Callers clear + re-login instead of trusting the jar.
 */
export function clearSession(tenantId) {
  cookieJars.delete(tenantId);
}

/**
 * A healthy GetReservationLookupRecords response ALWAYS carries a numeric
 * recordsTotal (the account's full ~94k history — an empty account is 0, not
 * missing). A JSON body WITHOUT it (e.g. `{}` / error shell served to an
 * unauthenticated POST) means the session is dead even though the HTTP layer
 * said 200. A bare non-empty array is data (legacy aaData shape) — not dead.
 * Pure. Exported for tests. (QA 2026-07-28: 6h of silent zero-imports.)
 */
export function isDeadLookupResponse(json) {
  if (Array.isArray(json)) return json.length === 0;
  return json?.recordsTotal == null;
}

// ---------------------------------------------------------------------------
// Token scrape (regex — no cheerio). Modeled on the working PoC.
// ---------------------------------------------------------------------------
export function scrapeVerificationToken(html) {
  if (typeof html !== 'string' || !html) return null;
  const m =
    html.match(/name=["']__RequestVerificationToken["']\s+[^>]*value=["']([^"']+)["']/i) ||
    html.match(/value=["']([^"']+)["']\s+name=["']__RequestVerificationToken["']/i);
  return m ? m[1] : null;
}

/**
 * Inspect the first <form> — action + input names. Used at login to preserve
 * any hidden fields and locate the user/pass field names by heuristic.
 * Exported for tests.
 */
export function inspectLoginForm(html) {
  const form = (String(html || '').match(/<form[\s\S]*?<\/form>/i) || [''])[0];
  const action = (form.match(/action=["']([^"']*)["']/i) || [, ''])[1];
  const names = Array.from(form.matchAll(/<input[^>]*name=["']([^"']+)["']/gi)).map((m) => m[1]);
  return { action, inputNames: Array.from(new Set(names)) };
}

// ---------------------------------------------------------------------------
// Raw fetch wrapper (uses the tenant jar, no auto-relogin — that's authedFetch).
// Test seam: a stub fetch can be injected via __setFetch.
// ---------------------------------------------------------------------------
let _fetch = (...args) => globalThis.fetch(...args);

export const __test = {
  setFetch(fn) {
    _fetch = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args);
  },
  setCredentialsResolver(fn) {
    _credentialsResolver = typeof fn === 'function' ? fn : null;
  },
  hasAuthCookie,
  cookieHeaderFor,
};

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

function isLoginBounce(res) {
  if (!res) return false;
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (/login|account\/login|signin|logon/i.test(loc)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Login — seeds the cookie jar. Idempotent per call (always re-logs-in).
// ---------------------------------------------------------------------------
export async function login(tenantId, opts = {}) {
  const { username, password } = await getCredentials(tenantId);
  const userAgent = opts.userAgent || pickUserAgent();

  // 1) GET the login page → scrape token + preserve hidden fields.
  let loginRes = await rawFetch(tenantId, `${BASE_URL}/`, { userAgent });
  let loginHtml = loginRes.status < 400 ? await loginRes.text() : '';
  // Follow a redirect to the login page if the base bounced us there.
  if (loginRes.status >= 300 && loginRes.status < 400) {
    const loc = loginRes.headers.get('location');
    if (loc) {
      const url = loc.startsWith('http') ? loc : `${BASE_URL}${loc.startsWith('/') ? loc : `/${loc}`}`;
      loginRes = await rawFetch(tenantId, url, { userAgent });
      loginHtml = loginRes.status < 400 ? await loginRes.text() : '';
    }
  }

  const form = inspectLoginForm(loginHtml);
  const token = scrapeVerificationToken(loginHtml);
  const userField = form.inputNames.find((n) => /user|login|email/i.test(n)) || 'username';
  const passField = form.inputNames.find((n) => /pass/i.test(n)) || 'password';

  // 2) POST credentials (url-encoded). Preserve any hidden fields empty.
  const body = new URLSearchParams();
  for (const n of form.inputNames) body.set(n, '');
  if (token) body.set('__RequestVerificationToken', token);
  body.set(userField, username);
  body.set(passField, password);

  const actionUrl = form.action
    ? (form.action.startsWith('http')
      ? form.action
      : `${BASE_URL}${form.action.startsWith('/') ? form.action.replace(/^\/Production/i, '') : `/${form.action}`}`)
    : `${BASE_URL}/`;

  const postRes = await rawFetch(tenantId, actionUrl, {
    method: 'POST',
    userAgent,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  // Drain the body so the socket frees; RezLight returns 200 on success.
  await postRes.text().catch(() => {});

  // Success = the auth cookie landed in the jar. RezLight does NOT 302.
  if (!hasAuthCookie(tenantId)) {
    cookieJars.delete(tenantId);
    throw new EconomyAuthExpiredError(
      `Login for tenant ${tenantId} did not yield .AspNet.ApplicationCookie (bad credentials?)`
    );
  }
  logger.info('[economy] login ok', { tenantId });
  return true;
}

// ---------------------------------------------------------------------------
// authedFetch — ensures a session, retries login ONCE on expiry.
// ---------------------------------------------------------------------------
export async function authedFetch(tenantId, path, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;

  // Log in first if we have no auth cookie yet.
  if (!hasAuthCookie(tenantId)) {
    await login(tenantId, { userAgent: opts.userAgent });
  }

  let res = await rawFetch(tenantId, url, opts);
  if (isLoginBounce(res)) {
    // Session expired mid-flight → re-login once and retry.
    logger.info('[economy] session bounce, re-login once', { tenantId, path });
    cookieJars.delete(tenantId);
    await login(tenantId, { userAgent: opts.userAgent });
    res = await rawFetch(tenantId, url, opts);
    if (isLoginBounce(res)) {
      throw new EconomyAuthExpiredError(`Re-login did not restore session for tenant ${tenantId}`);
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// List fetch — GetReservationLookupRecords (DataTables).
//
// Scrapes a fresh __RequestVerificationToken from the authed Reservations page
// first, then POSTs the 3-param body. Optionally narrows to a date window
// client-side by rgDatePickup (the account sees the FULL ~92k history — the
// worker MUST pass a window). Returns the parsed rows array.
// ---------------------------------------------------------------------------
export async function fetchReservationList(tenantId, { dateFrom = null, dateTo = null, length = 100, userAgent } = {}) {
  // 1) Load the authed Reservations page to scrape a fresh token. One token is
  // reused for every page in this run (RezLight accepts the same anti-CSRF
  // token across the paginated DataTables POSTs).
  const pageRes = await authedFetch(tenantId, AUTHED_PAGE_PATH, { userAgent });
  const pageHtml = pageRes.status < 400 ? await pageRes.text() : '';
  let token = scrapeVerificationToken(pageHtml);

  // 2a) No date window (e.g. the testAuth 1-row probe): single page, unbounded.
  //     Keeps the cheap "can we read data?" health check unchanged.
  if (!dateFrom) {
    const json = await fetchLookupPage(tenantId, {
      token, start: 0, length, userAgent,
    });
    const list = json.data || json.aaData || (Array.isArray(json) ? json : []);
    const rows = Array.isArray(list) ? list : [];
    const filtered = filterByPickupWindow(rows, dateFrom, dateTo);
    logger.info('[economy] reservation list fetched (single page)', {
      tenantId,
      recordsTotal: json.recordsTotal ?? null,
      returned: rows.length,
      afterWindow: filtered.length,
    });
    return filtered;
  }

  // 2b) Windowed sync: PAGINATE over rgDatePickup-DESC pages. Accumulate rows
  //     >= dateFrom and STOP as soon as a page crosses below dateFrom (desc
  //     order guarantees no later page can be in-window) OR MAX_PAGES is hit.
  //     This bounds the sweep at LOOKUP_PAGE_SIZE * MAX_PAGES — never the ~92k.
  const fromMs = new Date(dateFrom).getTime();
  const accumulated = [];
  let start = 0;
  let page = 0;
  let recordsTotal = null;
  let crossedBelowFrom = false;

  for (; page < MAX_PAGES; page++) {
    let json = await fetchLookupPage(tenantId, {
      token, start, length: LOOKUP_PAGE_SIZE, userAgent, orderDesc: true,
    });

    // Self-heal (QA 2026-07-28): a page-0 body with NO recordsTotal means the
    // session died server-side but RezLight answered 200 (isLoginBounce can't
    // see it) — without this, every 15-min run "succeeds" importing 0 forever.
    // Heal ONCE per run: fresh login + fresh anti-CSRF token, retry the page.
    // Still dead after that -> throw loud (worker marks the run failed).
    if (page === 0 && isDeadLookupResponse(json)) {
      logger.warn('[economy] lookup response has no recordsTotal — stale session suspected, re-login once', { tenantId });
      clearSession(tenantId);
      const retryRes = await authedFetch(tenantId, AUTHED_PAGE_PATH, { userAgent });
      const retryHtml = retryRes.status < 400 ? await retryRes.text() : '';
      token = scrapeVerificationToken(retryHtml);
      json = await fetchLookupPage(tenantId, {
        token, start, length: LOOKUP_PAGE_SIZE, userAgent, orderDesc: true,
      });
      if (isDeadLookupResponse(json)) {
        throw new EconomyAuthExpiredError(
          `Reservation lookup still has no recordsTotal after re-login for tenant ${tenantId}`
        );
      }
      logger.info('[economy] session self-heal succeeded', { tenantId });
    }

    recordsTotal = json.recordsTotal ?? recordsTotal;
    const pageRows = json.data || json.aaData || (Array.isArray(json) ? json : []);
    const rows = Array.isArray(pageRows) ? pageRows : [];

    for (const row of rows) {
      const raw = row?.rgDatePickup ?? (Array.isArray(row) ? row[RG_DATE_PICKUP_INDEX] : null);
      const t = parseRezDate(raw);
      if (t != null && t < fromMs) {
        // Sorted desc → this row and every row after it is older than dateFrom.
        crossedBelowFrom = true;
        break;
      }
      // >= dateFrom (or unparseable): keep for the final precision filter.
      accumulated.push(row);
    }

    // Stop conditions: crossed below dateFrom, or the server returned a short
    // (final) page — either way no more in-window rows remain.
    if (crossedBelowFrom) break;
    if (rows.length < LOOKUP_PAGE_SIZE) break;
    start += LOOKUP_PAGE_SIZE;
  }

  // Defensive: if the loop exhausted MAX_PAGES WITHOUT crossing below dateFrom,
  // the window is wider than the page cap — surface it rather than silently
  // truncating. (The hard cap still bounds the sweep even if the server ignored
  // our rgDatePickup-desc order.)
  if (!crossedBelowFrom && page >= MAX_PAGES) {
    logger.warn('[economy] reservation list page cap hit before crossing dateFrom', {
      tenantId,
      maxPages: MAX_PAGES,
      pageSize: LOOKUP_PAGE_SIZE,
      scanned: page * LOOKUP_PAGE_SIZE,
      recordsTotal,
      dateFrom,
    });
  }

  // 3) Final in-window precision filter (applies the dateTo upper bound + drops
  //    unparseable rows) over the bounded accumulated set.
  const filtered = filterByPickupWindow(accumulated, dateFrom, dateTo);
  // `page` is the index of the last page fetched (0-based when it broke early,
  // or === MAX_PAGES when the cap was reached). Pages fetched = page unless we
  // broke inside the loop, in which case it's page + 1.
  const pagesFetched = page >= MAX_PAGES ? MAX_PAGES : page + 1;
  logger.info('[economy] reservation list fetched (paginated)', {
    tenantId,
    recordsTotal,
    pagesFetched,
    accumulated: accumulated.length,
    afterWindow: filtered.length,
    crossedBelowFrom,
  });
  return filtered;
}

/**
 * Fetch ONE DataTables lookup page. Builds the 3-param body (token +
 * jsonPaginationParameters + pFilter) and posts it. When orderDesc is set the
 * payload sorts by rgDatePickup DESCENDING so the caller can bound the scan.
 * Returns the parsed JSON (throws EconomyAuthExpiredError on non-JSON).
 */
async function fetchLookupPage(tenantId, { token, start = 0, length = LOOKUP_PAGE_SIZE, userAgent, orderDesc = false } = {}) {
  const columns = LOOKUP_COLUMNS.map((data) => ({
    data,
    name: '',
    searchable: true,
    orderable: true,
    search: { value: '', regex: false },
  }));
  const dtParams = JSON.stringify({
    draw: 1,
    columns,
    order: orderDesc ? [{ column: RG_DATE_PICKUP_INDEX, dir: 'desc' }] : [],
    start: Number.isFinite(start) && start >= 0 ? start : 0,
    length: Number.isFinite(length) && length > 0 ? length : LOOKUP_PAGE_SIZE,
    search: { value: '', regex: false },
  });
  const body = new URLSearchParams();
  if (token) body.set('__RequestVerificationToken', token);
  body.set('jsonPaginationParameters', dtParams);
  body.set('pFilter', JSON.stringify(LOOKUP_PFILTER));

  const res = await authedFetch(tenantId, LIST_PATH, {
    method: 'POST',
    userAgent,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!json) {
    throw new EconomyAuthExpiredError(
      `GetReservationLookupRecords returned non-JSON for tenant ${tenantId} (login/token issue?)`
    );
  }
  return json;
}

/**
 * Filter DataTables rows to those whose rgDatePickup falls in [dateFrom, dateTo]
 * (inclusive). Null bounds mean "unbounded on that side". Rows with an
 * unparseable rgDatePickup are DROPPED when a window is supplied (safer than
 * importing a stray historical row). Pure — exported for tests.
 */
export function filterByPickupWindow(rows, dateFrom, dateTo) {
  if (!Array.isArray(rows)) return [];
  if (!dateFrom && !dateTo) return rows;
  const fromMs = dateFrom ? new Date(dateFrom).getTime() : null;
  const toMs = dateTo ? new Date(dateTo).getTime() : null;
  return rows.filter((row) => {
    const raw = row?.rgDatePickup ?? (Array.isArray(row) ? row[5] : null);
    const t = parseRezDate(raw);
    if (t == null) return false; // drop unparseable rows when windowing
    if (fromMs != null && t < fromMs) return false;
    if (toMs != null && t > toMs) return false;
    return true;
  });
}

/**
 * Parse a RezLight date field into epoch ms, or null.
 * Handles ISO strings, common US "M/D/YYYY[ h:mm]" strings, and ASP.NET
 * "/Date(1234567890000)/" wire format. Exported for tests.
 */
export function parseRezDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  // ASP.NET "/Date(ms)/"
  const aspNet = s.match(/\/Date\((\d+)([-+]\d+)?\)\//);
  if (aspNet) {
    const ms = Number(aspNet[1]);
    return Number.isFinite(ms) ? ms : null;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// ---------------------------------------------------------------------------
// Detail fetch — documented seam (see DETAIL_COMMAND above).
// ---------------------------------------------------------------------------
export async function fetchReservationDetail(tenantId, rgConfirmation, opts = {}) {
  if (!DETAIL_ENABLED) {
    // Seam: the list row alone is enough to stage the ExternalReservation.
    // Enrichment (flight, amounts) is a TODO pending a captured command.
    return null;
  }
  const body = new URLSearchParams();
  body.set('command', DETAIL_COMMAND);
  body.set('rgConfirmation', String(rgConfirmation));
  try {
    const res = await authedFetch(tenantId, DETAIL_PATH, {
      method: 'POST',
      userAgent: opts.userAgent,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch (err) {
    if (err instanceof EconomyAuthExpiredError) throw err;
    logger.warn('[economy] detail fetch failed', { tenantId, rgConfirmation, message: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auth probe — login + a 1-row list. Records OK / EXPIRED / ERROR.
// ---------------------------------------------------------------------------
export async function testAuth(tenantId) {
  try {
    await login(tenantId);
    // A tiny list confirms the session can actually read data (not just that a
    // cookie appeared). No date window — we only care that a JSON came back.
    await fetchReservationList(tenantId, { length: 1 });
    await recordTestStatus(tenantId, 'OK');
    return { ok: true, status: 'OK' };
  } catch (err) {
    if (err instanceof EconomyAuthExpiredError) {
      await recordTestStatus(tenantId, 'EXPIRED');
      return { ok: false, status: 'EXPIRED', message: err.message };
    }
    await recordTestStatus(tenantId, 'ERROR');
    return { ok: false, status: 'ERROR', message: err.message };
  }
}
