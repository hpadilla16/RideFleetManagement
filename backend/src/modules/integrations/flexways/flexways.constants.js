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
// NOTE: this grid does NOT carry idAlquiler (the detail-page key). Fase 3.5
// switched the worker's list source to CONTRACT_LIST_PATH (below); LIST_PATH +
// its parser are kept for the auth probe + backward compat.
export const LIST_PATH = process.env.FLEXWAYS_LIST_PATH || '/Helpers/funcionesAjaxReservas.php';

// ---------------------------------------------------------------------------
// Fase 3.5 detail-fetch endpoints (recon 2026-07-13, idAlquiler=485160).
//
// CONTRACT_LIST_PATH — DataTables list that DOES carry idAlquiler (the key the
// detail page needs). Unlike LIST_PATH, its `data` is an ARRAY-OF-OBJECTS whose
// keys are "0".."11" (NOT array-of-arrays like the reservations grid).
//
// DETAIL_PATH — per-reservation HTML form (~1MB) keyed by ?idAlquiler=<id>. It
// carries the fields the grid/contract-list lack: real customer email, external
// customer id, total + currency, and the vehicle category label whose trailing
// parenthetical is the ACRISS code. Parsed by parseReservationDetailHtml().
// ---------------------------------------------------------------------------
export const CONTRACT_LIST_PATH =
  process.env.FLEXWAYS_CONTRACT_LIST_PATH || '/Helpers/funcionesAjaxContratos.php';
// The AJAX endpoint above reads its tablaActual/contratosAbiertos/idSede filter
// from SERVER-SIDE SESSION STATE, which is set by first loading the list PAGE
// (listadoCotizaciones.php) with those params in the URL. A fresh worker session
// that hits the AJAX directly gets recordsTotal:null — so we GET this page first
// to prime the session (verified live 2026-07-14). Env-overridable.
export const CONTRACT_LIST_PAGE_PATH =
  process.env.FLEXWAYS_CONTRACT_LIST_PAGE_PATH || '/Comercial/Reservas/listadoCotizaciones.php';
export const DETAIL_PATH =
  process.env.FLEXWAYS_DETAIL_PATH || '/Comercial/Reservas/modificarReserva.php';

// Required query params for the contract-list DataTables endpoint. VERIFIED LIVE
// 2026-07-14: without these the endpoint returns `recordsTotal:null` (empty);
// WITH them the same idSede returns the real open-contracts table (recordsTotal
// 200 for sede 383). Taken verbatim from the portal page URL
//   listadoCotizaciones.php?tablaActual=3&contratosAbiertos=1&idSede=<sede>
// whose DataTables source is funcionesAjaxContratos.php. Overridable via env in
// case Flexways changes the tab id.
export const CONTRACT_LIST_TABLA_ACTUAL =
  process.env.FLEXWAYS_CONTRACT_TABLA_ACTUAL || '3';
export const CONTRACT_LIST_CONTRATOS_ABIERTOS =
  process.env.FLEXWAYS_CONTRACT_CONTRATOS_ABIERTOS || '1';

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
// Contract-list column map (recon 2026-07-13, funcionesAjaxContratos.php). The
// DataTables `data` is an ARRAY-OF-OBJECTS with numeric-string keys ("0".."11"),
// not an array-of-arrays. 12 columns:
//   0  = idAlquiler   (numeric rental id, e.g. "485160" — the DETAIL-page key)
//   1  = iniciales
//   2  = sede
//   3  = fecha PICKUP   (rental-start / recogida — "Desde", the window key)
//   4  = fecha devolución (return / dropoff — "Hasta")
//   5  = pickup location
//   6  = dropoff location
//   7  = canal        ("API" = afiliado)
//   8  = nombre cliente
//   9  = (empty)
//   10 = ref          (booking ref, e.g. "49AGTH" → externalRef)
//   11 = acciones     (HTML action buttons)
//
// PICKUP/DROPOFF RESOLVED (live 2026-07-14, sede 383): col 3 and col 4 match the
// detail page's fechaHoraDesde / fechaHoraHasta exactly, so col 3 = pickup
// (Desde) and col 4 = return (Hasta). The recon's original mapping was correct;
// the "open contracts" tab shows rentals whose pickup already happened, which is
// why col 3 reads as a recent date. Both remain env-overridable.
// ---------------------------------------------------------------------------
export const CONTRACT_COL = Object.freeze({
  ID_ALQUILER: Number(process.env.FLEXWAYS_CONTRACT_COL_ID ?? 0),
  INITIALS: 1,
  SEDE: Number(process.env.FLEXWAYS_CONTRACT_COL_SEDE ?? 2),
  // CONFIRMED LIVE 2026-07-14 (sede 383, cross-checked against the detail page's
  // fechaHoraDesde/fechaHoraHasta): col 3 = pickup/rental-start (Desde),
  // col 4 = return/dropoff (Hasta). The recon's original mapping was correct.
  PICKUP_AT: Number(process.env.FLEXWAYS_CONTRACT_COL_PICKUP ?? 3),
  DROPOFF_AT: Number(process.env.FLEXWAYS_CONTRACT_COL_DROPOFF ?? 4),
  PICKUP_LOCATION: Number(process.env.FLEXWAYS_CONTRACT_COL_PICKUP_LOC ?? 5),
  DROPOFF_LOCATION: Number(process.env.FLEXWAYS_CONTRACT_COL_DROPOFF_LOC ?? 6),
  CHANNEL: Number(process.env.FLEXWAYS_CONTRACT_COL_CHANNEL ?? 7),
  CUSTOMER: Number(process.env.FLEXWAYS_CONTRACT_COL_CUSTOMER ?? 8),
  REF: Number(process.env.FLEXWAYS_CONTRACT_COL_REF ?? 10),
  ACTIONS: 11,
});
export const EXPECTED_CONTRACT_COLUMN_COUNT = 12;

// ---------------------------------------------------------------------------
// The LEFT-anchored CONTRACT_COL indices above are NOT stable: the portal's
// DataTables sometimes prepends a hidden idAlquiler column (12 cols) and
// sometimes omits it (11 cols), shifting every left index by one — so the
// worker's fresh session and the browser can see different layouts for the same
// request (verified live 2026-07-14). The TRAILING columns are stable, so the
// parser anchors from the END. Offsets are distance-from-last (1 = last column).
//   last(1)   = actions (HTML dropdown; carries the idAlquiler hidden input)
//   last-1(2) = ref (e.g. 49AGTH)
//   last-2(3) = (empty)
//   last-3(4) = customer name
//   last-4(5) = channel ("API")
//   last-5(6) = dropoff location
//   last-6(7) = pickup location
//   last-7(8) = return / Hasta  (single LATAM datetime)
//   last-8(9) = pickup / Desde  (compound cell: ISO date label + LATAM datetime)
//   last-9(10)= sede
// ---------------------------------------------------------------------------
export const CONTRACT_COL_FROM_END = Object.freeze({
  ACTIONS: 1,
  REF: 2,
  CUSTOMER: 4,
  CHANNEL: 5,
  DROPOFF_LOCATION: 6,
  PICKUP_LOCATION: 7,
  DROPOFF_AT: 8,
  PICKUP_AT: 9,
  SEDE: 10,
});

// idAlquiler (the detail-page key) is delivered ONLY inside the actions column,
// as a hidden input `<input ... name="idAlquiler" value="485556">`. This is the
// single positionally-stable place it appears regardless of the 11/12-col shift.
// Verified live 2026-07-14. Exported for the parser + tests.
export const ID_ALQUILER_RE = /idAlquiler["']\s+value=["'](\d+)["']/i;

// Which contract-list channels to import. FAIL-CLOSED default = ['API'] (only
// affiliate bookings) — funcionesAjaxContratos carries a `canal` column BECAUSE
// it also holds walk-in/counter/Web contracts, and this integration only wants
// affiliate rows. Importing a tenant's own counter rentals back in would create
// spurious reservations the dedup can't always catch (Innovation 2026-07-13).
// Override with FLEXWAYS_CONTRACT_CHANNELS (comma list); set to "ALL" to import
// every channel deliberately.
export const CONTRACT_CHANNEL_FILTER = (() => {
  const raw = process.env.FLEXWAYS_CONTRACT_CHANNELS;
  if (raw === undefined || raw === null || raw.trim() === '') return ['API'];
  if (raw.trim().toUpperCase() === 'ALL') return []; // [] = no filter = import all
  return raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
})();

// ---------------------------------------------------------------------------
// Detail-page (modificarReserva.php) form field names + parsing knobs (recon
// idAlquiler=485160). All overridable — the exact form markup was captured but
// field names are the piece most likely to shift, so keep them in env-swap reach.
// ---------------------------------------------------------------------------
export const DETAIL_FIELD = Object.freeze({
  EMAIL: process.env.FLEXWAYS_DETAIL_EMAIL_FIELD || 'emailCustomer',
  EMAIL_FALLBACK: process.env.FLEXWAYS_DETAIL_EMAIL_FALLBACK_FIELD || 'email',
  CUSTOMER_ID: process.env.FLEXWAYS_DETAIL_CUSTOMER_ID_FIELD || 'idCliente',
  CUSTOMER_ID_FALLBACK: process.env.FLEXWAYS_DETAIL_CUSTOMER_ID_FALLBACK_FIELD || 'cbCliente',
  TOTAL: process.env.FLEXWAYS_DETAIL_TOTAL_FIELD || 'total',
  TOTAL_FALLBACK: process.env.FLEXWAYS_DETAIL_TOTAL_FALLBACK_FIELD || 'totalfin',
  CURRENCY_SELECT: process.env.FLEXWAYS_DETAIL_CURRENCY_FIELD || 'cbMoneda',
  CATEGORY_SELECT: process.env.FLEXWAYS_DETAIL_CATEGORY_FIELD || 'cbCategoria',
});

// The `email` fallback input can carry a "test@test.com" placeholder → never
// treat it as the real customer email (would poison customer matching).
export const DETAIL_EMAIL_PLACEHOLDER = (
  process.env.FLEXWAYS_DETAIL_EMAIL_PLACEHOLDER || 'test@test.com'
).toLowerCase();

// Politeness delay between per-reservation DETAIL fetches (mirror Economy's
// 500–1500ms). The portal is hit once per contract row, so we never hammer it.
export const DETAIL_DELAY_MIN_MS = Number(process.env.FLEXWAYS_DETAIL_DELAY_MIN_MS ?? 500);
export const DETAIL_DELAY_MAX_MS = Number(process.env.FLEXWAYS_DETAIL_DELAY_MAX_MS ?? 1500);

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
