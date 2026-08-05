/**
 * Mex (TSD RezCentral) back-office client.
 *
 * All network I/O against rezcentral.tsdasp.net lives here so the worker,
 * scheduler and routes stay thin and testable.
 *
 * Public API:
 *   - setCredentials(tenantId, {username, password}, userId) → encrypts + upserts
 *   - getCredentials(tenantId)                               → { username, password }
 *   - login(tenantId)                                        → seeds the cookie jar
 *   - forceRelogin(tenantId)                                 → discard jar + re-login now
 *   - fetchTMSummary(tenantId, {tsdNumber, branch, from, to}) → [normalizedRow, ...]
 *   - fetchEmailReport(tenantId, {tsdNumber, branch, from, to}) → [emailRow, ...]
 *   - joinEmailsByConfirm(tmRows, emailRows)                 → tmRows + customerEmail
 *   - testAuth(tenantId)                                     → { ok, status }
 *
 * AUTHENTICATION (autonomous, NO captcha — recon 2026-07-14 Fase 0 PASS):
 *   Clean ASP.NET WebForms. GET the app root → scrape EVERY hidden input with its
 *   value (__VIEWSTATE, __VIEWSTATEGENERATOR, …) → POST them back to
 *   WebLogin.aspx plus txtUserID/txtPwd and the image-button COORDINATES
 *   (imgLogin.x / imgLogin.y — WebForms ignores an image submit posted by name
 *   alone). No CAPTCHA, no Imperva/Cloudflare → plain fetch + cookie jar, NO
 *   headless browser and no residential proxy needed. A bounce back to the login
 *   form triggers a single silent re-login.
 *
 * NAVIGATION — the single-window rule:
 *   TSD RezCentral is SINGLE-WINDOW STRICT. Deep-linking a .aspx breaks the
 *   session, so we navigate the way the UI does: POST back to the CURRENT page
 *   with __EVENTTARGET=_ctl0$Menu1 and __EVENTARGUMENT='Reports POS\Estimated T&M
 *   Summary', re-sending the page's viewstate. Every request below goes through
 *   that seam; the only .aspx we ever address by URL is the login form. The menu
 *   path IS the report selector — there is no cmbReport dropdown (VALIDATED-FALSE
 *   2026-07-17: each report is its own menu item rendering its own page).
 *
 * DATE RANGE — everything on this screen is a POSTBACK (measured 2026-07-17):
 *   - `lstRunBy` picks WHICH DATE COLUMN the report ranges on. We send
 *     `Date Out` (pickup) EXPLICITLY on every postback of every fetch. This is
 *     what resolves MC3: the booked-vs-pickup ambiguity was never a mystery to
 *     diagnose, it is a parameter to set.
 *   - CalFrom/CalTo are ASP.NET Calendar SERVER CONTROLS (<table>), NOT text
 *     inputs. A day is selected by __doPostBack('_ctl0$cphMaster1$CalFrom',
 *     '<days since 2000-01-01>'). The old `CalFrom=07/15/2026` posted a key
 *     ASP.NET does not know → silently ignored → the server's ViewState default
 *     range → a green run over the wrong window.
 *   - `Current MTD` (cmdMonthTD) is a plain submit that only SETS the range;
 *     Button1 then RUNS the report. Two postbacks, sequenced — never one body
 *     carrying both (ambiguous RaisePostBackEvent).
 *   See mex.constants.js's DATE RANGE block for the full measured record.
 *
 * PARSING:
 *   Both reports render INLINE into the same DataGrid (_ctl0_cphMaster1_dgRates)
 *   with NO pagination (552 rows in one page) and no CSV export → we parse the
 *   HTML table. Columns are resolved BY HEADER NAME, not by position, and a
 *   missing required header raises MexLayoutError instead of importing a
 *   shifted mapping (the NU RadGrid drift lesson).
 *
 * MONEY: this module only READS. `Total Bill` becomes estimatedTotal downstream;
 * Mex is 100% Pay on Arrival → isPrepaid is always false. No charge path.
 *
 * See doc/mex-integration-plan-2026-07-13.md
 */

import logger from '../../../lib/logger.js';
import { parseDateTimeInTz } from '../../../lib/date-utils.js';
import {
  AuthExpiredError,
  createCredentialStore,
  makePickUserAgent,
  randomDelay,
  sleep,
} from '../booking-source/http-common.js';
import { parseReservationDetail } from './mex-reservation-detail.js';
import {
  MENU_PATH_REZ_CANCEL,
  MENU_TEXT_REZ_CANCEL,
  DETAIL_FIELD,
  DETAIL_VIEW_VALUE,
  MENU_TEXT_TM_SUMMARY,
  MENU_PATH_RATE_UPDATE_1,
  MENU_TEXT_RATE_UPDATE_1,
  SOURCE_SYSTEM,
  BASE_URL,
  ROOT_PATH,
  LOGIN_PATH,
  LOGIN_USER_FIELD,
  LOGIN_PASS_FIELD,
  LOGIN_IMAGE_BUTTON,
  LOGIN_IMAGE_X,
  LOGIN_IMAGE_Y,
  SESSION_COOKIE_NAME,
  MENU_EVENT_TARGET,
  MENU_PATH_TM_SUMMARY,
  FIELD,
  CAL_TARGET,
  REPORT,
  RUN_BY_VALUE,
  GRID_ID_SUFFIX,
  GRID_FOOTER_COUNT_RE,
  RANGE_MODE,
  RANGE_MODES,
  RANGE_SHORTCUT_FIELD,
  RANGE_SHORTCUT_VALUE,
  SUBMIT_VALUE,
  TM_COL,
  TM_REQUIRED_HEADERS,
  TM_EXPECTED_COLUMN_COUNT,
  EMAIL_COL,
  EMAIL_REQUIRED_HEADERS,
  STATUS,
  TIME_ZONE,
  toIsoFromTsdDate,
  toCalendarDaySerial,
  toMonthOptionLabel,
  mtdCoverageBounds,
} from './mex.constants.js';

export { SOURCE_SYSTEM, BASE_URL, randomDelay, sleep };

// ---------------------------------------------------------------------------
// Source-specific error types (own names for instanceof / Sentry grouping).
// ---------------------------------------------------------------------------
export class MexAuthExpiredError extends AuthExpiredError {
  constructor(message = 'Mex (TSD RezCentral) session expired or invalid') {
    super(message);
    this.name = 'MexAuthExpiredError';
  }
}

/**
 * Raised when the DataGrid renders but its HEADER columns have drifted from the
 * validated map (a required header is gone). Distinct from an auth/empty failure
 * so the worker records the run as ATTENTION rather than a silent "OK 0" —
 * importing a shifted mapping would corrupt estimatedTotal / the cancel status.
 * Mirrors NuLayoutError.
 */
export class MexLayoutError extends Error {
  constructor(message = 'Mex DataGrid layout drifted from the expected column mapping') {
    super(message);
    this.name = 'MexLayoutError';
  }
}

// Stealth: rotate UA per run, pinnable via MEX_USER_AGENT (shared pool).
export const pickUserAgent = makePickUserAgent('MEX_USER_AGENT');

// ---------------------------------------------------------------------------
// In-memory per-tenant cookie jar. Map<tenantId, Map<cookieName, value>>. TSD
// auth is the ASP.NET_SessionId cookie (session-based, like NU).
// ---------------------------------------------------------------------------
const cookieJars = new Map();

// Tenants whose jar has been PROVEN authenticated by a successful login(). The
// ASP.NET_SessionId cookie alone does not mean authenticated — the pre-login GET
// already sets it (see hasSessionCookie). Cleared with the jar on every
// bounce/rotation/logout path.
const authenticatedJars = new Set();

// Per-session URL token (2026-08-05 activation fix). RezCentral hands out a
// FRESH `?id=` on login — the entry token routes you to the right account's
// login form, but every authenticated page carries a different, per-session
// one (observed live: entry vufnda45gf12r2ifchif -> session sbrcynfuqssacs45e1m0).
// Navigating to the bare app root without it bounces straight back to
// WebLogin, which is exactly what "[mex] login ok" followed by "menu postback
// bounced to login" looked like on IRC's first activation attempt.
const sessionTokens = new Map();

// Where the app actually lives once authenticated. CRITICAL (2026-08-05): the
// app ROOT (`/WebRezClient/`) serves WebLogin.aspx — with or without a token —
// so re-GETting it for a fresh viewstate lands you on the login form and every
// subsequent postback "bounces". The authenticated page is the landing the
// login redirect names (rcRezCentral.aspx?id=<session>).
const sessionLandings = new Map();

function dropJar(tenantId) {
  cookieJars.delete(tenantId);
  authenticatedJars.delete(tenantId);
  sessionTokens.delete(tenantId);
  sessionLandings.delete(tenantId);
}

/** Pure: pull the `id` query value out of a URL or a form action. */
export function extractSessionToken(urlOrAction) {
  const m = String(urlOrAction || '').match(/[?&]id=([^&"'\s]+)/i);
  return m ? m[1] : null;
}

/**
 * Pure: the first `?id=` a landed page reveals — the redirect Location wins
 * (most explicit), then the form action, then any app-page link.
 */
export function findSessionToken({ location = '', html = '' } = {}) {
  const fromLocation = extractSessionToken(location);
  if (fromLocation) return fromLocation;
  const action = String(html || '').match(/<form[^>]+action="([^"]+)"/i);
  const fromAction = action ? extractSessionToken(action[1]) : null;
  if (fromAction) return fromAction;
  return extractSessionToken(String(html || '').match(/(?:href|action)="[^"]*\.aspx\?id=[^"]+"/i)?.[0] || '');
}

/**
 * Pure: every menu item the page advertises, as {target, argument, text}.
 *
 * RezCentral renders menu items as
 *   <a href="javascript:__doPostBack('_ctl0$Menu1','Reports POS\\Estimated TM Report')">
 *     Estimated T&M Summary</a>
 * — the postback ARGUMENT is the item's VALUE, which differs from the visible
 * TEXT. Reading it off the page is the same discipline the report parser uses
 * for columns: resolve by label, never by a hardcoded guess.
 */
export function parseMenuItems(html) {
  const out = [];
  const re = /<a[^>]+href="javascript:__doPostBack\('([^']+)','([^']*)'\)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    // The href is a JS string literal inside HTML: '\\' is one backslash.
    const argument = m[2].replace(/\\\\/g, '\\').replace(/\\'/g, "'");
    const text = decodeEntities(m[3].replace(/<[^>]+>/g, '')).trim();
    out.push({ target: m[1], argument, text });
  }
  return out;
}

/**
 * Pure: the argument to post for a menu destination.
 *
 * Preference order, all read off the LIVE page:
 *   1. the exact path the caller asked for, if the menu advertises it
 *   2. an item whose visible TEXT matches `menuText` (portal renamed the value)
 *   3. an item whose LEAF path matches case-insensitively
 *   4. the caller's path unchanged — let the portal decide
 */
export function resolveMenuArgument(html, { menuPath, menuText = null } = {}) {
  const items = parseMenuItems(html);
  const path = String(menuPath || '');
  if (items.some((i) => i.argument === path)) return path;
  if (menuText) {
    const byText = items.find((i) => i.text.toLowerCase() === String(menuText).trim().toLowerCase());
    if (byText) return byText.argument;
  }
  const leaf = path.split('\\').pop().trim().toLowerCase();
  if (leaf) {
    const byLeaf = items.find((i) => i.argument.split('\\').pop().trim().toLowerCase() === leaf);
    if (byLeaf) return byLeaf.argument;
  }
  return path;
}

/**
 * Pure: does the live menu actually offer this destination?
 *
 * Not every TSD account exposes every report. MEX's SJU account advertises 13
 * Reports POS items and NONE of them is the Email Address Report the Advantage
 * clone assumed — navigating there just re-renders the Main Menu, whose columns
 * then fail the email grid's header guard as "drift". Asking first turns an
 * alarming false drift into a plain, true statement: this portal has no such
 * report.
 */
export function menuOffers(html, { menuPath, menuText = null } = {}) {
  const items = parseMenuItems(html);
  const path = String(menuPath || '');
  if (items.some((i) => i.argument === path)) return true;
  if (menuText && items.some((i) => i.text.toLowerCase() === String(menuText).trim().toLowerCase())) return true;
  const leaf = path.split('\\').pop().trim().toLowerCase();
  return !!leaf && items.some((i) => i.argument.split('\\').pop().trim().toLowerCase() === leaf);
}

/**
 * Pure: does the page render this menu path's SECTION at all?
 * `Reports POS\\Email Address Report` → true when the page advertises any
 * other `Reports POS\\…` item. Without that, we have no standing to say the
 * destination is missing.
 */
export function menuSectionRendered(html, menuPath) {
  const section = String(menuPath || '').split('\\')[0].trim().toLowerCase();
  if (!section) return false;
  return parseMenuItems(html)
    .some((i) => i.argument.split('\\')[0].trim().toLowerCase() === section);
}

/** Raised when the portal simply does not carry a report we asked for. */
export class MexReportUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'MexReportUnavailableError'; }
}

/** Pure: the postback argument for a menu item, matched on its visible text. */
export function findMenuArgumentByText(html, linkText) {
  const wanted = String(linkText || '').trim().toLowerCase();
  if (!wanted) return null;
  const item = parseMenuItems(html).find((x) => x.text.toLowerCase() === wanted);
  return item ? item.argument : null;
}

/** The app root for THIS tenant's session, carrying the token when we have one. */
function rootPathFor(tenantId) {
  const landing = sessionLandings.get(tenantId);
  if (landing) return landing;
  const token = sessionTokens.get(tenantId);
  if (!token) return ROOT_PATH;
  return ROOT_PATH.includes('?') ? `${ROOT_PATH}&id=${token}` : `${ROOT_PATH}?id=${token}`;
}

/**
 * Re-attach the session token to a resolved action that lost it. WebForms
 * actions are frequently query-less ("rcUpdateRates1a.aspx"), and posting
 * there without the token bounces.
 */
function withSessionToken(tenantId, resolved) {
  const token = sessionTokens.get(tenantId);
  if (!token || !resolved || /[?&]id=/i.test(resolved)) return resolved;
  return resolved.includes('?') ? `${resolved}&id=${token}` : `${resolved}?id=${token}`;
}

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
    const sc = res.headers.get?.('set-cookie');
    if (sc) cookies = [sc];
  }
  for (const c of cookies) {
    const [pair] = String(c).split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeaderFor(tenantId) {
  const jar = cookieJars.get(tenantId);
  if (!jar || jar.size === 0) return '';
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Does the jar hold an AUTHENTICATED session?
 *
 * NOT "any cookie" (Innovation NIT, 2026-07-16). ASP.NET issues ASP.NET_SessionId
 * on the PRE-LOGIN GET — the login form itself sets it — so `jar.size > 0` is
 * true for a jar that has never authenticated. That made:
 *   - login()'s own success check (`bounced || !hasSessionCookie`) pass on the
 *     strength of a cookie the login page handed us before we typed anything, and
 *   - ensureSession() skip logging in entirely for an unauthenticated jar.
 * Both then rely on the bounce-detector to clean up after the fact.
 *
 * TSD has no separate forms-auth cookie, so "authenticated" cannot be read off a
 * cookie NAME. We track it explicitly: login() marks the jar authenticated only
 * after the response proves we are past WebLogin, and any bounce/rotation clears
 * the jar (and with it the mark).
 */
function hasSessionCookie(tenantId) {
  const jar = cookieJars.get(tenantId);
  if (!jar) return false;
  // The session cookie must exist AND login() must have vouched for it.
  return jar.has(SESSION_COOKIE_NAME) && authenticatedJars.has(tenantId);
}

export function _resetCookieJarsForTests() {
  cookieJars.clear();
  authenticatedJars.clear();
}

// ---------------------------------------------------------------------------
// Credential storage (Postgres-backed, AES-256-GCM) via the shared store.
// onRotated nukes the tenant's jar so a rotation forces a fresh login.
// ---------------------------------------------------------------------------
const credentialStore = createCredentialStore({
  sourceSystem: SOURCE_SYSTEM,
  sourceLabel: 'Mex',
  logPrefix: '[mex]',
  AuthError: MexAuthExpiredError,
  onRotated: (tenantId) => dropJar(tenantId),
});

export const setCredentials = credentialStore.setCredentials;
export const getCredentials = credentialStore.getCredentials;
const recordTestStatus = credentialStore.recordTestStatus;

// ---------------------------------------------------------------------------
// Test seam. Tests inject a stub fetch so login / navigation / parsing can be
// exercised without touching the live portal.
// ---------------------------------------------------------------------------
let _fetch = (...args) => globalThis.fetch(...args);

export const __test = {
  setFetch(fn) {
    _fetch = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args);
  },
  setCredentialsResolver(fn) {
    credentialStore.setCredentialsResolver(fn);
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
  const res = await _fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      'User-Agent': userAgent,
      ...(cookieHeaderFor(tenantId) ? { Cookie: cookieHeaderFor(tenantId) } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body,
    redirect: 'manual',
    signal: opts.signal,
  });
  absorbSetCookie(tenantId, res);
  return res;
}

/**
 * A response is a "bounce to login" when it 401/403s, redirects at the login
 * page, or renders the login form's own fields. TSD has no forms-auth cookie —
 * an expired session round-trips back to WebLogin.aspx.
 */
function isLoginBounce(res, bodyText = '') {
  if (!res) return false;
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get?.('location') || '';
    if (/WebLogin\.aspx|login/i.test(loc)) return true;
  }
  if (bodyText && new RegExp(
    `WebLogin\\.aspx|name=["'][^"']*${escapeRegExp(LOGIN_PASS_FIELD)}["']`, 'i'
  ).test(bodyText)) return true;
  return false;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ===========================================================================
// WebForms plumbing.
//
// ASP.NET WebForms requires EVERY hidden field to be re-posted with its rendered
// value (__VIEWSTATE, __VIEWSTATEGENERATOR, __EVENTVALIDATION). We scrape the
// whole <form> and echo it back, overriding only what we mean to change. Same
// approach as nu.service.js — kept local rather than shared because NU's copy is
// load-bearing for a live integration and this build must not touch it.
// ===========================================================================

/**
 * Parse a WebForms <form>: its action + a { name → {value, type} } map of every
 * <input>, plus each <select>'s currently-selected option value. Pure. Exported
 * for tests.
 *
 * SELECTS matter here in a way they don't for NU: the report screen's filters
 * (cmbReport / lstTSDNumber / lstBranch / lstClass / …) are <select>s, and a
 * WebForms postback must carry each one's value. Re-sending the SELECTED option
 * preserves "*ALL"-style defaults for the filters we don't drive.
 */
export function parseWebFormsForm(html) {
  const s = String(html || '');
  const form = (s.match(/<form[\s\S]*?<\/form>/i) || [''])[0];
  const action = (form.match(/action=["']([^"']*)["']/i) || [, ''])[1];
  const fields = {};

  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = parseTagAttributes(m[0]);
    const name = attrs.name;
    if (!name) continue;
    const type = (attrs.type || 'text').toLowerCase();
    // Unchecked checkboxes/radios are NOT submitted by a real browser.
    if ((type === 'checkbox' || type === 'radio') && !('checked' in attrs)) continue;
    if (!(name in fields)) fields[name] = { value: attrs.value ?? '', type };
  }

  for (const m of form.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const attrs = parseTagAttributes(`<select${m[1]}>`);
    const name = attrs.name;
    if (!name || name in fields) continue;
    const multiple = 'multiple' in attrs;
    const chosen = selectedOptionValues(m[2]);
    // A MULTI-select with nothing selected submits NOTHING in a browser.
    // Echoing back the first option instead silently applies a filter the user
    // never chose — on the T&M screen that meant posting lstSystem=Amadeus,
    // narrowing the report to one booking system and returning "No records
    // found" for a branch that had reservations from several (IRC, 2026-08-05).
    if (multiple && chosen.length === 0) continue;
    fields[name] = {
      // First selected keeps the historical single-value shape for callers.
      value: chosen.length ? chosen[0] : selectedOptionValue(m[2]),
      values: chosen,
      multiple,
      type: 'select',
    };
  }

  return { action, fields };
}

/**
 * Decode the HTML entities an attribute value can carry, WITHOUT touching
 * whitespace or tags (unlike cellText, which would mangle a __VIEWSTATE blob).
 *
 * Load-bearing: the report screen renders `*Estimated T&M Summary` as
 * value="*Estimated T&amp;M Summary". Echoing the raw `&amp;` back would post a
 * report name the server has never heard of. Pure. Exported for tests.
 */
export function decodeEntities(raw) {
  return String(raw == null ? '' : raw)
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    // &amp; LAST — decoding it first would turn "&amp;lt;" into "<".
    .replace(/&amp;/gi, '&');
}

/** Attributes of one start-tag → lowercased-key map (order agnostic, decoded). */
function parseTagAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  let first = true;
  while ((m = re.exec(tag))) {
    if (first) { first = false; continue; } // skip the tag name itself
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

/**
 * Value of a <select>'s SELECTED <option> (falls back to the FIRST option, which
 * is what a browser submits when nothing is marked selected). An option with no
 * value attribute submits its TEXT. '' when the select is empty.
 */
/**
 * Pure: every explicitly-selected option value, in document order. Empty when
 * the select has no selection at all — which for a MULTI-select is meaningful
 * (submit nothing) and for a single select just means "browser picks the first".
 */
function selectedOptionValues(optionsHtml) {
  const body = String(optionsHtml || '');
  const optRe = /<option\b([^>]*)>([^<]*)/gi;
  const out = [];
  let m;
  while ((m = optRe.exec(body))) {
    if (!/(^|\s)selected(\s|=|\/|>|$)/i.test(m[1])) continue;
    const attrs = parseTagAttributes(`<option${m[1]}>`);
    out.push('value' in attrs ? attrs.value : cellText(m[2]));
  }
  return out;
}

function selectedOptionValue(optionsHtml) {
  const body = String(optionsHtml || '');
  // Options may be UNCLOSED in old WebForms markup → match the label as text up
  // to the next tag, not up to a </option> that may not be there (the Flexways
  // cbCategoria lesson).
  const optRe = /<option\b([^>]*)>([^<]*)/gi;
  let first = null;
  let m;
  while ((m = optRe.exec(body))) {
    const attrs = parseTagAttributes(`<option${m[1]}>`);
    const value = 'value' in attrs ? attrs.value : cellText(m[2]);
    if (first === null) first = value;
    // Match a bare `selected` / selected="selected" — never a data-selected="0"
    // or class="selected" false positive.
    if (/(^|\s)selected(\s|=|\/|>|$)/i.test(m[1])) return value;
  }
  return first ?? '';
}

/**
 * The last `:`/`$`-separated segment of a WebForms control name.
 * "_ctl0:cphMaster1:cmbReport" → "cmbReport". Pure. Exported for tests.
 */
export function fieldSuffix(name) {
  const parts = String(name || '').split(/[:$]/);
  return parts[parts.length - 1] || '';
}

/**
 * Build the POST body for a WebForms postback: echo every scraped field, then
 * apply `overrides` keyed by control-name SUFFIX (so the `_ctl0:cphMaster1:`
 * naming container can change without breaking us). Submit/image inputs are
 * dropped — only the control we actually "click" may be posted, and the caller
 * adds it via `overrides` / `extra`. Pure. Exported for tests.
 *
 * @param {object} fields    from parseWebFormsForm
 * @param {object} overrides { <suffix>: value }
 * @param {object} extra     literal name→value pairs appended verbatim
 */
export function buildPostBody(fields, overrides = {}, extra = {}) {
  const body = new URLSearchParams();
  for (const [name, meta] of Object.entries(fields || {})) {
    if (meta.type === 'submit' || meta.type === 'image') continue;
    const suffix = fieldSuffix(name);
    // NEVER post chkSummary. It is measured unchecked, and it must stay that way:
    // checked, the grid collapses to summary totals and the per-reservation detail
    // rows the parser needs are gone. parseWebFormsForm already drops an unchecked
    // checkbox (a browser does not submit one), so this only bites if TSD ever
    // renders it pre-checked — in which case echoing it back would silently change
    // the report's shape. Cheap belt to the layout guard's braces.
    if (suffix === FIELD.SUMMARY) continue;
    if (Object.hasOwn(overrides, suffix)) {
      body.set(name, String(overrides[suffix]));
      continue;
    }
    // A multi-select posts one pair PER selected option, not just the first.
    if (meta.multiple && Array.isArray(meta.values) && meta.values.length > 1) {
      for (const v of meta.values) body.append(name, String(v));
      continue;
    }
    body.set(name, meta.value || '');
  }
  for (const [name, value] of Object.entries(extra || {})) body.set(name, String(value));
  return body;
}

/**
 * The __EVENTTARGET string for a control, resolved from the page's own rendered
 * name: WebForms renders the NAME with `:` separators but expects __EVENTTARGET
 * with `$` ("_ctl0:cphMaster1:CalFrom" → "_ctl0$cphMaster1$CalFrom"). Returns null
 * when the control isn't on the page. Pure. Exported for tests.
 *
 * Note CalFrom/CalTo are Calendar TABLES, not inputs, so they are not in `fields`
 * at all — callers resolve their target from a sibling field's naming container
 * (see namingContainerOf). This helper serves the SELECTS (lstFromMonth/lstToMonth).
 */
export function eventTargetFor(fields, suffix) {
  const name = findFieldName(fields, suffix);
  return name ? name.replace(/:/g, '$') : null;
}

/**
 * The naming-container prefix shared by the screen's controls, derived from any
 * rendered field (e.g. "_ctl0:cphMaster1:lstRunBy" → "_ctl0$cphMaster1$").
 *
 * Needed because the Calendar controls are <table>s: they are never in the form's
 * field list, so their __EVENTTARGET cannot be looked up — it has to be built.
 * Prefer a control we KNOW lives in the same container as the calendars. Returns
 * '' when nothing on the page carries a container. Pure. Exported for tests.
 */
export function namingContainerOf(fields, preferSuffixes = [FIELD.RUN_BY, FIELD.SUBMIT, FIELD.TSD_NUMBER]) {
  const names = Object.keys(fields || {});
  const pick = preferSuffixes.map((s) => findFieldName(fields, s)).find(Boolean)
    // Fall back to any field that HAS a container.
    || names.find((n) => /[:$]/.test(n));
  if (!pick) return '';
  const parts = String(pick).split(/[:$]/);
  parts.pop();
  return parts.length ? `${parts.join('$')}$` : '';
}

/**
 * Options of a <select> identified by name SUFFIX → [{ value, label, selected }].
 * Returns [] when the select isn't on the page. Pure. Exported for tests.
 *
 * Tolerates UNCLOSED <option> tags (old WebForms markup — the Flexways cbCategoria
 * lesson) and an option with no value attribute (which submits its TEXT).
 */
export function parseSelectOptions(html, suffix) {
  const s = String(html || '');
  for (const m of s.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const attrs = parseTagAttributes(`<select${m[1]}>`);
    if (!attrs.name || fieldSuffix(attrs.name) !== suffix) continue;
    const options = [];
    for (const o of String(m[2]).matchAll(/<option\b([^>]*)>([^<]*)/gi)) {
      const oAttrs = parseTagAttributes(`<option${o[1]}>`);
      const label = cellText(o[2]);
      options.push({
        value: 'value' in oAttrs ? oAttrs.value : label,
        label,
        selected: /(^|\s)selected(\s|=|\/|>|$)/i.test(o[1]),
      });
    }
    return options;
  }
  return [];
}

/**
 * The option VALUE whose label (or value) equals `label`, case-insensitively.
 * null when the select or the option isn't there — the caller must then NOT post
 * a guessed month (posting a wrong month is worse than posting none). Pure.
 */
export function findOptionValueByLabel(options, label) {
  const want = cellText(label).toLowerCase();
  if (!want) return null;
  const hit = (options || []).find((o) => cellText(o.label).toLowerCase() === want)
    || (options || []).find((o) => cellText(o.value).toLowerCase() === want);
  return hit ? hit.value : null;
}

/** The currently-selected option of a parsed select ([] → null). Pure. */
export function selectedOptionOf(options) {
  const list = options || [];
  return list.find((o) => o.selected) || list[0] || null;
}

/**
 * Find the FULL rendered name of a control by its suffix (e.g. 'Button1' →
 * '_ctl0:cphMaster1:Button1'). Returns null when the control isn't on the page.
 * Pure. Exported for tests.
 */
export function findFieldName(fields, suffix) {
  for (const name of Object.keys(fields || {})) {
    if (fieldSuffix(name) === suffix) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Login — seeds the cookie jar. GET the app root for a fresh viewstate, POST it
// back to WebLogin.aspx with the credentials + the image-button coordinates.
// ---------------------------------------------------------------------------
export async function login(tenantId, opts = {}) {
  const { username, password } = await getCredentials(tenantId);
  const userAgent = opts.userAgent || pickUserAgent();

  dropJar(tenantId); // never mix a stale session into a fresh login

  // 1) GET the LOGIN_PATH — MEX-only divergence from Advantage (QA
  //    2026-07-26): MEX's entry URL carries an account token
  //    (?id=vufnda45gf12r2ifchif) that routes TSD to the MEX account's login
  //    form. Advantage GETs the bare app root; doing that here would never
  //    send the token, making it dead code and risking a wrong-account login
  //    at activation.
  const rootUrl = absUrl(LOGIN_PATH);
  const getRes = await rawFetch(tenantId, rootUrl, { userAgent });
  const loginHtml = getRes.status < 400 ? await getRes.text().catch(() => '') : '';
  const { action, fields } = parseWebFormsForm(loginHtml);

  // 2) POST every scraped field back, plus credentials + the IMAGE BUTTON
  //    coordinates (imgLogin.x/.y — WebForms only fires the image submit when
  //    the coordinate pair is present; the control name alone does nothing).
  const userField = findFieldName(fields, LOGIN_USER_FIELD) || LOGIN_USER_FIELD;
  const passField = findFieldName(fields, LOGIN_PASS_FIELD) || LOGIN_PASS_FIELD;
  const imageField = findFieldName(fields, LOGIN_IMAGE_BUTTON) || LOGIN_IMAGE_BUTTON;
  const body = buildPostBody(fields, {}, {
    [userField]: username,
    [passField]: password,
    [`${imageField}.x`]: LOGIN_IMAGE_X,
    [`${imageField}.y`]: LOGIN_IMAGE_Y,
  });

  // If the form action resolves to WebLogin.aspx WITHOUT a query, re-append
  // the entry token so the credential POST stays routed to the MEX account.
  let resolvedAction = action ? resolveAction(action, ROOT_PATH) : LOGIN_PATH;
  if (/WebLogin\.aspx$/i.test(resolvedAction) && LOGIN_PATH.includes('?')) {
    resolvedAction += LOGIN_PATH.slice(LOGIN_PATH.indexOf('?'));
  }
  const actionUrl = absUrl(resolvedAction);
  const postRes = await rawFetch(tenantId, actionUrl, {
    method: 'POST',
    userAgent,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE_URL,
      referer: rootUrl,
    },
    body: body.toString(),
  });
  const postBody = await postRes.text().catch(() => '');

  // Success = we no longer see the login form. TSD answers a good login with
  // either a 302 to the landing page or a 200 rendering it directly.
  const bounced = isLoginBounce(postRes, postBody);
  let landedHtml = postBody;
  // Capture the per-session token the moment it appears — everything after
  // login must carry it (see sessionTokens above).
  const postLocation = postRes.headers?.get?.('location') || '';
  const tokenFromPost = findSessionToken({ location: postLocation, html: postBody });
  if (tokenFromPost) sessionTokens.set(tenantId, tokenFromPost);
  // The redirect names the authenticated page — remember it; the app root is
  // the LOGIN form, not the app (see sessionLandings).
  if (postLocation) sessionLandings.set(tenantId, resolveAction(postLocation, ROOT_PATH));
  if (!bounced && postRes.status >= 300 && postRes.status < 400) {
    const loc = postLocation;
    if (loc) {
      const follow = await rawFetch(tenantId, absUrl(resolveAction(loc, ROOT_PATH)), { userAgent });
      landedHtml = follow.status < 400 ? await follow.text().catch(() => '') : '';
      const tokenFromLanding = findSessionToken({ location: loc, html: landedHtml });
      if (tokenFromLanding) sessionTokens.set(tenantId, tokenFromLanding);
      if (isLoginBounce(follow, landedHtml)) {
        dropJar(tenantId);
        throw new MexAuthExpiredError(
          `Login for tenant ${tenantId} bounced back to WebLogin (bad credentials?)`
        );
      }
    }
  }

  // The session cookie must be present — but presence alone proves nothing (the
  // pre-login GET already set it), so the real evidence is `!bounced`: the POST
  // did not land us back on WebLogin.
  if (bounced || !cookieJars.get(tenantId)?.has(SESSION_COOKIE_NAME)) {
    dropJar(tenantId);
    throw new MexAuthExpiredError(
      `Login for tenant ${tenantId} did not establish an authenticated TSD session (bad credentials?)`
    );
  }

  // Vouch for the jar: from here on hasSessionCookie() reports authenticated, so
  // ensureSession() will reuse it instead of re-logging-in on every request.
  authenticatedJars.add(tenantId);

  logger.info('[mex] login ok', { tenantId });
  return { ok: true, html: landedHtml };
}

/** Resolve a form action / Location header against the app path. */
function resolveAction(action, basePath) {
  const a = String(action || '').trim();
  if (!a) return basePath;
  if (a.startsWith('http') || a.startsWith('/')) return a;
  const dir = basePath.endsWith('/') ? basePath : basePath.replace(/[^/]*$/, '');
  return `${dir}${a.replace(/^\.\//, '')}`;
}

/**
 * Emergency "Force re-login": discard the jar and log in again immediately. The
 * autonomous worker re-logs-in on its own; this is the manual fallback.
 */
export async function forceRelogin(tenantId, opts = {}) {
  dropJar(tenantId);
  await login(tenantId, opts);
  return { ok: true };
}

/** Ensure the tenant has a session, logging in if not. Returns landing HTML or ''. */
async function ensureSession(tenantId, opts = {}) {
  if (hasSessionCookie(tenantId)) return '';
  const { html } = await login(tenantId, opts);
  return html || '';
}

// ---------------------------------------------------------------------------
// Menu navigation — the ONLY legal way into a TSD screen (single-window rule).
//
// POST back to the CURRENT page with __EVENTTARGET=_ctl0$Menu1 and the menu path
// as __EVENTARGUMENT, re-sending the page's viewstate.
// ---------------------------------------------------------------------------
async function fetchCurrentPage(tenantId, userAgent) {
  const res = await rawFetch(tenantId, absUrl(rootPathFor(tenantId)), { userAgent });
  const html = res.status < 400 ? await res.text().catch(() => '') : '';
  // The token can rotate mid-session; keep ours current from what we just saw.
  const refreshed = findSessionToken({ location: res.url || '', html });
  if (refreshed) sessionTokens.set(tenantId, refreshed);
  return { res, html };
}

/**
 * Navigate to a menu destination and return the rendered screen's HTML.
 * Re-logs-in ONCE on a bounce. Exported so the worker/routes can warm a screen.
 */
export async function navigateMenu(tenantId, menuPath = MENU_PATH_TM_SUMMARY, { userAgent, menuText = null, requireOffered = false } = {}) {
  const ua = userAgent || pickUserAgent();
  await ensureSession(tenantId, { userAgent: ua });

  const doNavigate = async () => {
    // The postback must carry the CURRENT page's viewstate — always re-GET it.
    const { res: pageRes, html: pageHtml } = await fetchCurrentPage(tenantId, ua);
    if (isLoginBounce(pageRes, pageHtml)) return { bounced: true, html: '' };

    const { action, fields } = parseWebFormsForm(pageHtml);
    // Resolve the postback ARGUMENT off the live menu. Matching on the
    // caller's own menuPath keeps each report on ITS OWN item — resolving by a
    // shared default label once sent the Email report to the T&M screen, which
    // then failed a column guard for a "drift" that was really mis-navigation.
    // Declaring a report "unavailable" needs real evidence: the page must
    // advertise OTHER items from the SAME menu section and still not ours.
    // A page with no menu, or one whose menu never mentions that section, is
    // silence — and concluding absence from silence is how a working portal
    // gets reported as broken.
    if (requireOffered
      && menuSectionRendered(pageHtml, menuPath)
      && !menuOffers(pageHtml, { menuPath, menuText })) {
      throw new MexReportUnavailableError(
        `This TSD account's menu does not offer "${menuText || menuPath}"`
      );
    }
    const resolvedArgument = resolveMenuArgument(pageHtml, { menuPath, menuText });
    if (resolvedArgument !== menuPath) {
      logger.info('[mex] menu argument resolved from page', { tenantId, menuPath, menuText, resolvedArgument });
    }
    const body = buildPostBody(fields, {}, {
      __EVENTTARGET: MENU_EVENT_TARGET,
      __EVENTARGUMENT: resolvedArgument,
    });
    const actionUrl = absUrl(withSessionToken(
      tenantId,
      action ? resolveAction(action, ROOT_PATH) : ROOT_PATH
    ));
    const res = await rawFetch(tenantId, actionUrl, {
      method: 'POST',
      userAgent: ua,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE_URL,
        referer: absUrl(rootPathFor(tenantId)),
      },
      body: body.toString(),
    });
    const html = res.status < 400 ? await res.text().catch(() => '') : '';
    return { bounced: isLoginBounce(res, html), html, url: actionUrl };
  };

  let out = await doNavigate();
  if (out.bounced) {
    logger.info('[mex] menu postback bounced to login, re-login once', { tenantId, menuPath });
    dropJar(tenantId);
    await login(tenantId, { userAgent: ua });
    out = await doNavigate();
    if (out.bounced) {
      throw new MexAuthExpiredError(
        `Re-login did not restore the TSD session for tenant ${tenantId}`
      );
    }
  }
  return out.html;
}

// ---------------------------------------------------------------------------
// Report submit — set the filters on the Daily Activity screen and click Submit.
// ---------------------------------------------------------------------------

/**
 * Build the report-screen filter overrides (keyed by control-name suffix) applied
 * to EVERY postback of a report run. Only the fields we actually drive are
 * overridden; everything else (lstClass / lstRateCode / lstTradingPartner /
 * lstSystem) keeps its scraped default, which the recon ran as "*ALL". Pure.
 * Exported for tests.
 *
 * `lstRunBy` is ALWAYS here, on every postback, never conditional. It selects
 * which date column the report ranges on; the screen defaults to "Date Out"
 * today, but a default is a fact about this ViewState, not a contract. Sending it
 * explicitly is the entire fix for MC3.
 *
 * NOT here: cmbReport (does not exist — the menu path is the selector) and
 * CalFrom/CalTo (Calendar server controls, driven by postback in applyRange).
 */
export function reportOverrides({ tsdNumber, branch, runBy = RUN_BY_VALUE } = {}) {
  const overrides = { [FIELD.RUN_BY]: runBy };
  if (tsdNumber != null && String(tsdNumber).trim() !== '') {
    overrides[FIELD.TSD_NUMBER] = String(tsdNumber).trim();
  }
  if (branch != null && String(branch).trim() !== '') {
    overrides[FIELD.BRANCH] = String(branch).trim();
  }
  return overrides;
}

/**
 * Build the body for ONE calendar-day postback. Pure. Exported for tests.
 *
 * This is the REAL mechanism (measured 2026-07-17):
 *   __doPostBack('_ctl0$cphMaster1$CalFrom', '<days since 2000-01-01>')
 * i.e. __EVENTTARGET = the Calendar control, __EVENTARGUMENT = the day serial.
 *
 * @param {object} fields    scraped form fields (for the viewstate echo + container)
 * @param {object} overrides suffix→value (always carries lstRunBy)
 * @param {string} calSuffix CAL_TARGET.FROM | CAL_TARGET.TO
 * @param {string} serial    toCalendarDaySerial(date)
 */
export function buildCalendarPostBody(fields, overrides, calSuffix, serial) {
  const container = namingContainerOf(fields);
  return buildPostBody(fields, overrides, {
    __EVENTTARGET: `${container}${calSuffix}`,
    __EVENTARGUMENT: String(serial),
  });
}

/**
 * POST one WebForms body to the screen's action URL. Returns { bounced, html }.
 *
 * FOLLOWS REDIRECTS (2026-08-05). RezCentral answers a report run that HAS
 * results with a 302 to its own render page (…/rcReport.aspx?id=<session>),
 * and only an EMPTY report re-renders the input screen inline with "No records
 * found". Reading the 302's body gives you a 176-byte "Object moved" stub — no
 * grid — which the parser reported as "T&M report rendered no dgRates grid",
 * i.e. a layout break that never happened. IRC's activation looked like a
 * broken scraper for exactly this reason while the portal was working fine.
 */
async function postBack(tenantId, action, body, ua) {
  const actionUrl = absUrl(withSessionToken(
    tenantId,
    action ? resolveAction(action, ROOT_PATH) : ROOT_PATH
  ));
  let res = await rawFetch(tenantId, actionUrl, {
    method: 'POST',
    userAgent: ua,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE_URL,
      referer: absUrl(rootPathFor(tenantId)),
    },
    body: body.toString(),
  });
  let html = res.status < 400 ? await res.text().catch(() => '') : '';

  // Bounded: a redirect loop must fail loudly, not spin.
  for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400; hop += 1) {
    const location = res.headers?.get?.('location') || '';
    if (!location) break;
    // A redirect AT the login page is a bounce, not a report — let
    // isLoginBounce below see it rather than chasing it.
    if (/WebLogin\.aspx/i.test(location)) break;
    res = await rawFetch(tenantId, absUrl(resolveAction(location, ROOT_PATH)), { userAgent: ua });
    html = res.status < 400 ? await res.text().catch(() => '') : '';
    const refreshed = findSessionToken({ location, html });
    if (refreshed) sessionTokens.set(tenantId, refreshed);
  }

  return { bounced: isLoginBounce(res, html), html };
}


// ---------------------------------------------------------------------------
// Reservation detail (2026-08-05)
//
// The T&M summary carries no contact and no charge breakdown, so every row
// imported email-less and sat in MANUAL_REVIEW. This screen fills both gaps.
//
// SAFETY: the screen also hosts btnGoCancel ("Cancel") and cmdUnCancel. We post
// ONLY btnCancel — whose VALUE is the innocuous "View/Add" — and buildPostBody
// drops submit-typed fields, so no other button can ride along on the body.
// ---------------------------------------------------------------------------

/** Fetch + parse ONE reservation's confirmation detail. Null when not found. */
export async function fetchReservationDetail(tenantId, confirmation, { userAgent } = {}) {
  const ref = String(confirmation || '').trim();
  if (!ref) return null;
  const ua = userAgent || pickUserAgent();

  const run = async () => {
    const screenHtml = await navigateMenu(tenantId, MENU_PATH_REZ_CANCEL, {
      userAgent: ua,
      menuText: MENU_TEXT_REZ_CANCEL,
      requireOffered: true,
    });
    const { action, fields } = parseWebFormsForm(screenHtml);
    const confirmField = findFieldName(fields, DETAIL_FIELD.CONFIRMATION);
    const viewField = findFieldName(fields, DETAIL_FIELD.VIEW_BUTTON);
    if (!confirmField) {
      throw new MexLayoutError(
        `Mex detail screen has no ${DETAIL_FIELD.CONFIRMATION} input — screen changed`
      );
    }
    const body = buildPostBody(fields, {}, {
      [confirmField]: ref,
      ...(viewField ? { [viewField]: DETAIL_VIEW_VALUE } : {}),
    });
    return postBack(tenantId, action, body, ua);
  };

  let out = await run();
  if (out.bounced) {
    await login(tenantId, { userAgent: ua });
    out = await run();
    if (out.bounced) throw new MexAuthExpiredError(`Detail fetch for ${ref} bounced twice`);
  }

  const raw = (out.html.match(/<textarea[^>]*txtDetails[^>]*>([\s\S]*?)<\/textarea>/i) || [])[1];
  if (!raw) return null;
  const detail = parseReservationDetail(decodeEntities(raw));
  // A portal that hands back SOMEONE ELSE's booking is worse than one that
  // hands back nothing — never enrich a row with another renter's contact.
  if (detail && detail.confirmation && detail.confirmation.toUpperCase() !== ref.toUpperCase()) {
    logger.warn('[mex] detail confirmation mismatch — discarding', {
      tenantId, requested: ref, returned: detail.confirmation,
    });
    return null;
  }
  return detail;
}

/** Raised by a range step so the caller can abort instead of running a wrong window. */
class RangeBounce extends Error {}

/**
 * Drive the screen's date range, then RUN the report. Returns the grid HTML plus
 * a `steps` trace of the postbacks actually fired (→ diagnostics, so the run notes
 * say what we did, not what we intended).
 *
 * Every mode ends on the SAME final postback: Button1. Nothing else runs the
 * report (measured — `Current MTD` only sets the range).
 *
 * @returns {{ html: string, steps: string[] }}
 */
async function applyRangeAndSubmit(tenantId, screenHtml, { from, to, tsdNumber, branch, mode, ua }) {
  const overrides = reportOverrides({ tsdNumber, branch });
  const steps = [];
  let html = screenHtml;

  /** Post `bodyFn(fields)` against the CURRENT screen and adopt the response. */
  const step = async (name, bodyFn) => {
    const { action, fields } = parseWebFormsForm(html);
    const body = bodyFn(fields);
    if (!body) return false; // the step decided it was unnecessary/impossible
    const out = await postBack(tenantId, action, body, ua);
    if (out.bounced) throw new RangeBounce(name);
    html = out.html;
    steps.push(name);
    return true;
  };

  /**
   * Point a calendar at one date: make sure the month select DISPLAYS that month
   * (its own autopostback), then postback the day serial.
   *
   * The month select is fired ONLY when the target month is not already displayed
   * — each is a full ViewState round-trip, and this portal is single-window
   * strict, so a no-op postback is pure session churn. It is not optional when the
   * month IS wrong: the serial postback selects a day CELL, and the legal cells are
   * the ones the displayed grid rendered.
   */
  const pointCalendar = async (label, monthSuffix, calSuffix, date) => {
    const serial = toCalendarDaySerial(date);
    if (!serial) {
      logger.warn('[mex] unusable range bound — calendar not driven', { tenantId, label, date });
      return;
    }
    const wantMonth = toMonthOptionLabel(date);

    await step(`${label}:month=${wantMonth}`, (fields) => {
      const options = parseSelectOptions(html, monthSuffix);
      const current = selectedOptionOf(options);
      // Already showing it → skip the round-trip.
      if (current && cellText(current.label).toLowerCase() === wantMonth.toLowerCase()) return null;
      const value = findOptionValueByLabel(options, wantMonth);
      if (value == null) {
        // NEVER guess a month value. The day-serial postback is still attempted:
        // if the cell happens to be rendered (spill-over cells are — 9716 =
        // 2026-08-08 lives in July's grid) it works, and if it doesn't the
        // coverage diagnostics show the miss rather than a wrong month hiding it.
        logger.warn('[mex] month option not found on the report screen — month not driven', {
          tenantId, label, wantMonth, options: options.length,
        });
        return null;
      }
      const target = eventTargetFor(fields, monthSuffix);
      if (!target) return null;
      return buildPostBody(fields, { ...overrides, [monthSuffix]: value }, {
        __EVENTTARGET: target,
        __EVENTARGUMENT: '',
      });
    });

    await step(`${label}:day=${serial}`, (fields) => (
      buildCalendarPostBody(fields, overrides, calSuffix, serial)
    ));
  };

  if (mode === RANGE_MODES.EXPLICIT) {
    if (from) await pointCalendar('from', FIELD.FROM_MONTH, CAL_TARGET.FROM, from);
    if (to) await pointCalendar('to', FIELD.TO_MONTH, CAL_TARGET.TO, to);
  } else if (mode === RANGE_MODES.MTD) {
    // `Current MTD` SETS the range and nothing more (measured) — Button1 below is
    // what runs the report. Two postbacks, SEQUENCED. Posting both in one body is
    // two submit controls in one RaisePostBackEvent: ambiguous, and historically a
    // coin flip between setting the range and running the report.
    await step('mtd', (fields) => {
      const name = findFieldName(fields, RANGE_SHORTCUT_FIELD);
      if (!name) {
        logger.warn('[mex] Current MTD control not found — running the screen default range', {
          tenantId, shortcut: RANGE_SHORTCUT_FIELD,
        });
        return null;
      }
      // A PLAIN submit (measured — NOT an ImageButton, so no .x/.y coordinates).
      // Posted with its rendered value, the way a browser posts a clicked button.
      return buildPostBody(fields, overrides, { [name]: RANGE_SHORTCUT_VALUE });
    });
  }
  // RANGE_MODES.NONE → no range postbacks; the screen's default range stands.

  // ---- Run the report. The ONLY postback that renders the grid. --------------
  await step('submit', (fields) => {
    const submitName = findFieldName(fields, FIELD.SUBMIT);
    if (!submitName) {
      logger.warn('[mex] Submit control not found on the report screen — posting without it', {
        tenantId, submit: FIELD.SUBMIT,
      });
      return buildPostBody(fields, overrides, {});
    }
    return buildPostBody(fields, overrides, { [submitName]: SUBMIT_VALUE });
  });

  return { html, steps };
}

/**
 * Navigate to a report and run it. Returns the rendered grid HTML + the postback
 * trace.
 *
 * Request sequence (per report):
 *   login (once per session) → menu postback to THE REPORT'S OWN menu item →
 *   range postbacks (mode-dependent) → Button1 → HTML.
 *
 * A bounce anywhere in the sequence re-logs-in ONCE and replays the WHOLE
 * sequence — a mid-sequence re-login would otherwise resume against a fresh
 * ViewState that never received the range postbacks, which is exactly a
 * wrong-window green run.
 */
async function submitReport(tenantId, { report, tsdNumber, branch, from, to, userAgent, mode = RANGE_MODE }) {
  const ua = userAgent || pickUserAgent();

  const run = async () => {
    const screenHtml = await navigateMenu(tenantId, report.menuPath, {
      userAgent: ua,
      menuText: report.menuText || null,
      // Surfaces as MexReportUnavailableError when the portal simply does not
      // carry this report — a true statement, not a layout alarm.
      requireOffered: true,
    });
    try {
      return await applyRangeAndSubmit(tenantId, screenHtml, { from, to, tsdNumber, branch, mode, ua });
    } catch (err) {
      if (err instanceof RangeBounce) return { bounced: true, html: '', steps: [] };
      throw err;
    }
  };

  let out = await run();
  if (out.bounced) {
    logger.info('[mex] report postback bounced to login, re-login once', {
      tenantId, report: report.key,
    });
    dropJar(tenantId);
    await login(tenantId, { userAgent: ua });
    out = await run();
    if (out.bounced) {
      throw new MexAuthExpiredError(
        `Re-login did not restore the TSD session for tenant ${tenantId}`
      );
    }
  }
  logger.info('[mex] report run', {
    tenantId, report: report.key, mode, postbacks: out.steps,
  });
  return out;
}

// ===========================================================================
// DataGrid parsing.
// ===========================================================================

/** Strip tags + decode the entities the grid emits, collapse whitespace. */
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

/**
 * Normalize a header label to a lookup key: lowercase alphanumerics only.
 * "Confirm #" → "confirm", "Date Out" → "dateout", "PO/BR" → "pobr". Pure.
 */
export function headerKey(label) {
  return cellText(label).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Isolate the dgRates table by id suffix; null when it isn't on the page. */
export function extractGridHtml(html, idSuffix = GRID_ID_SUFFIX) {
  const s = String(html || '');
  const re = new RegExp(
    `<table[^>]*id=["'][^"']*${escapeRegExp(idSuffix)}["'][\\s\\S]*?</table>`, 'i'
  );
  const m = s.match(re);
  return m ? m[0] : null;
}

/** Cells (<td> or <th>) of one <tr> block, in order, as text. */
function extractCells(rowHtml) {
  const cells = [];
  for (const m of String(rowHtml).matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
    cells.push(cellText(m[1]));
  }
  return cells;
}

/** Row blocks (<tr>…</tr>) of a table, in order. */
function extractRows(tableHtml) {
  const rows = [];
  for (const m of String(tableHtml).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) rows.push(m[1]);
  return rows;
}

/**
 * Is this row the grid's FOOTER rather than data? (measured 2026-07-17)
 *
 * The last <tr> of a real dgRates run is a footer whose cell 0 reads the literal
 * "Rows: 590" and whose remaining cells REPEAT THE HEADER LABELS (Name, Loc, Date
 * Out, …). Nothing about it throws — a header-keyed parser reads it as a booking
 * with externalRef "Rows: 590", pickup "Date Out" (unparseable → null) and no
 * money, and stages it. So it has to be recognized, not merely survived.
 *
 * Recognized by its FIRST CELL matching /^Rows:\s*N$/ — the server's own count.
 * Deliberately NOT "the last row" (a positional rule breaks the day TSD appends a
 * second footer) and not "cells repeat the header" (that would also drop a real
 * booking for a customer improbably named "Name").
 *
 * @returns {number|null} the count the footer declares, or null if not a footer.
 */
export function footerRowCount(cells) {
  const m = GRID_FOOTER_COUNT_RE.exec(String(cells?.[0] ?? ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a dgRates table into { headerIndex, dataRows, footerCount }. The ASP.NET
 * DataGrid renders its header as the FIRST row (as <th> when accessible headers
 * are on, else <td>), so we take row 0 as the header and key the rest by header
 * name — MINUS the footer row (see footerRowCount).
 *
 * Column resolution is BY NAME: TSD adding or re-ordering a column shifts every
 * positional index silently — and a shifted `Total Bill` is corrupt MONEY. Pure.
 * Exported for tests.
 *
 * @returns {{ headerIndex: Object<string, number>, headers: string[],
 *             dataRows: string[][], footerCount: number|null }}
 */
export function parseGridTable(tableHtml) {
  const rowBlocks = extractRows(tableHtml);
  if (rowBlocks.length === 0) {
    return { headerIndex: {}, headers: [], dataRows: [], footerCount: null };
  }

  const headers = extractCells(rowBlocks[0]);
  const headerIndex = {};
  headers.forEach((h, i) => {
    const key = headerKey(h);
    // First occurrence wins (a duplicate label would otherwise clobber the real one).
    if (key && !(key in headerIndex)) headerIndex[key] = i;
  });

  const dataRows = [];
  let footerCount = null;
  for (let i = 1; i < rowBlocks.length; i++) {
    const cells = extractCells(rowBlocks[i]);
    if (cells.length === 0) continue;
    const declared = footerRowCount(cells);
    if (declared != null) { footerCount = declared; continue; } // the footer, not a booking
    dataRows.push(cells);
  }
  return { headerIndex, headers, dataRows, footerCount };
}

/** Missing required header keys ([] = aligned). Pure. Exported for tests. */
export function missingHeaders(headerIndex, required) {
  return (required || []).filter((k) => !(k in (headerIndex || {})));
}

const get = (cells, headerIndex, key) => {
  const i = headerIndex[key];
  return i == null ? '' : (cells[i] ?? '');
};

/** "$1,234.50" / "135.85" → Number. null when the cell isn't an amount (e.g. the
 * literal "Cancelled" / "No Show" that occupies Total Rate on a dead booking). */
export function parseAmount(raw) {
  const s = cellText(raw).replace(/[^0-9.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD [HH:mm]" → UTC Date in `timeZone`. null when unparseable. */
export function tsdDateToUtc(cell, timeZone = TIME_ZONE) {
  const iso = toIsoFromTsdDate(cellText(cell));
  if (!iso) return null;
  const dt = parseDateTimeInTz(iso, timeZone);
  return dt && Number.isFinite(dt.valueOf()) ? dt : null;
}

/**
 * Split the `Loc` cell — "61302.MCO" = TSD account number + branch. Pure.
 * Exported for tests. Returns nulls for an unparseable/empty cell.
 */
export function parseLoc(raw) {
  const text = cellText(raw);
  if (!text) return { tsdNumber: null, branch: null };
  const m = text.match(/^([^.\s]+)\s*\.\s*([^.\s]+)$/);
  if (!m) return { tsdNumber: null, branch: null };
  return { tsdNumber: m[1].trim(), branch: m[2].trim().toUpperCase() };
}

/**
 * Split a report `Name` cell into { firstName, lastName }.
 *
 * TSD renders two shapes across its reports: the Create/Cancel grid uses
 * "LAST, FIRST" ("FRAZIER, WILLIAM") while the T&M sample is comma-less
 * ("DAVOOD ASHRAFISISI"). We honor the comma when present; otherwise the FIRST
 * token is the given name and the rest is the surname. ASSUMPTION for the
 * comma-less shape — it only affects display + the fuzzy-name half of customer
 * matching (email is the primary key), never money. Pure. Exported for tests.
 */
export function splitName(raw) {
  const text = cellText(raw);
  if (!text) return { firstName: null, lastName: null };
  if (text.includes(',')) {
    const [last, ...restParts] = text.split(',');
    const first = restParts.join(',').trim();
    return {
      firstName: first || null,
      lastName: last.trim() || null,
    };
  }
  const parts = text.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Derive the booking status from the T&M grid, which has NO Status column.
 *
 * A dead booking shows `Date Cancelled` populated AND the literal "Cancelled" /
 * "No Show" in `Total Rate` where an amount belongs. Either signal alone is
 * enough — we never treat a row as live when ANY signal says otherwise (a
 * false CONFIRMED would promote a cancelled booking into a real Reservation).
 * Pure. Exported for tests.
 */
export function deriveStatus({ totalRateRaw, dateCancelledRaw }) {
  const rate = cellText(totalRateRaw);
  const cancelledAt = cellText(dateCancelledRaw);
  if (/no\s*.?\s*show/i.test(rate)) return STATUS.NO_SHOW;
  if (/cancel/i.test(rate)) return STATUS.CANCELLED;
  if (cancelledAt) return STATUS.CANCELLED;
  return STATUS.CONFIRMED;
}

/** ACRISS from the `Class` cell — 4 letters, else null (→ MANUAL_REVIEW). Pure. */
export function extractAcriss(raw) {
  const t = cellText(raw).toUpperCase();
  return /^[A-Z]{4}$/.test(t) ? t : null;
}

/** Attach a non-enumerable diagnostics blob to a rows array. */
function attachDiagnostics(rows, diagnostics) {
  Object.defineProperty(rows, 'diagnostics', {
    value: diagnostics, enumerable: false, configurable: true, writable: true,
  });
  return rows;
}

/**
 * Parse an `*Estimated T&M Summary` page into normalized rows. Pure. Exported.
 *
 * Throws MexLayoutError when the grid renders but a REQUIRED header is
 * gone — refusing to import beats importing a shifted mapping (corrupt
 * estimatedTotal / a cancelled row read as live).
 *
 * @returns {Array<object>} normalized rows (+ non-enumerable `diagnostics`)
 */
export function parseTMSummary(html, { timeZone = TIME_ZONE } = {}) {
  const table = extractGridHtml(html);
  if (!table) {
    return attachDiagnostics([], {
      gridPresent: false, parsedRows: 0, shortRows: 0, emptyGridAnomaly: false,
    });
  }

  const { headerIndex, headers, dataRows, footerCount } = parseGridTable(table);
  const missing = missingHeaders(headerIndex, TM_REQUIRED_HEADERS);
  if (missing.length) {
    throw new MexLayoutError(
      `Mex T&M grid header drift — missing required column(s): ${missing.join(', ')}. `
      + `Got: ${headers.join(' | ')}. Refusing to import a shifted mapping `
      + '(would corrupt estimatedTotal / the cancelled-row guard).'
    );
  }

  const rows = [];
  let shortRows = 0;
  for (const cells of dataRows) {
    if (cells.length < TM_EXPECTED_COLUMN_COUNT) shortRows++; // keep parsing best-effort

    const externalRef = cellText(get(cells, headerIndex, TM_COL.CONFIRM));
    if (!externalRef) continue; // a real row must carry a Confirm #

    const totalRateRaw = get(cells, headerIndex, TM_COL.TOTAL_RATE);
    const dateCancelledRaw = get(cells, headerIndex, TM_COL.DATE_CANCELLED);
    const { tsdNumber, branch } = parseLoc(get(cells, headerIndex, TM_COL.LOC));
    const nameRaw = get(cells, headerIndex, TM_COL.NAME);
    const { firstName, lastName } = splitName(nameRaw);
    const daysRaw = cellText(get(cells, headerIndex, TM_COL.DAYS));

    rows.push({
      externalRef,
      customerName: cellText(nameRaw) || null,
      customerFirstName: firstName,
      customerLastName: lastName,
      loc: cellText(get(cells, headerIndex, TM_COL.LOC)) || null,
      tsdNumber,
      branch,
      pickupAt: tsdDateToUtc(get(cells, headerIndex, TM_COL.DATE_OUT), timeZone),
      dropoffAt: tsdDateToUtc(get(cells, headerIndex, TM_COL.DATE_IN), timeZone),
      bookedAt: tsdDateToUtc(get(cells, headerIndex, TM_COL.BOOKED), timeZone),
      acriss: extractAcriss(get(cells, headerIndex, TM_COL.CLASS)),
      classRaw: cellText(get(cells, headerIndex, TM_COL.CLASS)) || null,
      days: daysRaw ? (Number.parseInt(daysRaw, 10) || null) : null,
      iata: cellText(get(cells, headerIndex, TM_COL.IATA)) || null,
      // MONEY (read-only): Total Bill = total incl. tax → estimatedTotal.
      totalRate: parseAmount(totalRateRaw),
      totalRateRaw: cellText(totalRateRaw) || null,
      totalTax: parseAmount(get(cells, headerIndex, TM_COL.TOTAL_TAX)),
      totalBill: parseAmount(get(cells, headerIndex, TM_COL.TOTAL_BILL)),
      cancelledAt: tsdDateToUtc(dateCancelledRaw, timeZone),
      dateCancelledRaw: cellText(dateCancelledRaw) || null,
      status: deriveStatus({ totalRateRaw, dateCancelledRaw }),
      rateCode: cellText(get(cells, headerIndex, TM_COL.RATE_CODE)) || null,
      pnr: cellText(get(cells, headerIndex, TM_COL.PNR)) || null,
      source: cellText(get(cells, headerIndex, TM_COL.SOURCE)) || null,
      cd: cellText(get(cells, headerIndex, TM_COL.CD)) || null,
      poBr: cellText(get(cells, headerIndex, TM_COL.PO_BR)) || null,
    });
  }

  return attachDiagnostics(rows, {
    gridPresent: true,
    headers,
    parsedRows: rows.length,
    shortRows,
    // The footer's "Rows: N" — the SERVER'S OWN count of what it returned. null
    // when the grid has no footer.
    footerCount,
    // Rows the server says it sent that we did not turn into records. Non-zero
    // means we DROPPED something the server gave us (a Confirm-less row, a parse
    // miss) — a signal the pre-filter row count alone cannot give.
    unparsedRows: footerCount == null ? null : footerCount - rows.length,
    // Grid rendered rows but none carried a Confirm # → format break, not "empty".
    emptyGridAnomaly: dataRows.length > 0 && rows.length === 0,
  });
}

/**
 * Parse an `Email Address Report` page into { email, confirm, ... } rows. Pure.
 * Exported. Throws MexLayoutError on a missing required header.
 */
export function parseEmailReport(html) {
  const table = extractGridHtml(html);
  if (!table) return attachDiagnostics([], { gridPresent: false, parsedRows: 0 });

  const { headerIndex, headers, dataRows, footerCount } = parseGridTable(table);
  const missing = missingHeaders(headerIndex, EMAIL_REQUIRED_HEADERS);
  if (missing.length) {
    throw new MexLayoutError(
      `Mex Email report header drift — missing required column(s): ${missing.join(', ')}. `
      + `Got: ${headers.join(' | ')}.`
    );
  }

  const rows = [];
  for (const cells of dataRows) {
    const confirm = cellText(get(cells, headerIndex, EMAIL_COL.CONFIRM));
    const email = cellText(get(cells, headerIndex, EMAIL_COL.EMAIL));
    if (!confirm || !email) continue; // the join key + the payload are both required
    rows.push({
      confirm,
      email,
      customerName: cellText(get(cells, headerIndex, EMAIL_COL.NAME)) || null,
      branch: cellText(get(cells, headerIndex, EMAIL_COL.BRANCH)) || null,
      classRaw: cellText(get(cells, headerIndex, EMAIL_COL.CLASS)) || null,
    });
  }
  return attachDiagnostics(rows, {
    gridPresent: true, headers, parsedRows: rows.length, footerCount,
  });
}

/**
 * Join the email report onto the T&M feed by `Confirm`. Returns NEW row objects
 * carrying `customerEmail` (null when the source has none — coverage is ~50% BY
 * DESIGN per the recon: 279 emails for 552 bookings). Never invents an address.
 * Pure. Exported for tests.
 */
export function joinEmailsByConfirm(tmRows, emailRows) {
  const byConfirm = new Map();
  for (const e of Array.isArray(emailRows) ? emailRows : []) {
    const key = String(e?.confirm || '').trim().toUpperCase();
    if (!key) continue;
    // First email wins — a duplicate Confirm in the email report is ambiguous and
    // the first row is what the operator sees at the top of the grid.
    if (!byConfirm.has(key)) byConfirm.set(key, e.email);
  }
  const rows = (Array.isArray(tmRows) ? tmRows : []).map((r) => ({
    ...r,
    customerEmail: byConfirm.get(String(r?.externalRef || '').trim().toUpperCase()) || null,
  }));
  const matched = rows.filter((r) => r.customerEmail).length;
  const diag = tmRows?.diagnostics ? { ...tmRows.diagnostics } : {};
  return attachDiagnostics(rows, { ...diag, emailsMatched: matched, emailRows: byConfirm.size });
}

/**
 * Min/max of a Date-valued field across rows, as ISO strings (null when the field
 * is never populated). Pure. Exported for tests.
 */
export function dateRangeOf(rows, field) {
  let min = null;
  let max = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const d = row?.[field];
    const t = d instanceof Date ? d.getTime() : null;
    if (t == null || Number.isNaN(t)) continue;
    if (min == null || t < min) min = t;
    if (max == null || t > max) max = t;
  }
  return {
    min: min == null ? null : new Date(min).toISOString(),
    max: max == null ? null : new Date(max).toISOString(),
  };
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
// Public fetches.
// ---------------------------------------------------------------------------

/**
 * How much of the requested window the SERVER's range actually covers, per mode.
 * Pure. Exported for tests.
 *
 * This is the number that keeps a degraded mode from degrading QUIETLY. 'explicit'
 * drives the calendars to the requested bounds → full coverage. 'mtd' covers the
 * 1st→today only: against the sync's [today-2, today+30] that is the whole
 * lookahead missing — and the live run measured 44% of rows booked 3+ days before
 * pickup, i.e. this feed is bought well ahead and the lookahead IS the product.
 * 'none' makes no claim at all.
 *
 * @returns {{ mode, coveredFrom, coveredTo, requestedFrom, requestedTo,
 *             uncoveredDays, covers }}
 */
export function rangeCoverage({ mode, from, to, now = Date.now() }) {
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  const base = {
    mode,
    requestedFrom: iso(from),
    requestedTo: iso(to),
    coveredFrom: null,
    coveredTo: null,
    uncoveredDays: null,
    covers: null,
  };
  if (mode === RANGE_MODES.EXPLICIT) {
    return { ...base, coveredFrom: iso(from), coveredTo: iso(to), uncoveredDays: 0, covers: true };
  }
  if (mode === RANGE_MODES.MTD) {
    const { from: mFrom, to: mTo } = mtdCoverageBounds(now);
    const out = { ...base, coveredFrom: iso(mFrom), coveredTo: iso(mTo) };
    if (!mFrom || !mTo) return out;
    // Days of the requested window that fall outside the MTD span, either side.
    const day = 86400000;
    const missAfter = to ? Math.max(0, (new Date(to).getTime() - mTo.getTime()) / day) : 0;
    const missBefore = from ? Math.max(0, (mFrom.getTime() - new Date(from).getTime()) / day) : 0;
    const uncoveredDays = Math.round((missAfter + missBefore) * 10) / 10;
    return { ...out, uncoveredDays, covers: uncoveredDays === 0 };
  }
  return base; // NONE — the screen's default range; we make no claim.
}

/**
 * Fetch the `*Estimated T&M Summary` for one (tsdNumber, branch) + window.
 *
 * Sequence: login (if needed) → menu postback to the report's OWN menu item →
 * range postbacks (lstRunBy=Date Out on every one of them; calendars driven by
 * day-serial postback, or Current MTD) → Button1 → parse the inline dgRates grid
 * → window-filter client-side.
 */
export async function fetchTMSummary(tenantId, {
  tsdNumber, branch, from = null, to = null, userAgent, mode = RANGE_MODE,
} = {}) {
  const ua = userAgent || pickUserAgent();
  const { html, steps } = await submitReport(tenantId, {
    report: REPORT.TM_SUMMARY, tsdNumber, branch, from, to, userAgent: ua, mode,
  });

  // parseTMSummary throws MexLayoutError on header drift — let it
  // propagate so the worker records ATTENTION, not a silent OK 0.
  const parsed = parseTMSummary(html, { timeZone: TIME_ZONE });
  const diag = parsed.diagnostics || null;
  if (!diag?.gridPresent) {
    logger.warn('[mex] T&M report rendered no dgRates grid — possible screen/format break', {
      tenantId, tsdNumber, branch,
    });
  }
  if (diag?.emptyGridAnomaly) {
    logger.warn('[mex] T&M grid returned rows but none had a Confirm # — possible format break', {
      tenantId, tsdNumber, branch,
    });
  }

  const filtered = filterByPickupWindow(parsed, from, to);

  // ---- COVERAGE / RECONCILIATION diagnostics -------------------------------
  // The client-side window filter guarantees the CORRECTNESS of what we import.
  // It says nothing about COVERAGE — it cannot see what the server never sent.
  //
  // `outOfWindowRows === 0` is DELETED as a health signal, and stays deleted. It
  // never meant "the server honored the range": 0 is equally the signature of a
  // server range narrower than ours, or one keyed to a different date column.
  //
  // What defends coverage now is the MECHANISM, not an inference: lstRunBy=Date
  // Out is sent explicitly, and the calendars are driven by the postback the
  // portal actually implements. These numbers are therefore a RECONCILIATION aid
  // — they let a human falsify that claim on any run instead of trusting a
  // comment:
  //   - `footerCount` — the server's own "Rows: N". vs serverRows it proves we
  //     parsed everything we were sent.
  //   - `serverDateOut` / `serverBooked` — the two candidate range keys. On the
  //     live 2026-07-17 run over Jul 1-17: DateOut hugged the asked range exactly
  //     while Booked sprawled Dec 2025 → Jul 2026. DateOut hugs / Booked sprawls
  //     = ranged on pickup, which is what we asked for. The inverse signature
  //     would mean the wrong column.
  //   - `rangeCoverage.uncoveredDays` — how much of the requested window the
  //     chosen mode's server range cannot reach (0 for 'explicit'; the whole
  //     lookahead for 'mtd'). This is what stops a degraded mode being silent.
  const coverage = rangeCoverage({ mode, from, to });
  if (diag) {
    attachDiagnostics(filtered, {
      ...diag,
      rangeMode: mode,
      rangePostbacks: steps,
      rangeCoverage: coverage,
      // Rows the SERVER returned, BEFORE our client-side pickup filter.
      serverRows: parsed.length,
      // Rows outside our pickup window. NOT a health signal on its own.
      outOfWindowRows: parsed.length - filtered.length,
      // What we ASKED for, so the diagnostic is self-contained in the log/notes.
      requestedFrom: from ? new Date(from).toISOString() : null,
      requestedTo: to ? new Date(to).toISOString() : null,
      // The server's actual span on each candidate range key.
      serverDateOut: dateRangeOf(parsed, 'pickupAt'),
      serverBooked: dateRangeOf(parsed, 'bookedAt'),
    });
  }

  // A mode whose server range cannot reach the requested window is a COVERAGE
  // GAP, not a preference. Loud, every run, with the number attached.
  if (coverage.covers === false) {
    logger.warn('[mex] range mode does not cover the requested window — bookings outside the server range are NOT imported', {
      tenantId, tsdNumber, branch, ...coverage,
    });
  }
  if (diag?.unparsedRows) {
    logger.warn('[mex] the grid footer counts more rows than we parsed — rows were dropped', {
      tenantId, tsdNumber, branch, footerCount: diag.footerCount, parsedRows: diag.parsedRows,
    });
  }
  logger.info('[mex] T&M summary fetched', {
    tenantId,
    tsdNumber,
    branch,
    mode,
    parsed: parsed.length,
    footerCount: diag?.footerCount ?? null,
    afterWindow: filtered.length,
    serverDateOut: dateRangeOf(parsed, 'pickupAt'),
    serverBooked: dateRangeOf(parsed, 'bookedAt'),
  });
  return filtered;
}

/**
 * Fetch the `Email Address Report` for one (tsdNumber, branch) + window. This is
 * the SECOND fetch of a sync; its rows are joined onto the T&M feed by Confirm.
 * Coverage is ~50% by design — a missing email is NOT an error.
 */
export async function fetchEmailReport(tenantId, {
  tsdNumber, branch, from = null, to = null, userAgent, mode = RANGE_MODE,
} = {}) {
  const ua = userAgent || pickUserAgent();
  const { html } = await submitReport(tenantId, {
    report: REPORT.EMAIL, tsdNumber, branch, from, to, userAgent: ua, mode,
  });
  const parsed = parseEmailReport(html);
  logger.info('[mex] email report fetched', {
    tenantId, tsdNumber, branch, rows: parsed.length,
  });
  return parsed;
}

// ---------------------------------------------------------------------------
// Auth probe — login + a menu navigation. Records OK / EXPIRED / ERROR.
// ---------------------------------------------------------------------------
export async function testAuth(tenantId) {
  try {
    dropJar(tenantId); // force a fresh login so the probe is meaningful
    await login(tenantId);
    // Reaching the report screen proves the session survives a menu postback —
    // the piece that actually matters (single-window). No report is submitted:
    // the probe must stay cheap and side-effect-free.
    await navigateMenu(tenantId, REPORT.TM_SUMMARY.menuPath, { menuText: REPORT.TM_SUMMARY.menuText || null });
    await recordTestStatus(tenantId, 'OK');
    return { ok: true, status: 'OK' };
  } catch (err) {
    if (err instanceof MexAuthExpiredError) {
      await recordTestStatus(tenantId, 'EXPIRED');
      return { ok: false, status: 'EXPIRED', message: err.message };
    }
    await recordTestStatus(tenantId, 'ERROR');
    return { ok: false, status: 'ERROR', message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Rate writeback client (2026-08-06).
//
// Contract: doc/mex-rate-writeback-recon-2026-08-05.md — captured from a REAL
// successful write (Hector's CFAR monthly fix on BPABR). The screen is
// rcUpdateRates1a.aspx: select rate code(s)/branch/system/TSD, drive the
// From/To calendars (same ASP.NET Calendar semantics as the T&M screen), fill
// the dgRates grid, Button1=Submit. Success REDIRECTS to WebRateReport1.aspx
// which renders one row per (class × tier) written with Result "Completed" —
// that report is the verification surface, not our own optimism.
//
// This section is the TRANSPORT only. What to write, to which codes, with what
// guardrails, lives in mex-rate-push.service.js.
// ---------------------------------------------------------------------------

/** Grid field suffixes we write. Everything else in the row is echoed as-is. */
export const RATE_GRID_FIELD = Object.freeze({
  DAILY: 'txtDGDailyRate',
  WEEKLY: 'txtDGWeeklyRate',
  MONTHLY: 'txtDGMonthlyRate',
  XDAY: 'txtDGXDayRate',
});

const RATE_SCREEN_PATH = process.env.MEX_RATE_SCREEN_PATH || '/WebRezClient/rcUpdateRates1a.aspx';
const RATE_PRELOAD_SUFFIX = process.env.MEX_RATE_PRELOAD_FIELD || 'Button2';
const RATE_SUBMIT_SUFFIX = process.env.MEX_RATE_SUBMIT_FIELD || 'Button1';

/** Does this HTML look like the rate-update screen? (grid + code selector) */
export function isRateUpdateScreen(html) {
  const s = String(html || '');
  return /dgRates/i.test(s) && new RegExp(FIELD.RATE_CODE, 'i').test(s);
}

/**
 * Row → class mapping, scraped per session. The recon doc is explicit:
 * `_ctl2..11` map to classes ALPHABETICALLY and the indices SHIFT if MEX adds
 * a class — so the writer must read the labels off the live grid, never
 * hardcode. Each row's class is the first standalone 4-letter code in its
 * text (the cell reads "CFAR HYUNDAI KONA SE OR SIMILAR").
 *
 * Pure. Returns [{ rowPrefix, classCode }] — rowPrefix is the full naming
 * container ('_ctl0:cphMaster1:dgRates:_ctl2').
 */
export function parseRateGridRows(html) {
  const rows = [];
  const seen = new Set();
  // Find every daily-rate input; its name pins the row's naming container.
  const re = new RegExp(`name="([^"]*dgRates[^"]*):${RATE_GRID_FIELD.DAILY}"`, 'gi');
  const raw = String(html || '');
  for (const m of raw.matchAll(re)) {
    const rowPrefix = m[1];
    if (seen.has(rowPrefix)) continue;
    seen.add(rowPrefix);
    // The row's <tr> is the nearest preceding one; label sits before the inputs.
    const inputAt = m.index;
    const trStart = raw.lastIndexOf('<tr', inputAt);
    const rowHtml = trStart >= 0 ? raw.slice(trStart, inputAt) : '';
    const text = rowHtml.replace(/<[^>]*>/g, ' ');
    const label = (text.match(/\b([A-Z]{4})\b/) || [])[1] || null;
    rows.push({ rowPrefix, classCode: label });
  }
  return rows;
}

/**
 * Current grid values for one row, read from the parsed form fields (the
 * Preload response carries them as input values).
 */
export function rateRowValues(fields, rowPrefix) {
  const val = (suffix) => {
    const meta = fields[`${rowPrefix}:${suffix}`];
    if (!meta) return null;
    const n = Number(String(meta.value ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  return {
    daily: val(RATE_GRID_FIELD.DAILY),
    weekly: val(RATE_GRID_FIELD.WEEKLY),
    monthly: val(RATE_GRID_FIELD.MONTHLY),
    xday: val(RATE_GRID_FIELD.XDAY),
  };
}

/**
 * WebRateReport1.aspx rows. One per (class × tier) the portal wrote:
 *
 *   Requested · System · TSD# · Branch · Code · Cat · Class · Rate · Result · Allow Undo
 *   2026/08/04 20:45:52 · WebLink · 61306 · SJU-SJU · BPABR · S · CFAR ·
 *     1960.00/MY UNL [...] · Completed 2026/08/04 20:45:52 · Yes
 *
 * Pure. `completed` is the portal's own word — anything else is a failed write.
 */
export function parseRateReport(html) {
  const out = [];
  const raw = String(html || '');
  for (const tr of raw.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [])
      .map((c) => cellText(c.replace(/^<t[dh][^>]*>/i, '').replace(/<\/t[dh]>$/i, '')));
    if (cells.length < 9) continue;
    // Data rows start with the Requested timestamp.
    if (!/^\d{4}\/\d{2}\/\d{2}/.test(cells[0])) continue;
    const rateText = cells[7] || '';
    out.push({
      requestedAt: cells[0],
      rateCode: cells[4] || null,
      classCode: cells[6] || null,
      rateText,
      tier: (rateText.match(/\/([A-Z]{2})\b/) || [])[1] || null,
      result: cells[8] || '',
      completed: /^completed/i.test(cells[8] || ''),
    });
  }
  return out;
}

/**
 * Reach the rate-update screen. Menu-first (single-window portal — the menu
 * postback is the measured-safe route), direct GET as fallback, one re-login
 * between attempts. Throws MexLayoutError when what comes back is not the
 * rates screen — never returns a page the caller would then write blind.
 */
export async function fetchRateUpdateScreen(tenantId, { userAgent } = {}) {
  const ua = userAgent || pickUserAgent();

  const attempt = async () => {
    try {
      const html = await navigateMenu(tenantId, MENU_PATH_RATE_UPDATE_1, {
        userAgent: ua, menuText: MENU_TEXT_RATE_UPDATE_1,
      });
      if (isRateUpdateScreen(html)) return html;
    } catch (err) {
      if (err instanceof MexAuthExpiredError) throw err;
      // Menu miss — fall through to the direct GET.
    }
    const res = await rawFetch(tenantId, absUrl(withSessionToken(tenantId, RATE_SCREEN_PATH)), { userAgent: ua });
    const html = res.status < 400 ? await res.text().catch(() => '') : '';
    if (isLoginBounce(res, html)) throw new MexAuthExpiredError('rate screen bounced to login');
    return html;
  };

  let html;
  try {
    html = await attempt();
  } catch (err) {
    if (!(err instanceof MexAuthExpiredError)) throw err;
    await login(tenantId, { userAgent: ua });
    html = await attempt();
  }
  if (!isRateUpdateScreen(html)) {
    throw new MexLayoutError('Mex rate-update screen did not render (no dgRates grid / rate-code selector)');
  }
  return html;
}

/**
 * A calendar date for the serial computation. A date-only string parses as UTC
 * midnight, which in America/New_York is STILL YESTERDAY — the first live push
 * clicked Aug 4 while meaning Aug 5 and the portal silently clamped the past
 * day to today. Anchoring date-only values at noon UTC keeps them on their own
 * literal day in any sane timezone.
 */
export function calendarDateArg(date) {
  const s = String(date || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : date;
}

/**
 * Select a rate code + set the date window + tick the day boxes, then Preload
 * the grid (Button2). Returns { html, fields, rows } — the read-back the plan
 * diffs against.
 *
 * THE ORDER IS THE BUG HISTORY OF THIS SCREEN (all found live, 2026-08-06):
 *   1. The selection first, as ITS OWN postback — lstRateCode is AUTOPOSTBACK
 *      (__ControlsRequirePostBackKey__); folding it into the Preload POST left
 *      the handler reading the pre-change selection.
 *   2. The CALENDARS before Preload — rates live per date window, so a Preload
 *      without dates has nothing to load: BPABR, a code with live rates,
 *      preloaded all zeros until the window was set first. This is exactly the
 *      sequence Hector's manual flow followed ("selecionar los rate codes, las
 *      fechas y actualizar precio").
 *   3. The day checkboxes with the rest of the state — all eight render
 *      unchecked, and "no days selected" made a mechanically perfect submit
 *      write zero rows.
 */
export async function preloadRateGrid(tenantId, {
  rateCode, tsdNumber, branch, fromDate, toDate, userAgent,
} = {}) {
  const ua = userAgent || pickUserAgent();
  const screenHtml = await fetchRateUpdateScreen(tenantId, { userAgent: ua });
  const overrides = rateSelectionOverrides({ rateCode, tsdNumber, branch });

  let html = screenHtml;
  const ownPostback = async (name, extraFn) => {
    const { action, fields } = parseWebFormsForm(html);
    const body = buildPostBody(fields, overrides, {
      // The rate code rides on EVERY postback: absent from the form until the
      // selection sticks (see absentFieldExtra), a plain field afterwards.
      ...absentFieldExtra(fields, FIELD.RATE_CODE, rateCode),
      ...extraFn(fields),
    });
    const out = await postBack(tenantId, action, body, ua);
    if (out.bounced) throw new MexAuthExpiredError(`rate screen ${name} bounced to login`);
    html = out.html;
  };

  await ownPostback('selection', (fields) => {
    const name = findFieldName(fields, FIELD.RATE_CODE)
      || Object.keys(absentFieldExtra(fields, FIELD.RATE_CODE, rateCode))[0] || '';
    return {
      __EVENTTARGET: name.replace(/:/g, '$'),
      __EVENTARGUMENT: '',
    };
  });

  const codeExtra = (fields) => absentFieldExtra(fields, FIELD.RATE_CODE, rateCode);

  if (fromDate) {
    html = await driveRateCalendar(tenantId, html, {
      calSuffix: CAL_TARGET.FROM, monthSuffixes: [FIELD.FROM_MONTH, 'lstFromMonth'],
      date: fromDate, overrides, extra: codeExtra(parseWebFormsForm(html).fields), ua,
    });
  }
  if (toDate) {
    html = await driveRateCalendar(tenantId, html, {
      calSuffix: CAL_TARGET.TO, monthSuffixes: ['lstTOMonth', FIELD.TO_MONTH],
      date: toDate, overrides, extra: codeExtra(parseWebFormsForm(html).fields), ua,
    });
  }

  await ownPostback('day checkboxes', (fields) => ({
    ...dayCheckboxOverrides(findFieldName(fields, RATE_PRELOAD_SUFFIX) || 'Button2'),
    __EVENTTARGET: eventTargetFor(fields, 'chkAllDays') || '',
    __EVENTARGUMENT: '',
  }));

  const { action, fields } = parseWebFormsForm(html);
  const preloadName = findFieldName(fields, RATE_PRELOAD_SUFFIX);
  if (!preloadName) throw new MexLayoutError(`rate screen has no ${RATE_PRELOAD_SUFFIX} (Preload) button`);
  const body = buildPostBody(fields, overrides, {
    ...absentFieldExtra(fields, FIELD.RATE_CODE, rateCode),
    ...dayCheckboxOverrides(preloadName),
    [preloadName]: fields[preloadName]?.value || 'Preload',
  });
  const out = await postBack(tenantId, action, body, ua);
  if (out.bounced) throw new MexAuthExpiredError('rate preload bounced to login');

  const rows = parseRateGridRows(out.html);
  if (!rows.length) throw new MexLayoutError('rate preload rendered no dgRates rows');
  const parsed = parseWebFormsForm(out.html);
  return {
    html: out.html,
    action: parsed.action,
    fields: parsed.fields,
    rows: rows.map((r) => ({ ...r, current: rateRowValues(parsed.fields, r.rowPrefix) })),
  };
}

/** The selector overrides threaded through EVERY postback on this screen. */
export function rateSelectionOverrides({ rateCode, tsdNumber, branch }) {
  return {
    [FIELD.RATE_CODE]: rateCode,
    [FIELD.BRANCH]: branch,
    [FIELD.SYSTEM]: 'WebLink',
    [FIELD.TSD_NUMBER]: tsdNumber,
  };
}

/**
 * THE ROOT CAUSE OF "Updated: 0" (found live, 2026-08-06): lstRateCode renders
 * with NOTHING selected, a browser does not submit an empty multi-select, so
 * parseWebFormsForm omits it — and buildPostBody applies overrides only to
 * fields the form carries. Every POST on this screen therefore went out
 * WITHOUT a rate code at all: Preload loaded nothing (all-zero grids even for
 * BPABR, which has live rates) and Submit wrote to zero codes while reporting
 * success. lstBranch/lstSystem never hit this because they render with a
 * default selected.
 *
 * This helper emits the field BY FULL NAME (buildPostBody's `extra` path) when
 * the form omits it, deriving the naming container from a sibling. Once the
 * selection postback sticks, the re-render carries the select and the normal
 * suffix override takes over; the extra then emits nothing.
 */
export function absentFieldExtra(fields, suffix, value) {
  if (findFieldName(fields, suffix)) return {};
  const sibling = findFieldName(fields, FIELD.BRANCH)
    || findFieldName(fields, RATE_PRELOAD_SUFFIX)
    || findFieldName(fields, RATE_SUBMIT_SUFFIX);
  if (!sibling) return {};
  return { [`${sibling.replace(/[^:$]+$/, '')}${suffix}`]: String(value) };
}

/**
 * Drive one of the screen's calendars to a date: month select first when the
 * displayed month differs (its own autopostback), then the day-serial click.
 * Same semantics the T&M screen proved live; serial = days since 2000-01-01.
 * Returns the new screen HTML.
 */
async function driveRateCalendar(tenantId, html, { calSuffix, monthSuffixes, date, overrides, extra = {}, ua }) {
  const arg = calendarDateArg(date);
  const serial = toCalendarDaySerial(arg);
  if (!serial) throw new MexLayoutError(`unusable calendar date: ${date}`);
  const wantMonth = toMonthOptionLabel(arg);

  // The rates screen names its To-month list `lstTOMonth` (capital TO) where
  // the T&M screen has `lstToMonth` — accept either spelling.
  const { fields: f0 } = parseWebFormsForm(html);
  const monthSuffix = monthSuffixes.find((s) => findFieldName(f0, s)) || null;

  if (monthSuffix) {
    const options = parseSelectOptions(html, monthSuffix);
    const current = selectedOptionOf(options);
    if (!current || cellText(current.label).toLowerCase() !== wantMonth.toLowerCase()) {
      const value = findOptionValueByLabel(options, wantMonth);
      const target = eventTargetFor(f0, monthSuffix);
      if (value != null && target) {
        const body = buildPostBody(f0, { ...overrides, [monthSuffix]: value }, {
          ...extra,
          __EVENTTARGET: target,
          __EVENTARGUMENT: '',
        });
        const { action } = parseWebFormsForm(html);
        const out = await postBack(tenantId, action, body, ua);
        if (out.bounced) throw new MexAuthExpiredError('rate calendar month bounced');
        html = out.html;
      }
    }
  }

  const { action, fields } = parseWebFormsForm(html);
  const container = namingContainerOf(fields);
  const body = buildPostBody(fields, overrides, {
    ...extra,
    __EVENTTARGET: `${container}${calSuffix}`,
    __EVENTARGUMENT: String(serial),
  });
  const out = await postBack(tenantId, action, body, ua);
  if (out.bounced) throw new MexAuthExpiredError('rate calendar day bounced');
  return out.html;
}

/**
 * The days-of-week checkboxes, forced ON for every submit.
 *
 * FOUND LIVE (first push, 2026-08-06): all eight render UNCHECKED, an
 * unchecked checkbox is never posted (parseWebFormsForm mirrors the browser),
 * and the portal answered "Rates Updated … Updated: 0" — transport perfect,
 * zero rows written, because we asked it to update rates on no days of the
 * week. Hector's captured manual write carried chkAllDays=on; he had clicked
 * it. Keyed by FULL field name (derived from a sibling field's prefix) because
 * suffix overrides only reach fields the form already posts.
 */
export function dayCheckboxOverrides(siblingFieldName) {
  const prefix = String(siblingFieldName || '').replace(/[^:$]+$/, '');
  return Object.fromEntries([
    'chkAllDays', 'chkSunday', 'chkMonday', 'chkTuesday',
    'chkWednesday', 'chkThursday', 'chkFriday', 'chkSaturday',
  ].map((s) => [`${prefix}${s}`, 'on']));
}

/**
 * Write one rate code's grid: drive the window, fill the touched rows, Submit.
 * Returns { reportRows, reportHtml } from WebRateReport1.aspx (postBack follows
 * the success redirect). The CALLER decides whether the report proves the
 * write — this function only refuses transport-level failure.
 *
 * `gridOverrides` maps FULL field names ('…dgRates:_ctl2:txtDGDailyRate') to
 * string values; buildPostBody echoes every untouched field verbatim, so the
 * rest of the grid (weekend/hourly/free-miles) rides through unchanged.
 */
export async function submitRateGrid(tenantId, {
  preload, rateCode, tsdNumber, branch, gridOverrides, userAgent,
} = {}) {
  const ua = userAgent || pickUserAgent();
  const overrides = rateSelectionOverrides({ rateCode, tsdNumber, branch });
  // The window, the selection and the day boxes were all set BEFORE the
  // Preload (see preloadRateGrid — the order is the screen's bug history), so
  // the submit only fills the grid and clicks Submit.
  const html = preload.html;

  const { action, fields } = parseWebFormsForm(html);
  const submitName = findFieldName(fields, RATE_SUBMIT_SUFFIX);
  if (!submitName) throw new MexLayoutError(`rate screen has no ${RATE_SUBMIT_SUFFIX} (Submit) button`);

  const body = buildPostBody(fields, overrides, {
    ...absentFieldExtra(fields, FIELD.RATE_CODE, rateCode),
    ...dayCheckboxOverrides(submitName),
    ...gridOverrides,
    [submitName]: fields[submitName]?.value || 'Submit',
  });
  const out = await postBack(tenantId, action, body, ua);
  if (out.bounced) throw new MexAuthExpiredError('rate submit bounced to login');

  return { reportRows: parseRateReport(out.html), reportHtml: out.html };
}
