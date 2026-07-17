/**
 * Advantage (TSD RezCentral) back-office client.
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
 *   See advantage.constants.js's DATE RANGE block for the full measured record.
 *
 * PARSING:
 *   Both reports render INLINE into the same DataGrid (_ctl0_cphMaster1_dgRates)
 *   with NO pagination (552 rows in one page) and no CSV export → we parse the
 *   HTML table. Columns are resolved BY HEADER NAME, not by position, and a
 *   missing required header raises AdvantageLayoutError instead of importing a
 *   shifted mapping (the NU RadGrid drift lesson).
 *
 * MONEY: this module only READS. `Total Bill` becomes estimatedTotal downstream;
 * Advantage is 100% Pay on Arrival → isPrepaid is always false. No charge path.
 *
 * See doc/advantage-integration-plan-2026-07-13.md
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
import {
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
} from './advantage.constants.js';

export { SOURCE_SYSTEM, BASE_URL, randomDelay, sleep };

// ---------------------------------------------------------------------------
// Source-specific error types (own names for instanceof / Sentry grouping).
// ---------------------------------------------------------------------------
export class AdvantageAuthExpiredError extends AuthExpiredError {
  constructor(message = 'Advantage (TSD RezCentral) session expired or invalid') {
    super(message);
    this.name = 'AdvantageAuthExpiredError';
  }
}

/**
 * Raised when the DataGrid renders but its HEADER columns have drifted from the
 * validated map (a required header is gone). Distinct from an auth/empty failure
 * so the worker records the run as ATTENTION rather than a silent "OK 0" —
 * importing a shifted mapping would corrupt estimatedTotal / the cancel status.
 * Mirrors NuLayoutError.
 */
export class AdvantageLayoutError extends Error {
  constructor(message = 'Advantage DataGrid layout drifted from the expected column mapping') {
    super(message);
    this.name = 'AdvantageLayoutError';
  }
}

// Stealth: rotate UA per run, pinnable via ADVANTAGE_USER_AGENT (shared pool).
export const pickUserAgent = makePickUserAgent('ADVANTAGE_USER_AGENT');

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

function dropJar(tenantId) {
  cookieJars.delete(tenantId);
  authenticatedJars.delete(tenantId);
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
  sourceLabel: 'Advantage',
  logPrefix: '[advantage]',
  AuthError: AdvantageAuthExpiredError,
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
    fields[name] = { value: selectedOptionValue(m[2]), type: 'select' };
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
    body.set(name, Object.hasOwn(overrides, suffix) ? String(overrides[suffix]) : (meta.value || ''));
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

  // 1) GET the app root → the login form + its hidden fields.
  const rootUrl = absUrl(ROOT_PATH);
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

  const actionUrl = action ? absUrl(resolveAction(action, ROOT_PATH)) : absUrl(LOGIN_PATH);
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
  if (!bounced && postRes.status >= 300 && postRes.status < 400) {
    const loc = postRes.headers.get?.('location') || '';
    if (loc) {
      const follow = await rawFetch(tenantId, absUrl(resolveAction(loc, ROOT_PATH)), { userAgent });
      landedHtml = follow.status < 400 ? await follow.text().catch(() => '') : '';
      if (isLoginBounce(follow, landedHtml)) {
        dropJar(tenantId);
        throw new AdvantageAuthExpiredError(
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
    throw new AdvantageAuthExpiredError(
      `Login for tenant ${tenantId} did not establish an authenticated TSD session (bad credentials?)`
    );
  }

  // Vouch for the jar: from here on hasSessionCookie() reports authenticated, so
  // ensureSession() will reuse it instead of re-logging-in on every request.
  authenticatedJars.add(tenantId);

  logger.info('[advantage] login ok', { tenantId });
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
  const res = await rawFetch(tenantId, absUrl(ROOT_PATH), { userAgent });
  const html = res.status < 400 ? await res.text().catch(() => '') : '';
  return { res, html };
}

/**
 * Navigate to a menu destination and return the rendered screen's HTML.
 * Re-logs-in ONCE on a bounce. Exported so the worker/routes can warm a screen.
 */
export async function navigateMenu(tenantId, menuPath = MENU_PATH_TM_SUMMARY, { userAgent } = {}) {
  const ua = userAgent || pickUserAgent();
  await ensureSession(tenantId, { userAgent: ua });

  const doNavigate = async () => {
    // The postback must carry the CURRENT page's viewstate — always re-GET it.
    const { res: pageRes, html: pageHtml } = await fetchCurrentPage(tenantId, ua);
    if (isLoginBounce(pageRes, pageHtml)) return { bounced: true, html: '' };

    const { action, fields } = parseWebFormsForm(pageHtml);
    const body = buildPostBody(fields, {}, {
      __EVENTTARGET: MENU_EVENT_TARGET,
      __EVENTARGUMENT: menuPath,
    });
    const actionUrl = action ? absUrl(resolveAction(action, ROOT_PATH)) : absUrl(ROOT_PATH);
    const res = await rawFetch(tenantId, actionUrl, {
      method: 'POST',
      userAgent: ua,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE_URL,
        referer: absUrl(ROOT_PATH),
      },
      body: body.toString(),
    });
    const html = res.status < 400 ? await res.text().catch(() => '') : '';
    return { bounced: isLoginBounce(res, html), html, url: actionUrl };
  };

  let out = await doNavigate();
  if (out.bounced) {
    logger.info('[advantage] menu postback bounced to login, re-login once', { tenantId, menuPath });
    dropJar(tenantId);
    await login(tenantId, { userAgent: ua });
    out = await doNavigate();
    if (out.bounced) {
      throw new AdvantageAuthExpiredError(
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

/** POST one WebForms body to the screen's action URL. Returns { bounced, html }. */
async function postBack(tenantId, action, body, ua) {
  const actionUrl = action ? absUrl(resolveAction(action, ROOT_PATH)) : absUrl(ROOT_PATH);
  const res = await rawFetch(tenantId, actionUrl, {
    method: 'POST',
    userAgent: ua,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE_URL,
      referer: absUrl(ROOT_PATH),
    },
    body: body.toString(),
  });
  const html = res.status < 400 ? await res.text().catch(() => '') : '';
  return { bounced: isLoginBounce(res, html), html };
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
      logger.warn('[advantage] unusable range bound — calendar not driven', { tenantId, label, date });
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
        logger.warn('[advantage] month option not found on the report screen — month not driven', {
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
        logger.warn('[advantage] Current MTD control not found — running the screen default range', {
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
      logger.warn('[advantage] Submit control not found on the report screen — posting without it', {
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
    const screenHtml = await navigateMenu(tenantId, report.menuPath, { userAgent: ua });
    try {
      return await applyRangeAndSubmit(tenantId, screenHtml, { from, to, tsdNumber, branch, mode, ua });
    } catch (err) {
      if (err instanceof RangeBounce) return { bounced: true, html: '', steps: [] };
      throw err;
    }
  };

  let out = await run();
  if (out.bounced) {
    logger.info('[advantage] report postback bounced to login, re-login once', {
      tenantId, report: report.key,
    });
    dropJar(tenantId);
    await login(tenantId, { userAgent: ua });
    out = await run();
    if (out.bounced) {
      throw new AdvantageAuthExpiredError(
        `Re-login did not restore the TSD session for tenant ${tenantId}`
      );
    }
  }
  logger.info('[advantage] report run', {
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
 * Throws AdvantageLayoutError when the grid renders but a REQUIRED header is
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
    throw new AdvantageLayoutError(
      `Advantage T&M grid header drift — missing required column(s): ${missing.join(', ')}. `
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
 * Exported. Throws AdvantageLayoutError on a missing required header.
 */
export function parseEmailReport(html) {
  const table = extractGridHtml(html);
  if (!table) return attachDiagnostics([], { gridPresent: false, parsedRows: 0 });

  const { headerIndex, headers, dataRows, footerCount } = parseGridTable(table);
  const missing = missingHeaders(headerIndex, EMAIL_REQUIRED_HEADERS);
  if (missing.length) {
    throw new AdvantageLayoutError(
      `Advantage Email report header drift — missing required column(s): ${missing.join(', ')}. `
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

  // parseTMSummary throws AdvantageLayoutError on header drift — let it
  // propagate so the worker records ATTENTION, not a silent OK 0.
  const parsed = parseTMSummary(html, { timeZone: TIME_ZONE });
  const diag = parsed.diagnostics || null;
  if (!diag?.gridPresent) {
    logger.warn('[advantage] T&M report rendered no dgRates grid — possible screen/format break', {
      tenantId, tsdNumber, branch,
    });
  }
  if (diag?.emptyGridAnomaly) {
    logger.warn('[advantage] T&M grid returned rows but none had a Confirm # — possible format break', {
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
    logger.warn('[advantage] range mode does not cover the requested window — bookings outside the server range are NOT imported', {
      tenantId, tsdNumber, branch, ...coverage,
    });
  }
  if (diag?.unparsedRows) {
    logger.warn('[advantage] the grid footer counts more rows than we parsed — rows were dropped', {
      tenantId, tsdNumber, branch, footerCount: diag.footerCount, parsedRows: diag.parsedRows,
    });
  }
  logger.info('[advantage] T&M summary fetched', {
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
  logger.info('[advantage] email report fetched', {
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
    await navigateMenu(tenantId, REPORT.TM_SUMMARY.menuPath);
    await recordTestStatus(tenantId, 'OK');
    return { ok: true, status: 'OK' };
  } catch (err) {
    if (err instanceof AdvantageAuthExpiredError) {
      await recordTestStatus(tenantId, 'EXPIRED');
      return { ok: false, status: 'EXPIRED', message: err.message };
    }
    await recordTestStatus(tenantId, 'ERROR');
    return { ok: false, status: 'ERROR', message: err.message };
  }
}
