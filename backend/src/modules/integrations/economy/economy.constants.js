/**
 * Economy (RezLight) integration — shared constants.
 *
 * Split out from the service so the worker, scheduler, routes (Fase 5), and
 * tests can import the same source-of-truth strings without pulling in the
 * network/transport layer. Mirrors the constant shape TL International inlines
 * in its service module, but Economy keeps them here because more callers
 * (scheduler + worker + future routes) reference them.
 *
 * See doc/economy-integration-plan-2026-07-05.md
 */

// Free-string sourceSystem stored on ExternalReservation / ExternalSyncRun /
// IntegrationCredential rows. Coexists with TL rows via the composite unique
// (sourceSystem, externalRef).
export const SOURCE_SYSTEM = 'ECONOMY';

// bookingChannel stamped on promoted Reservation rows. The UI "franchise
// import" badge keys off bookingChannel — Economy gets its own value so it can
// be distinguished from FRANCHISE_TL.
export const BOOKING_CHANNEL = 'FRANCHISE_ECONOMY';

// BullMQ queue the scheduler enqueues onto and the worker registers.
export const QUEUE_NAME = 'economy.sync';

// reservationNumber prefix for promoted Economy bookings (TL uses 'TL-').
export const RESERVATION_PREFIX = 'ECON-';

// RezLight portal base URL. Default is the Production instance; override via
// ECONOMY_BASE for a staging mirror.
export const BASE_URL = (
  process.env.ECONOMY_BASE || 'https://rezlight.economyrentacar.com/Production'
).replace(/\/$/, '');

// ---------------------------------------------------------------------------
// GetReservationLookupRecords payload (captured from the live portal 2026-07-05)
// ---------------------------------------------------------------------------
//
// The list endpoint is a DataTables server-side grid. The request needs THREE
// url-encoded params:
//   __RequestVerificationToken — fresh anti-CSRF token scraped from an authed page
//   jsonPaginationParameters   — DataTables JSON built from LOOKUP_COLUMNS below
//   pFilter                    — {"docType":"R"} (R=Reservation); WITHOUT it the
//                                endpoint returns 0 rows.
// The 13 columns, in portal order. Index 3 (rgLocPickup) is the one the worker
// slices to derive the external area.
export const LOOKUP_COLUMNS = Object.freeze([
  'rgConfirmation',
  'rgDateBooked',
  'rgClass', // ACRISS
  'rgLocPickup',
  'rgLocDropOff',
  'rgDatePickup',
  'rgDateDropOff',
  'rgRate',
  'rgLastName',
  'rgName',
  'rgEmail',
  'rgIata',
  'rgStatus',
]);

// pFilter constant — R = Reservation documents (vs quotes, etc.).
export const LOOKUP_PFILTER = Object.freeze({ docType: 'R' });

// ---------------------------------------------------------------------------
// Endpoint paths (relative to BASE_URL)
// ---------------------------------------------------------------------------
export const LIST_PATH = '/RezAlliance/Reservations/GetReservationLookupRecords';
// The authed page we GET to scrape a fresh __RequestVerificationToken before a
// list POST (and to confirm the session didn't bounce to login).
export const AUTHED_PAGE_PATH = '/RezAlliance/Reservations';
// Detail endpoint (command-based). See ECONOMY_DETAIL_COMMAND seam in the
// service — the exact command/payload is a documented constant pending a
// follow-up capture; the list row alone carries enough to create the
// ExternalReservation.
export const DETAIL_PATH = '/RezAlliance/Reservations';

// ---------------------------------------------------------------------------
// Near-term date window (the account sees the FULL ~92k-row history — NEVER
// sweep it all). The worker filters the list to pickups in
// [today - LOOKBACK_DAYS, today + LOOKAHEAD_DAYS] via rgDatePickup. Overridable
// via env for tuning without a code change.
// ---------------------------------------------------------------------------
export const DATE_WINDOW_LOOKBACK_DAYS = Number(
  process.env.ECONOMY_DATE_WINDOW_LOOKBACK_DAYS ?? 2
);
export const DATE_WINDOW_LOOKAHEAD_DAYS = Number(
  process.env.ECONOMY_DATE_WINDOW_LOOKAHEAD_DAYS ?? 30
);

// ---------------------------------------------------------------------------
// Per-area date window (2026-07-09, Fase 5 — Hector: "editable por área").
//
// Each EconomyLocationConfig row MAY carry its own lookbackDays / lookaheadDays.
// When a value is null the effective window for that area falls back to the env
// defaults above. Because ONE credential + ONE list call covers every enabled
// area, the worker computes the UNION window (widest lookback + widest lookahead
// across the tenant's enabled configs) for the single fetch, then applies each
// area's OWN [lookback, lookahead] window as a per-row precision filter.
//
// These helpers are the single source of truth for that math — worker + tests
// import them so the union and the per-area filter can never drift apart.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Coerce a nullable per-area value to a finite non-negative day count, or null. */
function normalizeDays(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Effective [lookbackDays, lookaheadDays] for a single config row, applying the
 * env-default fallback when a column is null. Pure. Exported for tests.
 * @param {{lookbackDays?: number|null, lookaheadDays?: number|null}} config
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
 * UNION window for the single list fetch: the WIDEST lookback + WIDEST lookahead
 * across every ENABLED config (env fallback applied per null value). Guarantees
 * the one fetch is broad enough to contain every area's own window. When there
 * are no configs it still returns the env defaults so callers stay well-defined.
 * Pure. Exported for tests.
 * @param {Array<{lookbackDays?: number|null, lookaheadDays?: number|null}>} configs
 * @returns {{ lookbackDays: number, lookaheadDays: number }}
 */
export function unionWindowDays(configs = []) {
  let back = DATE_WINDOW_LOOKBACK_DAYS;
  let ahead = DATE_WINDOW_LOOKAHEAD_DAYS;
  for (const c of Array.isArray(configs) ? configs : []) {
    const eff = effectiveWindowDays(c);
    if (eff.lookbackDays > back) back = eff.lookbackDays;
    if (eff.lookaheadDays > ahead) ahead = eff.lookaheadDays;
  }
  return { lookbackDays: back, lookaheadDays: ahead };
}

/**
 * Resolve a config's effective window to absolute [dateFrom, dateTo] Date bounds
 * relative to `now` (epoch ms, default Date.now()). Pure. Exported for tests.
 * @returns {{ dateFrom: Date, dateTo: Date }}
 */
export function windowBoundsForConfig(config = {}, now = Date.now()) {
  const { lookbackDays, lookaheadDays } = effectiveWindowDays(config);
  return {
    dateFrom: new Date(now - lookbackDays * DAY_MS),
    dateTo: new Date(now + lookaheadDays * DAY_MS),
  };
}

/**
 * Resolve the UNION window across enabled configs to absolute [dateFrom, dateTo]
 * Date bounds relative to `now`. Pure. Exported for tests.
 * @returns {{ dateFrom: Date, dateTo: Date }}
 */
export function unionWindowBounds(configs = [], now = Date.now()) {
  const { lookbackDays, lookaheadDays } = unionWindowDays(configs);
  return {
    dateFrom: new Date(now - lookbackDays * DAY_MS),
    dateTo: new Date(now + lookaheadDays * DAY_MS),
  };
}

// ---------------------------------------------------------------------------
// Bounded list fetch (M1). The DataTables lookup is sorted by rgDatePickup
// DESCENDING and PAGINATED: the worker fetches pages of ECONOMY_LOOKUP_PAGE_SIZE
// rows, advancing start each page, and STOPS as soon as a page's rows cross
// below dateFrom (desc order → no later page can be in-window) OR the hard
// ECONOMY_MAX_PAGES cap is hit. This bounds the sweep at
// PAGE_SIZE * MAX_PAGES rows — NEVER the full ~92k history. If the cap is hit
// before crossing dateFrom, the service WARNs (window > cap) instead of
// silently truncating.
export const LOOKUP_PAGE_SIZE = Math.max(
  1,
  Number(process.env.ECONOMY_LOOKUP_PAGE_SIZE ?? 200)
);
export const MAX_PAGES = Math.max(
  1,
  Number(process.env.ECONOMY_MAX_PAGES ?? 25)
);

// Column index of rgDatePickup within LOOKUP_COLUMNS — the sort key sent on the
// DataTables `order` param. Derived from LOOKUP_COLUMNS so it can't drift.
export const RG_DATE_PICKUP_INDEX = LOOKUP_COLUMNS.indexOf('rgDatePickup');

// ---------------------------------------------------------------------------
// Per-external-area timezone. Economy is multi-timezone (unlike TL, which was
// PR-only): the worker resolves the mapped Ride location's area to an IANA zone
// so the duplicate detector truncates pickup days against the operator's wall
// clock, not server UTC. Falls back to America/New_York (the default Economy
// market is Miami) for any unlisted area.
// ---------------------------------------------------------------------------
export const AREA_TIMEZONES = Object.freeze({
  MIA: 'America/New_York',
  FLL: 'America/New_York',
  MCO: 'America/New_York',
  LAX: 'America/Los_Angeles',
});
export const DEFAULT_AREA_TIMEZONE = 'America/New_York';

/**
 * Resolve the IANA timezone for an external area (e.g. 'MIA' → America/New_York).
 * Case-insensitive; unlisted areas fall back to DEFAULT_AREA_TIMEZONE.
 */
export function timeZoneForArea(area) {
  if (!area) return DEFAULT_AREA_TIMEZONE;
  return AREA_TIMEZONES[String(area).trim().toUpperCase()] || DEFAULT_AREA_TIMEZONE;
}

/**
 * Derive the external area from a raw rgLocPickup code. The area is the first
 * 3 chars, uppercased (MIAO01 → MIA). Returns null for empty/short input.
 * The single source of truth for the area rule — worker + tests import this.
 */
export function areaFromLocPickup(rgLocPickup) {
  if (rgLocPickup == null) return null;
  const s = String(rgLocPickup).trim();
  if (s.length < 3) return null;
  return s.slice(0, 3).toUpperCase();
}
