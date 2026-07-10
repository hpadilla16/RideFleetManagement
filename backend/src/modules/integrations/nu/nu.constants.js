/**
 * NU Car Rentals (affiliates portal) integration — shared constants.
 *
 * Split out from the service so the worker, scheduler, routes (Fase 5) and
 * tests can import the same source-of-truth strings without pulling in the
 * network/transport layer. Mirrors economy.constants.js.
 *
 * The NU portal is ASP.NET WebForms + Telerik RadControls — the list page is a
 * single Telerik RadGrid rendered as HTML (no DataTables JSON). Extraction =
 * parse the RadGrid HTML. Login + the date-range postback both use the Telerik
 * ClientState trick (see nu.service.js).
 *
 * See doc/nu-integration-plan-2026-07-09.md
 */

// Free-string sourceSystem stored on ExternalReservation / ExternalSyncRun /
// IntegrationCredential rows. Coexists with TL + Economy rows via the composite
// unique (sourceSystem, externalRef).
export const SOURCE_SYSTEM = 'NU';

// bookingChannel stamped on promoted Reservation rows. The UI "franchise
// import" badge keys off bookingChannel (FRANCHISE_*); the prepaid-vs-
// pay-at-destination TEXT is conditioned on isPrepaid (Fase 5).
export const BOOKING_CHANNEL = 'FRANCHISE_NU';

// BullMQ queue the scheduler enqueues onto and the worker registers.
export const QUEUE_NAME = 'nu.sync';

// reservationNumber prefix for promoted NU bookings (Economy uses 'ECON-').
export const RESERVATION_PREFIX = 'NU-';

// ---------------------------------------------------------------------------
// Portal URLs. NU affiliates portal (ASP.NET WebForms + Telerik).
// ---------------------------------------------------------------------------
export const BASE_URL = (
  process.env.NU_BASE || 'https://affiliates.nucarrentals.com'
).replace(/\/$/, '');

// Login page (WebForms). Overridable via env if the route ever moves.
export const LOGIN_PATH = (process.env.NU_LOGIN_PATH || '/AffiliateLOGIN.aspx');

// Authenticated reservations page: single page, Telerik RadGrid (id contains
// "RadGrid1"), full-page postback to itself. We GET it for a fresh viewstate,
// then POST the date-range query back to it.
export const RESERVATIONS_PATH = (process.env.NU_RESERVATIONS_PATH || '/affiliates.aspx');

// ---------------------------------------------------------------------------
// Telerik / WebForms field names (confirmed recon 2026-07-09).
// ---------------------------------------------------------------------------
// Login form fields.
export const LOGIN_USER_FIELD = 'txtLoginID';
export const LOGIN_PASS_FIELD = 'txtPSWD';
export const LOGIN_SUBMIT_FIELD = 'Button1';
export const LOGIN_SUBMIT_VALUE = 'Submit';

// Reservations-page control prefix (ASP.NET naming container).
export const CONTROL_PREFIX = 'ctl00$ContentPlaceHolder1$';

// Date-range query controls. The date filter is driven by a pair of Telerik
// RadDatePickers (START / END). Each picker submits SEVERAL coordinated hidden
// fields per pick — crucially the server reads the *_dateInput_ClientState blob
// (NOT the plain $dateInput), so setting only $dateInput silently yields an
// empty filter (0 rows). nu.service.fetchReservationList overrides all of a
// picker's fields by NAME SUFFIX, so it stays robust to the ctl00$...$ (UniqueID)
// / ctl00_..._ (ClientID) naming-container prefixes.
export const DATE_START_PICKER = 'RadDatePickerSTART';
export const DATE_END_PICKER = 'RadDatePickerEND';
// The date-type radio (Rental / Return / Taken Date) is left at its scraped
// default ("Rental Date") — its RadRadioButtonList1 ClientState hiddens are
// preserved verbatim in the postback, so we never set it explicitly.
export const DATE_TYPE_FIELD = 'RadRadioButtonList1';
export const DATE_TYPE_RENTAL = 'Rental Date';
export const REFRESH_GRID_TARGET = `${CONTROL_PREFIX}btnRefreshGrid`;

// ---------------------------------------------------------------------------
// RadGrid column-drift guard (FIX A — silent-miss hardening).
//
// parseRadGrid maps the grid POSITIONALLY (cell[15] = Total money, cell[16] =
// PP/OP prepaid code, …). That positional mapping is only safe while NU renders
// the columns in the validated order. These anchors pin the money/prepaid-
// critical columns to their expected HEADER index (0-based, matching the <th>
// order INCLUDING the 2 leading structural columns). If the grid renders but a
// header anchor is NOT where we expect, the layout has DRIFTED → parseRadGrid
// throws NuLayoutError instead of silently importing a shifted (corrupt
// estimatedTotal / isPrepaid) mapping. Substring match, case-insensitive.
// Update this map if NU ever re-orders the reservations grid.
// ---------------------------------------------------------------------------
export const HEADER_ANCHORS = Object.freeze({
  2: 'Confirmation',
  13: 'Class',
  14: 'Status',
  15: 'Total',
  16: 'Code',
});

// ---------------------------------------------------------------------------
// Timezone. NU's account is FLL (Fort Lauderdale) → Eastern.
// ---------------------------------------------------------------------------
export const TIME_ZONE = 'America/New_York';

// ACRISS class codes seen on the NU grid (informational — the AcrissCategoryMap
// is the authoritative mapping to a Ride vehicleType). Not an allow-list; any
// ACRISS code is parsed, this documents the observed set.
export const OBSERVED_ACRISS_CLASSES = Object.freeze([
  'IFAR', 'SFAR', 'CCAR', 'ECAR', 'FCAR', 'ICAR', 'MVAR', 'XXAR', 'FFAR',
]);

// ---------------------------------------------------------------------------
// Near-term date window (mirror Economy → NU_* env names). NU is 1:1 FLL so a
// single window suffices, but the per-config override + env-fallback helpers
// are kept (mirror Economy) so the config can carry lookbackDays/lookaheadDays.
// ---------------------------------------------------------------------------
export const DATE_WINDOW_LOOKBACK_DAYS = Number(
  process.env.NU_DATE_WINDOW_LOOKBACK_DAYS ?? 2
);
export const DATE_WINDOW_LOOKAHEAD_DAYS = Number(
  process.env.NU_DATE_WINDOW_LOOKAHEAD_DAYS ?? 30
);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Coerce a nullable per-config value to a finite non-negative day count, or null. */
function normalizeDays(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Effective [lookbackDays, lookaheadDays] for a single config row, applying the
 * env-default fallback when a column is null. Pure. Exported for tests.
 */
export function effectiveWindowDays(config = {}) {
  const back = normalizeDays(config?.lookbackDays);
  const ahead = normalizeDays(config?.lookaheadDays);
  return {
    lookbackDays: back == null ? DATE_WINDOW_LOOKBACK_DAYS : back,
    lookaheadDays: ahead == null ? DATE_WINDOW_LOOKAHEAD_DAYS : ahead,
  };
}

/**
 * Resolve a config's effective window to absolute [dateFrom, dateTo] Date bounds
 * relative to `now` (epoch ms, default Date.now()). Pure. Exported for tests.
 */
export function windowBoundsForConfig(config = {}, now = Date.now()) {
  const { lookbackDays, lookaheadDays } = effectiveWindowDays(config);
  return {
    dateFrom: new Date(now - lookbackDays * DAY_MS),
    dateTo: new Date(now + lookaheadDays * DAY_MS),
  };
}

// ---------------------------------------------------------------------------
// Date helpers.
// ---------------------------------------------------------------------------

/**
 * Format a Date (or epoch ms) as NU's expected M/D/YYYY portal date string —
 * e.g. 2026-07-09 → "7/9/2026". Month + day are NOT zero-padded (the recon
 * observed "07/9/2026"-style values; RadDatePicker accepts unpadded M/D/YYYY).
 * The date is evaluated in the FLL (Eastern) wall clock so the window matches
 * what the counter sees. Pure. Exported for tests.
 */
export function formatNuDate(date, timeZone = TIME_ZONE) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.valueOf())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const m = String(Number(get('month')));
  const day = String(Number(get('day')));
  const y = get('year');
  return `${m}/${day}/${y}`;
}

/**
 * Derive the prepaid flag from a grid Code cell. PP or OP → true (prepaid,
 * counter must NOT collect). Blank / any other value → false (pay-at-
 * destination, counter collects manually). Single source of truth — worker +
 * tests import this. Pure.
 */
export function isPrepaidFromCode(code) {
  if (code == null) return false;
  return /^(PP|OP)$/i.test(String(code).trim());
}
