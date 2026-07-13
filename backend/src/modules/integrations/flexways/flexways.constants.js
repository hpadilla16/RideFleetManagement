/**
 * Flexways (MobilityPS) integration — shared constants.
 *
 * Split out from the service so the worker, scheduler, routes and tests can
 * import the same source-of-truth strings without pulling in the network /
 * browser layer. Mirrors nu.constants.js / economy.constants.js.
 *
 * WHY this source is different from NU: NU is one ASP.NET WebForms grid rendered
 * as HTML behind a Telerik viewstate. Flexways is a PHP portal whose reservation
 * grid is a plain DataTables JSON endpoint (GET /Helpers/funcionesAjaxReservas.php
 * → { draw, recordsTotal, data:[[...]] }). Login is a real HTML <form> guarded by
 * reCAPTCHA v3 (invisible, score-based) → we drive the LEGITIMATE login page in a
 * headless browser so the page's own grecaptcha issues its token (NO captcha
 * solving). Also unlike NU (1:1 FLL), Flexways is MULTI-SEDE: inventory is keyed
 * by `idSede` (branch), so FlexwaysLocationConfig is a per-sede table (Economy's
 * multi-row shape), NOT a single 1:1 row.
 *
 * See doc/flexways-integration-plan-2026-07-13.md
 */

import { createWindowHelpers } from '../booking-source/window.js';

// Free-string sourceSystem stored on ExternalReservation / ExternalSyncRun /
// IntegrationCredential rows. Coexists with TL + Economy + NU rows via the
// composite unique (sourceSystem, externalRef).
export const SOURCE_SYSTEM = 'FLEXWAYS';

// bookingChannel stamped on promoted Reservation rows. The UI "franchise import"
// badge keys off bookingChannel (FRANCHISE_*).
export const BOOKING_CHANNEL = 'FRANCHISE_FLEXWAYS';

// BullMQ queue the scheduler enqueues onto and the worker registers.
export const QUEUE_NAME = 'flexways.sync';

// reservationNumber prefix for promoted Flexways bookings.
export const RESERVATION_PREFIX = 'FW-';

// ---------------------------------------------------------------------------
// Portal URLs. Flexways = MobilityPS (system.mobilityps.com), classic PHP.
// ---------------------------------------------------------------------------
export const BASE_URL = (
  process.env.FLEXWAYS_BASE || 'https://system.mobilityps.com'
).replace(/\/$/, '');

// Login page (real HTML <form> + reCAPTCHA v3). Overridable if the route moves.
export const LOGIN_PATH = process.env.FLEXWAYS_LOGIN_PATH || '/login.php';

// Reservations grid — DataTables JSON. The worker GETs this with the session
// cookie (per-sede via idSede) and JSON.parses the { data:[[...]] } payload.
export const LIST_PATH = process.env.FLEXWAYS_LIST_PATH || '/Helpers/funcionesAjaxReservas.php';

// ---------------------------------------------------------------------------
// Login form field names (recon 2026-07-13). The POST is usuario/clave plus two
// hidden fields (URI + userData, probable CSRF/state) that we re-send verbatim.
// grecaptcha v3 attaches its token in-page — we never touch it.
// ---------------------------------------------------------------------------
export const LOGIN_USER_FIELD = process.env.FLEXWAYS_LOGIN_USER_FIELD || 'usuario';
export const LOGIN_PASS_FIELD = process.env.FLEXWAYS_LOGIN_PASS_FIELD || 'clave';
// CSS selector for the submit control on the login page. Overridable because the
// exact button markup was not captured in the recon (live-PoC confirm).
export const LOGIN_SUBMIT_SELECTOR =
  process.env.FLEXWAYS_LOGIN_SUBMIT_SELECTOR || 'button[type="submit"], input[type="submit"]';

// ---------------------------------------------------------------------------
// DataTables grid column map (recon 2026-07-13, in-session). 9 columns, each
// cell may carry HTML fragments → strip tags. Positional (DataTables `data` is an
// array-of-arrays). Update if MobilityPS re-orders the grid.
//   0 = sede            ("Flexways Orlando - Vista East")
//   1 = booking date    ("DD/MM/YYYY HH:mm" — LATAM order)
//   2 = pickup datetime
//   3 = pickup location
//   4 = dropoff location
//   5 = channel         ("API")
//   6 = customer + code  ("Joan V... VISSAHE")
//   7 = status          (icon + tooltip "Reserva Nueva - API")
//   8 = ref             ("QSRC58")
// NOT in the grid (they live in the per-reservation DETAIL page — mapped in a
// follow-up once the detail endpoint is captured live): ACRISS/class, total +
// currency, customer email/phone.
// ---------------------------------------------------------------------------
export const COL = Object.freeze({
  SEDE: 0,
  BOOKED_AT: 1,
  PICKUP_AT: 2,
  PICKUP_LOCATION: 3,
  DROPOFF_LOCATION: 4,
  CHANNEL: 5,
  CUSTOMER: 6,
  STATUS: 7,
  REF: 8,
});
export const EXPECTED_COLUMN_COUNT = 9;

// ---------------------------------------------------------------------------
// Timezone. The active account is Flexways ORLANDO → US Eastern. Recon flagged TZ
// as "confirm in the PoC" (MobilityPS is a LATAM platform); Orlando wall-clock is
// Eastern so we default there. Overridable via env if a sede is in another TZ.
// ---------------------------------------------------------------------------
export const TIME_ZONE = process.env.FLEXWAYS_TIME_ZONE || 'America/New_York';

// ---------------------------------------------------------------------------
// Near-term date window (mirror NU/Economy → FLEXWAYS_* env names). The worker
// queries pickups in [today - LOOKBACK, today + LOOKAHEAD]. Per-sede
// lookbackDays/lookaheadDays on FlexwaysLocationConfig override these when set.
// The math is delegated to the shared booking-source window factory so it can
// never drift from NU/Economy.
// ---------------------------------------------------------------------------
export const DATE_WINDOW_LOOKBACK_DAYS = Number(
  process.env.FLEXWAYS_DATE_WINDOW_LOOKBACK_DAYS ?? 2
);
export const DATE_WINDOW_LOOKAHEAD_DAYS = Number(
  process.env.FLEXWAYS_DATE_WINDOW_LOOKAHEAD_DAYS ?? 30
);

const _windowHelpers = createWindowHelpers({
  defaultLookbackDays: DATE_WINDOW_LOOKBACK_DAYS,
  defaultLookaheadDays: DATE_WINDOW_LOOKAHEAD_DAYS,
});

// Re-export the shared helpers under this source's names (parity with NU's
// constants surface — tests + worker import effectiveWindowDays /
// windowBoundsForConfig / unionWindow* from here).
export const effectiveWindowDays = _windowHelpers.effectiveWindowDays;
export const windowBoundsForConfig = _windowHelpers.windowBoundsForConfig;
export const unionWindowDays = _windowHelpers.unionWindowDays;
export const unionWindowBounds = _windowHelpers.unionWindowBounds;

// ---------------------------------------------------------------------------
// Date helpers.
// ---------------------------------------------------------------------------

/**
 * Parse a Flexways "DD/MM/YYYY HH:mm" (LATAM day-first) cell into a UTC Date,
 * interpreting the wall-clock in `timeZone`. Tolerates a date-only cell
 * ("DD/MM/YYYY" → 00:00) and 2-digit years. Returns null when unparseable.
 * Pure. Exported for tests.
 *
 * The `import`-free implementation converts to ISO first then hands the naive
 * wall-clock to parseDateTimeInTz (same seam NU uses) — keeping the DST math in
 * one place. `parseDateTimeInTz` is injected by the service to avoid a cycle in
 * pure-test contexts; callers pass it (constants stay dependency-light).
 */
export function toIsoFromLatam(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  // "DD/MM/YYYY HH:mm[:ss]" or "DD/MM/YYYY" (day-first LATAM order).
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  let [, dd, mo, yr, hh = '0', mi = '0', se = '0'] = m;
  if (yr.length === 2) yr = `20${yr}`;
  const pad = (n, w = 2) => String(Number(n)).padStart(w, '0');
  return `${pad(yr, 4)}-${pad(mo)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:${pad(se)}`;
}
