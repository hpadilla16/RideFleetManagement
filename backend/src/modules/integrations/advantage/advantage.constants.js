/**
 * Advantage (TSD RezCentral) integration — shared constants.
 *
 * Split out from the service so the worker, scheduler, routes and tests can
 * import the same source-of-truth strings without pulling in the network layer.
 * Mirrors flexways.constants.js / nu.constants.js.
 *
 * WHY this source is different from its siblings: Advantage does NOT have its own
 * affiliate portal — it lives inside TSD RezCentral, an ASP.NET WebForms
 * back-office (rezcentral.tsdasp.net/WebRezClient). Three consequences:
 *
 *   1. NO CAPTCHA / no WAF (recon 2026-07-14, Fase 0 PASS) → plain HTTP session
 *      scrape with a cookie jar (NU's shape), NOT a headless browser (Flexways).
 *   2. TSD is SINGLE-WINDOW STRICT: navigation happens by MENU POSTBACK
 *      (__EVENTTARGET=_ctl0$Menu1 + __EVENTARGUMENT=<menu path>), never by
 *      deep-linking a .aspx — deep-linking breaks the session.
 *   3. The feed is a report, not a reservations grid: `*Estimated T&M Summary`
 *      renders INLINE into the DataGrid `_ctl0_cphMaster1_dgRates` (no popup, no
 *      PDF, no pagination — 552 rows in one page) and carries the ACRISS class
 *      inline, so unlike Flexways there is NO per-reservation detail fetch.
 *      Email is a SECOND report (`Email Address Report`) joined by Confirm #;
 *      its coverage is only ~50% BY DESIGN (recon), not a bug.
 *
 * MONEY: Advantage is 100% Pay on Arrival (confirmed with Advantage by Hector,
 * 2026-07-14) → isPrepaid is always false. `Total Bill` feeds estimatedTotal and
 * NOTHING else — no charge, no card, no autocharge.
 *
 * See doc/advantage-integration-plan-2026-07-13.md
 */

import { createWindowHelpers } from '../booking-source/window.js';
import { parseDateTimeInTz } from '../../../lib/date-utils.js';

// Free-string sourceSystem stored on ExternalReservation / ExternalSyncRun /
// IntegrationCredential rows. Coexists with TL + Economy + NU + Flexways rows via
// the composite unique (sourceSystem, externalRef).
export const SOURCE_SYSTEM = 'ADVANTAGE';

// bookingChannel stamped on promoted Reservation rows. The UI "franchise import"
// badge keys off bookingChannel (FRANCHISE_*).
export const BOOKING_CHANNEL = 'FRANCHISE_ADVANTAGE';

// BullMQ queue the scheduler enqueues onto and the worker registers.
export const QUEUE_NAME = 'advantage.sync';

// reservationNumber prefix for promoted Advantage bookings.
export const RESERVATION_PREFIX = 'ADV-';

// ---------------------------------------------------------------------------
// Portal URLs (recon 2026-07-14). TSD RezCentral, classic ASP.NET WebForms.
// ---------------------------------------------------------------------------
export const BASE_URL = (
  process.env.ADVANTAGE_BASE || 'https://rezcentral.tsdasp.net'
).replace(/\/$/, '');

// The application root. GETting this yields the login form (and, once
// authenticated, the landing page whose viewstate seeds the menu postback).
export const ROOT_PATH = process.env.ADVANTAGE_ROOT_PATH || '/WebRezClient/';

// Login form target. The ONLY .aspx we address directly — everything after login
// goes through the menu postback (single-window rule).
export const LOGIN_PATH = process.env.ADVANTAGE_LOGIN_PATH || '/WebRezClient/WebLogin.aspx';

// The ASP.NET session cookie TSD issues. NOT an "authenticated" marker on its own
// — ASP.NET sets it on the PRE-LOGIN GET (the login form's own response carries
// it), so its mere presence proves only that we spoke to the server. The service
// tracks authentication separately (see hasSessionCookie in advantage.service.js).
// Deliberately NOT env-driven: an env key here would have to be added to
// .env.example and every droplet .env (env-diff-check is fail-closed) to express
// a value that only changes if Microsoft renames it.
export const SESSION_COOKIE_NAME = 'ASP.NET_SessionId';

// ---------------------------------------------------------------------------
// Login form fields (recon 2026-07-14). __VIEWSTATE + __VIEWSTATEGENERATOR are
// scraped and re-posted verbatim (WebForms requires it); the credentials go in
// txtUserID / txtPwd. The submit control is an IMAGE BUTTON — WebForms only sees
// it when the POST carries `imgLogin.x` / `imgLogin.y` COORDINATES; posting the
// control NAME alone does nothing.
// ---------------------------------------------------------------------------
export const LOGIN_USER_FIELD = process.env.ADVANTAGE_LOGIN_USER_FIELD || 'txtUserID';
export const LOGIN_PASS_FIELD = process.env.ADVANTAGE_LOGIN_PASS_FIELD || 'txtPwd';
export const LOGIN_IMAGE_BUTTON = process.env.ADVANTAGE_LOGIN_IMAGE_BUTTON || 'imgLogin';
// Any coordinate inside the image works; WebForms only checks that the pair exists.
export const LOGIN_IMAGE_X = process.env.ADVANTAGE_LOGIN_IMAGE_X || '10';
export const LOGIN_IMAGE_Y = process.env.ADVANTAGE_LOGIN_IMAGE_Y || '10';

// ---------------------------------------------------------------------------
// Menu navigation (recon 2026-07-14) — the single-window rule.
//
// TSD navigates by posting back to the CURRENT page with the menu's event target
// and the destination's menu PATH as the argument. NEVER deep-link a .aspx.
//
// VALIDATED-FALSE 2026-07-17 (Hector, live DOM): there is NO `cmbReport` control.
// The report is NOT chosen from a dropdown on a shared "Daily Activity" screen —
// each report is its OWN MENU ITEM rendering its OWN page (the T&M summary is
// rcEstimatedTM.aspx). So the report selector IS the menu path.
// ---------------------------------------------------------------------------
export const MENU_EVENT_TARGET = process.env.ADVANTAGE_MENU_EVENT_TARGET || '_ctl0$Menu1';
// Backslash-separated menu paths, exactly as the portal emits them.
export const MENU_PATH_TM_SUMMARY =
  process.env.ADVANTAGE_MENU_PATH_TM_SUMMARY || 'Reports POS\\Estimated T&M Summary';
// ⚠️ UNVERIFIED (the 2026-07-17 live pass measured ONLY rcEstimatedTM.aspx): the
// Email Address Report's own menu path. The Fase 0 recon saw it listed among the
// Daily Activity screen's report options, so it may live either on its own page
// (like the T&M summary) or behind that screen's selector. Left env-overridable
// and defaulted to its own menu item for symmetry with the measured T&M page;
// confirm on the live screen before the email enrichment is relied upon.
export const MENU_PATH_EMAIL =
  process.env.ADVANTAGE_MENU_PATH_EMAIL || 'Reports POS\\Email Address Report';

// ---------------------------------------------------------------------------
// Report screen controls. MEASURED 2026-07-17 off the live rcEstimatedTM.aspx DOM
// (document.forms[0].elements enumerated in full). The portal renders these with
// the naming-container prefix `_ctl0:cphMaster1:` (name) / `_ctl0_cphMaster1_`
// (id). We match by NAME SUFFIX (the last `:`/`$`-separated segment) so a
// naming-container change can never silently break the override — the same
// robustness trick nu.service.js uses for its RadDatePicker fields.
//
// NOT here, deliberately:
//   - `cmbReport` — does not exist (see MENU_PATH_* above).
//   - `CalFrom` / `CalTo` as TEXT fields — they are ASP.NET Calendar SERVER
//     CONTROLS (<table id="_ctl0_cphMaster1_CalFrom">), NOT inputs. There is no
//     MM/DD/YYYY field anywhere on the page. They are driven by POSTBACK, so they
//     live in CAL_TARGET below, not in FIELD.
// ---------------------------------------------------------------------------
export const FIELD = Object.freeze({
  TSD_NUMBER: process.env.ADVANTAGE_FIELD_TSD_NUMBER || 'lstTSDNumber',
  BRANCH: process.env.ADVANTAGE_FIELD_BRANCH || 'lstBranch',
  CLASS: process.env.ADVANTAGE_FIELD_CLASS || 'lstClass',
  RATE_CODE: process.env.ADVANTAGE_FIELD_RATE_CODE || 'lstRateCode',
  TRADING_PARTNER: process.env.ADVANTAGE_FIELD_TRADING_PARTNER || 'lstTradingPartner',
  SYSTEM: process.env.ADVANTAGE_FIELD_SYSTEM || 'lstSystem',
  // Which DATE COLUMN the report ranges on. select-one, options exactly
  // ["Date Booked","Date Out","Date In"]. THE resolution of MC3 — see RUN_BY below.
  RUN_BY: process.env.ADVANTAGE_FIELD_RUN_BY || 'lstRunBy',
  // The month the calendars DISPLAY. Both autopostback; they do not themselves
  // set the range. 73 options, labelled "Jul 2026".
  FROM_MONTH: process.env.ADVANTAGE_FIELD_FROM_MONTH || 'lstFromMonth',
  TO_MONTH: process.env.ADVANTAGE_FIELD_TO_MONTH || 'lstToMonth',
  // <input type="submit" value="Submit"> — runs the report, renders the grid.
  SUBMIT: process.env.ADVANTAGE_FIELD_SUBMIT || 'Button1',
  // Grid granularity. MEASURED unchecked, and it must STAY unchecked: checked
  // collapses the grid to summary totals, while the parser needs the
  // per-reservation detail rows. Never posted (see buildPostBody's exclusion).
  SUMMARY: process.env.ADVANTAGE_FIELD_SUMMARY || 'chkSummary',
});

// The ASP.NET Calendar controls, addressed as POSTBACK TARGETS (never as fields):
//   __doPostBack('_ctl0$cphMaster1$CalFrom', '<days since 2000-01-01>')
export const CAL_TARGET = Object.freeze({
  FROM: process.env.ADVANTAGE_CAL_FROM || 'CalFrom',
  TO: process.env.ADVANTAGE_CAL_TO || 'CalTo',
});

// ---------------------------------------------------------------------------
// `lstRunBy` — MEASURED 2026-07-17. THIS IS THE RESOLUTION OF MC3.
//
// The old plan treated "does the server range on Booked date or on pickup?" as an
// unanswerable hazard to be diagnosed after the fact. It is not a hazard: it is a
// PARAMETER. The report asks you which column to range on, and we answer.
//
// We send `Date Out` (= pickup) EXPLICITLY on EVERY postback of EVERY fetch. The
// screen happens to default to "Date Out" today, but a default is a fact about
// this month's ViewState, not a contract — relying on it is how the CalFrom bug
// stayed invisible.
//
// Empirically confirmed on the live run (Current MTD = Jul 1–17, 590 rows):
//   dateOutSpan  2026/07/01 → 2026/07/17   hugs the asked range EXACTLY
//   bookedSpan   2025/12/15 → 2026/07/16   sprawls seven months outside it
// DateOut hugs / Booked sprawls → the server ranged on pickup. (The inverse of
// that signature is what would indicate the wrong column; see the coverage
// diagnostics in advantage.service.js, which still emit both spans so the claim
// stays falsifiable on every run rather than resting on this comment.)
// ---------------------------------------------------------------------------
export const RUN_BY = Object.freeze({
  DATE_BOOKED: 'Date Booked',
  DATE_OUT: 'Date Out',
  DATE_IN: 'Date In',
});
// The column the sync ranges on. Pickup — the whole feed is forward-looking.
export const RUN_BY_VALUE = process.env.ADVANTAGE_RUN_BY || RUN_BY.DATE_OUT;

// The inline DataGrid both reports render into (id `_ctl0_cphMaster1_dgRates`).
// Matched by id SUFFIX for the same naming-container robustness.
export const GRID_ID_SUFFIX = process.env.ADVANTAGE_GRID_ID_SUFFIX || 'dgRates';

// ---------------------------------------------------------------------------
// Reports. Each is its own MENU ITEM (there is no cmbReport — VALIDATED-FALSE
// 2026-07-17). `label` is for logs/diagnostics only.
// ---------------------------------------------------------------------------
export const REPORT = Object.freeze({
  TM_SUMMARY: Object.freeze({
    key: 'TM_SUMMARY',
    label: 'Estimated T&M Summary',
    menuPath: MENU_PATH_TM_SUMMARY,
  }),
  EMAIL: Object.freeze({
    key: 'EMAIL',
    label: 'Email Address Report',
    menuPath: MENU_PATH_EMAIL,
  }),
});

// ---------------------------------------------------------------------------
// DATE RANGE — MEASURED 2026-07-17 (Hector, live DOM + a real run). Two prior
// assumptions died here; read this before touching anything below.
//
// VALIDATED-FALSE #1 — "CalFrom/CalTo are MM/DD/YYYY text inputs."
//   They are ASP.NET Calendar SERVER CONTROLS rendered as
//   <table id="_ctl0_cphMaster1_CalFrom">. The form's complete element list holds
//   NO CalFrom/CalTo input; there is no MM/DD/YYYY field on the page at all.
//   Posting `CalFrom=07/15/2026` sends a key ASP.NET has never heard of: it is
//   SILENTLY IGNORED and the server falls back to its ViewState default range.
//   Green run, plausible rows, wrong window, nobody notices. That is the failure
//   this whole mechanism exists to make impossible.
//   The REAL mechanism is a postback:
//     __doPostBack('_ctl0$cphMaster1$CalFrom', '9716')
//   where the argument is DAYS SINCE 2000-01-01 (verified: 9716 = 2026-08-08).
//   → toCalendarDaySerial() below; the posting lives in advantage.service.js.
//
// VALIDATED-FALSE #2 — "cmdMonthTD might be an ImageButton needing .x/.y coords."
//   It is <input type="submit" value="Current MTD"> — a plain submit, posted by
//   name. Siblings, all plain submits: btnToday, btnTomorrow, cmdLastMonth,
//   cmdWeekTD, cmdLastWeek, cmdYesterday, Button1 (Submit).
//
// MEASURED #3 — `cmdMonthTD` does NOT run the report; it only SETS the range
//   (CalFrom=1st, CalTo=today, lstRunBy preserved). Running the report is a
//   SECOND postback on Button1. The old code posted the shortcut and Button1 in
//   ONE body — two submit controls, ambiguous RaisePostBackEvent — so "shortcut
//   mode" was a coin flip between setting the range and running the report. The
//   two postbacks are now SEQUENCED (see applyRange in advantage.service.js).
//
// MODES (ADVANTAGE_RANGE_MODE):
//
//   'explicit' (DEFAULT, and what production must run) — drive the calendars for
//     the real sync window via the day-serial postbacks:
//       lstFromMonth? → CalFrom(serial) → lstToMonth? → CalTo(serial) → Button1
//     The month selects are autopostbacks that only change which month the
//     calendar DISPLAYS; each is fired ONLY when the target month is not already
//     the displayed one (a rendered day cell is what makes the serial postback
//     legal under event validation). 3-5 postbacks.
//
//   'mtd' — fire `Current MTD` then Submit. 2 postbacks, server-authoritative,
//     and its window is exactly the one the portal's own "Rows: N" footer counts,
//     which makes it the RECONCILIATION path: our imported count for the same
//     window against the portal's number is a genuinely good go-live check.
//
//   'none' — leave the screen's default range; rely purely on the client filter.
//
// WHY 'mtd' IS NOT THE DEFAULT (the coverage question, settled by measurement):
//   MTD = the 1st → TODAY, on Date Out. It therefore returns ZERO of the forward
//   window: the sync asks for [today-2, today+30] and MTD covers at most the
//   3 days of it that are in the past. The live run also measured that 262 of 590
//   rows (44%) were booked 3+ days before pickup — this feed is bought well ahead,
//   so a pickup-ranged FORWARD window is the only thing that imports it. MTD alone
//   is not "slightly narrow"; it is structurally blind to everything the
//   integration exists to fetch. Any mode whose server range does not cover the
//   requested window emits a coverage WARNING + an uncoveredDays number into the
//   run notes, so choosing 'mtd' can degrade coverage but can never do it quietly.
//
// CORRECTNESS never depends on the server honoring the range: every fetch is
// window-filtered client-side (parity with Flexways/NU). COVERAGE does — hence
// the diagnostics in fetchTMSummary (raw pre-filter serverRows, the footer's own
// "Rows: N", and serverDateOut/serverBooked min-max).
// ---------------------------------------------------------------------------
export const RANGE_MODES = Object.freeze({
  EXPLICIT: 'explicit',
  MTD: 'mtd',
  NONE: 'none',
});
export const DEFAULT_RANGE_MODE = RANGE_MODES.EXPLICIT;

/**
 * Normalize an ADVANTAGE_RANGE_MODE value. Unknown → the default (an unknown mode
 * must never silently become "post nothing"). `shortcut` is accepted as a legacy
 * alias for `mtd` — that is what the old env value meant. Pure. Exported.
 */
export function normalizeRangeMode(raw) {
  const m = String(raw ?? '').trim().toLowerCase();
  if (m === 'shortcut') return RANGE_MODES.MTD; // legacy alias
  return Object.values(RANGE_MODES).includes(m) ? m : DEFAULT_RANGE_MODE;
}

export const RANGE_MODE = normalizeRangeMode(process.env.ADVANTAGE_RANGE_MODE);

// The `Current MTD` shortcut: a PLAIN submit (measured). Its rendered value is
// posted with it the way a browser posts the clicked button's value.
export const RANGE_SHORTCUT_FIELD = process.env.ADVANTAGE_RANGE_SHORTCUT_FIELD || 'cmdMonthTD';
export const RANGE_SHORTCUT_VALUE = process.env.ADVANTAGE_RANGE_SHORTCUT_VALUE || 'Current MTD';
// The Submit button's rendered value.
export const SUBMIT_VALUE = process.env.ADVANTAGE_SUBMIT_VALUE || 'Submit';

// The ASP.NET Calendar postback argument is days since this epoch (verified:
// 9716 → 2026-08-08).
export const CALENDAR_EPOCH_UTC = Date.UTC(2000, 0, 1);

// ---------------------------------------------------------------------------
// Column maps. Both grids are parsed BY HEADER NAME, not by position: the recon
// captured the exact header labels, and a name-keyed map survives TSD adding or
// re-ordering a column (which a positional map would silently corrupt — the NU
// RadGrid drift lesson). Header text is normalized to lowercase alphanumerics,
// so "Confirm #" → "confirm", "PO/BR" → "pobr", "Date Out" → "dateout".
//
// `*Estimated T&M Summary` — 18 columns (recon 2026-07-14, 552 rows MTD):
//   Confirm # · Name · Loc · Date Out · Date In · Booked · Class · Days · IATA ·
//   Total Rate · Total Tax · Total Bill · Date Cancelled · Rate Code · PNR ·
//   Source · CD · PO/BR
// Real row:
//   A1TL012880 | DAVOOD ASHRAFISISI | 61302.MCO | 2026/07/04 | 2026/07/10 |
//   2026/05/04 | ECAR | 6 | 33895934 | 101.16 | 22.69 | 135.85 | (empty) | D6 |
//   A6D994 | AMADEUS | AD0016 | (empty)
// ---------------------------------------------------------------------------
export const TM_COL = Object.freeze({
  CONFIRM: 'confirm',
  NAME: 'name',
  LOC: 'loc',
  DATE_OUT: 'dateout',
  DATE_IN: 'datein',
  BOOKED: 'booked',
  CLASS: 'class',
  DAYS: 'days',
  IATA: 'iata',
  TOTAL_RATE: 'totalrate',
  TOTAL_TAX: 'totaltax',
  TOTAL_BILL: 'totalbill',
  DATE_CANCELLED: 'datecancelled',
  RATE_CODE: 'ratecode',
  PNR: 'pnr',
  SOURCE: 'source',
  CD: 'cd',
  PO_BR: 'pobr',
});
export const TM_EXPECTED_COLUMN_COUNT = 18;

// ---------------------------------------------------------------------------
// The FOOTER ROW (measured 2026-07-17). The grid's LAST <tr> is not data: cell 0
// reads the literal "Rows: 590" and cells 1-17 REPEAT THE HEADER LABELS. A
// header-name-keyed parser does not crash on it — it happily emits one garbage
// record with externalRef "Rows: 590", Date Out "Date Out", Total Bill null. On
// the real run: 592 <tr> = 1 header + 590 data + 1 footer.
//
// It is also a GIFT: "Rows: N" is the SERVER'S OWN COUNT of what it returned, so
// serverRows can be cross-checked against it instead of only inferred from what we
// managed to parse. A mismatch means we dropped rows the server sent.
// ---------------------------------------------------------------------------
export const GRID_FOOTER_COUNT_RE = /^\s*Rows\s*:\s*([\d,]+)\s*$/i;

// The T&M headers WITHOUT which a parse would be meaningless or dangerous:
// identity (confirm), the window key (dateout), the promotion gate (class), the
// MONEY field (totalbill) and BOTH status carriers (datecancelled + totalrate).
// Missing any → AdvantageLayoutError rather than a silently shifted import.
export const TM_REQUIRED_HEADERS = Object.freeze([
  TM_COL.CONFIRM,
  TM_COL.NAME,
  TM_COL.LOC,
  TM_COL.DATE_OUT,
  TM_COL.CLASS,
  TM_COL.TOTAL_RATE,
  TM_COL.TOTAL_BILL,
  TM_COL.DATE_CANCELLED,
]);

// `Email Address Report` — 7 columns (recon 2026-07-14, 279 of 552 rows):
//   Email Address · Confirm · Name · Branch · Pickup · Return · Class
export const EMAIL_COL = Object.freeze({
  EMAIL: 'emailaddress',
  CONFIRM: 'confirm',
  NAME: 'name',
  BRANCH: 'branch',
  PICKUP: 'pickup',
  RETURN: 'return',
  CLASS: 'class',
});
export const EMAIL_EXPECTED_COLUMN_COUNT = 7;

// Email report: only the join key + the payload are load-bearing.
export const EMAIL_REQUIRED_HEADERS = Object.freeze([EMAIL_COL.EMAIL, EMAIL_COL.CONFIRM]);

// ---------------------------------------------------------------------------
// Status derivation. The T&M grid has NO Status column: a cancelled booking has
// `Date Cancelled` populated AND `Total Rate` reading the literal "Cancelled"
// (100 rows MTD) or "No Show" (131 rows MTD) instead of an amount. Either signal
// alone is enough — we never promote a row that looks cancelled by ANY signal.
// ---------------------------------------------------------------------------
export const STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
});

// ---------------------------------------------------------------------------
// Timezone. The active account is Advantage ORLANDO (61302.MCO) → US Eastern.
// Recon flagged TZ as "assumed, confirm in Fase 1"; Orlando wall-clock is
// Eastern. Overridable via env if a future branch sits in another TZ.
// ---------------------------------------------------------------------------
export const TIME_ZONE = process.env.ADVANTAGE_TIME_ZONE || 'America/New_York';

// ---------------------------------------------------------------------------
// Near-term date window (mirror NU/Economy/Flexways → ADVANTAGE_* env names). The
// worker queries pickups (`Date Out`) in [today - LOOKBACK, today + LOOKAHEAD].
// Per-config lookbackDays/lookaheadDays on AdvantageLocationConfig override these
// when set. The math is delegated to the shared booking-source window factory so
// it can never drift from the other sources.
// ---------------------------------------------------------------------------
export const DATE_WINDOW_LOOKBACK_DAYS = Number(
  process.env.ADVANTAGE_DATE_WINDOW_LOOKBACK_DAYS ?? 2
);
export const DATE_WINDOW_LOOKAHEAD_DAYS = Number(
  process.env.ADVANTAGE_DATE_WINDOW_LOOKAHEAD_DAYS ?? 30
);

const _windowHelpers = createWindowHelpers({
  defaultLookbackDays: DATE_WINDOW_LOOKBACK_DAYS,
  defaultLookaheadDays: DATE_WINDOW_LOOKAHEAD_DAYS,
});

// Re-export the shared helpers under this source's names (parity with the other
// sources' constants surface).
export const effectiveWindowDays = _windowHelpers.effectiveWindowDays;
export const windowBoundsForConfig = _windowHelpers.windowBoundsForConfig;
export const unionWindowDays = _windowHelpers.unionWindowDays;
export const unionWindowBounds = _windowHelpers.unionWindowBounds;

// ---------------------------------------------------------------------------
// Date helpers.
// ---------------------------------------------------------------------------

/**
 * Parse a TSD "YYYY/MM/DD" (optionally "YYYY/MM/DD HH:mm") cell into a naive ISO
 * wall-clock string for parseDateTimeInTz. UNAMBIGUOUS by construction — year
 * first, so none of Flexways' DD/MM-vs-MM/DD trap. Date-only cells (the T&M
 * grid) yield 00:00; the Create/Cancel grid's "YYYY/MM/DD HH:mm" is tolerated so
 * the same helper serves both. Returns null when unparseable. Pure. Exported.
 */
export function toIsoFromTsdDate(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, yr, mo, dd, hh = '0', mi = '0', se = '0'] = m;
  const pad = (n, w = 2) => String(Number(n)).padStart(w, '0');
  return `${pad(yr, 4)}-${pad(mo)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:${pad(se)}`;
}

/**
 * The wall-clock calendar date of an instant, in the portal timezone.
 * → { year, month (1-12), day }. Never server-UTC: a UTC midnight is the PREVIOUS
 * day for an Eastern operator, which would post the wrong day cell. Pure.
 */
export function calendarPartsInTz(date, timeZone = TIME_ZONE) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.valueOf())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

/**
 * A Date → the ASP.NET Calendar postback ARGUMENT: days since 2000-01-01, as a
 * string. This is the ONLY way to select a day on this screen — CalFrom/CalTo are
 * Calendar server controls (<table>), not text inputs, so there is nothing to type
 * a date into (VALIDATED-FALSE 2026-07-17).
 *
 *   __doPostBack('_ctl0$cphMaster1$CalFrom', toCalendarDaySerial(d))
 *
 * Verified against the live DOM: '9716' = 2026-08-08 (the August spill-over cell
 * in July's grid). Computed on the portal-timezone CALENDAR date, so DST and the
 * UTC offset can never shift it by a day. Returns '' for an invalid date. Pure.
 */
export function toCalendarDaySerial(date, timeZone = TIME_ZONE) {
  const p = calendarPartsInTz(date, timeZone);
  if (!p) return '';
  const days = Math.round(
    (Date.UTC(p.year, p.month - 1, p.day) - CALENDAR_EPOCH_UTC) / 86400000
  );
  return String(days);
}

/** Inverse of toCalendarDaySerial — a day serial → 'YYYY-MM-DD'. For tests/logs. */
export function fromCalendarDaySerial(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  return new Date(CALENDAR_EPOCH_UTC + n * 86400000).toISOString().slice(0, 10);
}

/**
 * A Date → the `lstFromMonth` / `lstToMonth` option LABEL for its month, in the
 * portal timezone. MEASURED format: "Jul 2026" (73 options). Pure.
 */
export function toMonthOptionLabel(date, timeZone = TIME_ZONE) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.valueOf())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'short',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('month')} ${get('year')}`;
}

/**
 * The window `Current MTD` actually covers, as [1st of the current month 00:00,
 * today 23:59:59.999] in PORTAL wall-clock, returned as UTC instants. MEASURED:
 * the shortcut set CalFrom=Jul 1 / CalTo=Jul 17 (today) on a 2026-07-17 run.
 *
 * Used to compute the COVERAGE GAP against the requested window — the number that
 * keeps 'mtd' mode from degrading coverage quietly. Pure. Exported for tests.
 */
export function mtdCoverageBounds(now = Date.now(), timeZone = TIME_ZONE) {
  const p = calendarPartsInTz(new Date(now), timeZone);
  if (!p) return { from: null, to: null };
  // Anchor on the portal's calendar day, then read the UTC instant of that
  // wall-clock moment back through the same TZ math the parser uses.
  const from = parseDateTimeInTz(
    `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-01T00:00:00`,
    timeZone
  );
  const to = parseDateTimeInTz(
    `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-`
    + `${String(p.day).padStart(2, '0')}T23:59:59`,
    timeZone
  );
  return { from, to };
}
