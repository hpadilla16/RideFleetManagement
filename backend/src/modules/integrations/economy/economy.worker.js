/**
 * Economy (RezLight) sync worker — one BullMQ job that pulls the near-term
 * reservation list, filters it by the tenant's enabled areas, stages the rows
 * into ExternalReservation, and (when possible) auto-promotes them.
 *
 * Clones the TL International worker's run lifecycle, but with two Economy
 * specifics:
 *   1. LOCATION FILTER (the core): for each list row, area = first 3 chars of
 *      rgLocPickup, uppercased (MIAO01 → MIA). Keep the row ONLY if an enabled
 *      EconomyLocationConfig(tenantId, externalArea=area) exists, and map it to
 *      that config's Ride locationId. Rows for a disabled/unknown area are
 *      dropped (never staged).
 *   2. PER-AREA TIMEZONE: Economy is multi-timezone; the mapped area resolves
 *      an IANA zone (MIA/FLL/MCO=America/New_York, LAX=America/Los_Angeles)
 *      passed to the duplicate detector so pickup-day comparison uses the
 *      operator's wall clock, not server UTC.
 *
 * Reuses promotion-matcher (evaluatePromotion) + duplicate-detector
 * (findDuplicateReservation) + the promoteWithMappings shape from TL, unchanged.
 *
 * MONEY: writes ONLY estimatedTotal on the Reservation. No charge, no card, no
 * autocharge — same posture as TL.
 *
 * See doc/economy-integration-plan-2026-07-05.md
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { importCustomerEmailOrNull } from '../../../lib/customer-email.js';
import { captureBackendException } from '../../../lib/sentry.js';
import { registerWorker, enqueueJob } from '../../../lib/queue/index.js';
import { SCRAPER_PRIORITY } from '../../../lib/queue/priorities.js';
import { parseDateTimeInTz } from '../../../lib/date-utils.js';
import {
  fetchReservationList,
  fetchReservationDetail,
  sleep,
  randomDelay,
  pickUserAgent,
  DETAIL_DELAY_MIN_MS,
  DETAIL_DELAY_MAX_MS,
  DETAIL_ENABLED,
  EconomyAuthExpiredError,
  clearSession,
} from './economy.service.js';
import {
  SOURCE_SYSTEM,
  BOOKING_CHANNEL,
  QUEUE_NAME,
  RESERVATION_PREFIX,
  areaFromLocPickup,
  timeZoneForArea,
  unionWindowBounds,
  windowBoundsForConfig,
} from './economy.constants.js';
import { parseRezDate } from './economy.service.js';
import { evaluatePromotion, REVIEW_REASONS } from '../tl-international/promotion-matcher.service.js';
import { findDuplicateReservation } from '../tl-international/duplicate-detector.service.js';

export { QUEUE_NAME };

// ---------------------------------------------------------------------------
// Auto-create customer (mirrors TL). When promotion is blocked ONLY by
// customer_not_found and ECONOMY_AUTO_CREATE_CUSTOMERS is enabled, create a
// lightweight Customer from the list-row data and re-evaluate.
// ---------------------------------------------------------------------------
function autoCreateCustomersEnabled() {
  const raw = (process.env.ECONOMY_AUTO_CREATE_CUSTOMERS ?? 'false').toString().trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

const CUSTOMER_PHONE_PLACEHOLDER = '0000000000';

export async function maybeCreateCustomerFromEconomy(prismaClient, extRes) {
  const firstName = (extRes.customerFirstName || '').trim();
  const lastName = (extRes.customerLastName || '').trim();
  // Writer #12 of the customer-email inventory (lib/customer-email.js). IMPORT
  // policy — drop to null and warn; a bad cell never costs us the reservation.
  const email = importCustomerEmailOrNull(extRes.customerEmail, {
    log: logger,
    source: 'economy',
    tenantId: extRes.tenantId,
    externalRef: extRes.externalRef,
  }) || '';
  const phone = (extRes.customerPhone || '').trim();

  if (!firstName || !lastName) return null;
  if (!email && !phone) return null;

  if (email) {
    const existing = await prismaClient.customer.findFirst({
      where: { tenantId: extRes.tenantId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    }).catch(() => null);
    if (existing) return existing;
  }

  const created = await prismaClient.customer.create({
    data: {
      tenantId: extRes.tenantId,
      firstName,
      lastName,
      email: email || null,
      phone: phone || CUSTOMER_PHONE_PLACEHOLDER,
      country: extRes.customerCountry || null,
    },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  });
  logger.info('[economy-sync] auto-created Customer from Economy data', {
    tenantId: extRes.tenantId,
    externalRef: extRes.externalRef,
    customerId: created.id,
  });
  return created;
}

// ---------------------------------------------------------------------------
// Field mapper — list row (rg*) → ExternalReservation shape. Pure. Exported.
//
// A row may arrive as an object keyed by the 13 column names, or (defensively)
// as a positional array in LOOKUP_COLUMNS order. When a DETAIL object is
// available (res* fields), it overrides/enriches (flight, amounts, currency).
// The `timeZone` (resolved from the mapped area) governs how naive date strings
// are interpreted into UTC instants.
// ---------------------------------------------------------------------------
const LIST_INDEX = Object.freeze({
  rgConfirmation: 0,
  rgDateBooked: 1,
  rgClass: 2,
  rgLocPickup: 3,
  rgLocDropOff: 4,
  rgDatePickup: 5,
  rgDateDropOff: 6,
  rgRate: 7,
  rgLastName: 8,
  rgName: 9,
  rgEmail: 10,
  rgIata: 11,
  rgStatus: 12,
});

function pickCol(row, key) {
  if (row == null) return null;
  if (Array.isArray(row)) {
    const v = row[LIST_INDEX[key]];
    return v == null || v === '' ? null : v;
  }
  const v = row[key];
  return v == null || v === '' ? null : v;
}

function toDecimalString(v) {
  if (v == null) return null;
  // Strip currency symbols/commas that RezLight may include in rgRate.
  const s = String(v).replace(/[^0-9.\-]/g, '').trim();
  if (s === '' || s === '0' || s === '0.00' || s === '-') return null;
  return s;
}

/**
 * Reinterpret a RezLight date value against a tenant/area timezone → UTC Date.
 * Handles ASP.NET "/Date(ms)/" (already an absolute instant), US
 * "MM/DD/YYYY[ HH:mm]" (RezLight's native shape — normalized to naive ISO so
 * parseDateTimeInTz takes its timezone path; the raw string would fall through
 * to `new Date()` and be read as server-UTC, which is the "everything imports
 * at 8pm" bug), and naive/ISO strings (interpreted in `timeZone`).
 */
function toDate(v, timeZone) {
  if (v == null || v === '') return null;
  let s = String(v).trim();
  const aspNet = s.match(/\/Date\((\d+)([-+]\d+)?\)\//);
  if (aspNet) {
    const ms = Number(aspNet[1]);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (us) {
    const [, mo, day, yr, hh, mi, se] = us;
    const pad = (n) => String(n).padStart(2, '0');
    s = `${yr}-${pad(mo)}-${pad(day)}T${pad(hh ?? '0')}:${mi ?? '00'}${se ? `:${se}` : ''}`;
  }
  // Naive / ISO string → interpret in the area timezone.
  const d = parseDateTimeInTz(s, timeZone);
  return d && Number.isFinite(d.valueOf()) ? d : null;
}

/**
 * @param {object|array} row      the DataTables list row
 * @param {object}       opts     { detail?, timeZone }
 * @returns {object} ExternalReservation create/update shape (no tenantId/sourceSystem)
 */
// Detail values use '' (or a literal null) for "not captured" — treat both as
// absent so an empty detail field can never clobber a real list value.
function detVal(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Candidate sources for the two date fields, in priority order.
 *
 * `full: true` means the key carries "MM/DD/YYYY HH:mm" (date AND time).
 * `full: false` is a date-only degradation — resolving from it silently pins
 * the reservation to local midnight, which is exactly how the dropoff bug
 * survived a month unnoticed (see resolveDateField's onFallback).
 *
 * NOTE ON SPELLING: the portal is inconsistent WITH ITSELF. It sends
 * resDropOffDate, resDropOffTime and resDropOffLocation with a capital "O",
 * but the full-date field as `resDropoffFullDate` — lowercase "o". Verified
 * against production 2026-08-26: of 4,661 Economy rows carrying detail JSON,
 * 4,661 have the lowercase key and ZERO have the capitalised one. Both
 * spellings are accepted, lowercase first, because the portal has proven it
 * may rename this again.
 */
const DATE_SOURCES = Object.freeze({
  pickupAt: Object.freeze({
    detail: Object.freeze([
      { key: 'resPickupFullDate', full: true },
      { key: 'resPickupDate', full: false },
    ]),
    listKey: 'rgDatePickup',
  }),
  dropoffAt: Object.freeze({
    detail: Object.freeze([
      { key: 'resDropoffFullDate', full: true },  // what the portal actually sends
      { key: 'resDropOffFullDate', full: true },  // symmetric spelling, tolerated
      { key: 'resDropOffDate', full: false },     // date-only → local midnight
    ]),
    listKey: 'rgDateDropOff',
  }),
});

/**
 * Resolve pickupAt/dropoffAt and REPORT which source won.
 *
 * A missing field must never degrade silently: when the winning source is not
 * the preferred full-date key, `onFallback` fires so the caller can surface it
 * on day one instead of after a month of midnight timestamps.
 *
 * @param {(info: {field, source, degraded, externalRef}) => void} [onFallback]
 */
function resolveDateField(field, d, row, timeZone, externalRef, onFallback) {
  const spec = DATE_SOURCES[field];
  const preferred = spec.detail[0].key;
  const report = (source, degraded) => {
    if (source === preferred || typeof onFallback !== 'function') return;
    onFallback({ field, source, degraded, externalRef });
  };

  for (const cand of spec.detail) {
    const v = detVal(d[cand.key]);
    if (v == null) continue;
    report(cand.key, !cand.full);
    return toDate(v, timeZone);
  }

  const listVal = pickCol(row, spec.listKey);
  if (listVal != null) {
    report(spec.listKey, true); // list columns are date-only
    return toDate(listVal, timeZone);
  }

  report(null, true);
  return null;
}

export function mapRowToExternalReservation(row, opts = {}) {
  const { detail = null, timeZone = 'America/New_York', onDateFallback = null } = opts;
  const d = detail && typeof detail === 'object' ? detail : {};

  const externalRef = String(pickCol(row, 'rgConfirmation') || '').trim();
  const firstName = pickCol(row, 'rgName');       // rgName = given name
  const lastName = pickCol(row, 'rgLastName');
  const email = pickCol(row, 'rgEmail');
  const acriss = pickCol(row, 'rgClass');
  const locPickup = pickCol(row, 'rgLocPickup');
  const locDropOff = pickCol(row, 'rgLocDropOff');
  const rate = pickCol(row, 'rgRate');
  const iata = pickCol(row, 'rgIata');
  const status = pickCol(row, 'rgStatus');

  return {
    externalRef,
    channel: detVal(d.resProvider) ?? iata ?? null,
    supplierRef: detVal(d.resIata) ?? iata ?? null,
    status: 'CONFIRMED', // Economy list rows are confirmed reservations
    customerFirstName: detVal(d.resCustomerName) ?? (firstName != null ? String(firstName).trim() : null),
    customerLastName: detVal(d.resCustomerLastName) ?? (lastName != null ? String(lastName).trim() : null),
    customerEmail: detVal(d.resCustomerEmail) ?? (email != null ? String(email).trim() : null),
    customerPhone: detVal(d.resCustomerPhone),
    // CONFIRMED ABSENT (production key audit 2026-08-26): the RezLight detail
    // payload has NO country field at all — not resCustomerCountry, not any
    // alias. This column is therefore always null for Economy. Left in place
    // (harmless) rather than removed, so the intent stays visible; there is no
    // correct key to point it at.
    customerCountry: detVal(d.resCustomerCountry),
    // resReqFlight is a Y/N "flight required" flag — the actual flight lives in
    // resCustomerFlightInfo.
    flightNumber: detVal(d.resCustomerFlightInfo),
    vehicleAcriss: detVal(d.resVehClass) ?? (acriss != null ? String(acriss).trim().toUpperCase() : null),
    // The portal's key is resVehClassDescription. resVehDescription/resDescription
    // were never sent (0 of 4,661 production rows carry either), so this column
    // was always null before 2026-08-26; they are kept only as tolerated aliases.
    vehicleDescription:
      detVal(d.resVehClassDescription) ?? detVal(d.resVehDescription) ?? detVal(d.resDescription),
    // Both dates resolve through DATE_SOURCES so a portal rename is reported
    // instead of silently degrading to a date-only (local midnight) value.
    pickupAt: resolveDateField('pickupAt', d, row, timeZone, externalRef, onDateFallback),
    pickupLocation: detVal(d.resPickupLocation) ?? (locPickup != null ? String(locPickup).trim() : null),
    dropoffAt: resolveDateField('dropoffAt', d, row, timeZone, externalRef, onDateFallback),
    dropoffLocation: detVal(d.resDropOffLocation) ?? (locDropOff != null ? String(locDropOff).trim() : null),
    // d.RateTotal and d.Currency are CONFIRMED ABSENT from the portal payload
    // (0 of 4,661 rows). Both are dead branches, but resRateTotal/resCurrency
    // are present on every row, so the resolved values are correct today.
    totalAmount: toDecimalString(detVal(d.resRateTotal) ?? detVal(d.RateTotal) ?? rate),
    currency: detVal(d.Currency) ?? detVal(d.resCurrency) ?? 'USD',
    // Economy's detail carries a real prepaid boolean (e.g. PRICELINE prepays).
    isPrepaid: typeof d.isPrepaid === 'boolean' ? d.isPrepaid : null,
    rawJson: detail ? { list: row, detail } : { list: row },
  };
}

/**
 * The job handler. Exported for direct invocation from tests + a bootstrap CLI.
 *
 * Job payload: { tenantId, triggeredBy }. The worker pulls the near-term list
 * ONCE, then processes each row through the area filter.
 */
export async function economySyncHandler(job) {
  const { tenantId, triggeredBy = 'schedule' } = job?.data || {};
  if (!tenantId) throw new Error('economy.sync: job.data.tenantId is required');

  const userAgent = pickUserAgent();
  logger.info('[economy-sync] starting run', { tenantId, triggeredBy });

  // Load the tenant's enabled area configs ONCE. We keep the per-area window
  // overrides (lookbackDays / lookaheadDays, nullable → env fallback) so the
  // fetch can use the UNION window and each row its area's precision window.
  const configs = await prisma.economyLocationConfig.findMany({
    where: { tenantId, enabled: true },
    select: {
      externalArea: true,
      locationId: true,
      lookbackDays: true,
      lookaheadDays: true,
    },
  });
  // area (UPPER) → { locationId, lookbackDays, lookaheadDays }
  const areaConfig = new Map(
    configs.map((c) => [
      String(c.externalArea).trim().toUpperCase(),
      { locationId: c.locationId, lookbackDays: c.lookbackDays, lookaheadDays: c.lookaheadDays },
    ])
  );
  const areaToLocation = new Map(
    Array.from(areaConfig.entries()).map(([area, cfg]) => [area, cfg.locationId])
  );

  const startedAt = new Date();
  const runRow = await prisma.externalSyncRun.create({
    data: {
      tenantId,
      sourceSystem: SOURCE_SYSTEM,
      status: 'OK',
      notes: `Triggered by: ${triggeredBy}`,
    },
  });

  let pickupsFound = 0;
  let newlyInserted = 0;
  let updatedExisting = 0;
  let autoPromoted = 0;
  let needsReview = 0;
  let errorsCount = 0;
  let droppedByArea = 0;
  let droppedByAreaWindow = 0;
  let skippedCrossTenant = 0;
  let finalStatus = 'OK';
  const errorSamples = [];

  // Date-source drift tracking. Aggregated per RUN (not per reservation) so a
  // portal-wide rename produces a handful of actionable lines instead of one
  // per row — chatty warnings get muted, and a muted warning is no warning.
  const dateFallbacks = new Map(); // `${field}:${source}` → entry
  const noteDateFallback = ({ field, source, degraded, externalRef }) => {
    const key = `${field}:${source ?? '(none)'}`;
    let entry = dateFallbacks.get(key);
    if (!entry) {
      entry = { field, source: source ?? null, degraded, count: 0, sampleRefs: [] };
      dateFallbacks.set(key, entry);
    }
    entry.count++;
    entry.degraded = entry.degraded || degraded;
    if (externalRef && entry.sampleRefs.length < 5) entry.sampleRefs.push(externalRef);
  };

  try {
    if (areaToLocation.size === 0) {
      logger.info('[economy-sync] no enabled areas for tenant — nothing to sync', { tenantId });
    }

    // UNION date window for the single list call: one credential + one fetch
    // covers every enabled area, so we fetch the WIDEST [lookback, lookahead]
    // across all enabled configs (env-fallback per null). Each area's OWN window
    // is then applied as a per-row precision filter below (never sweep the ~92k).
    const now = Date.now();
    const { dateFrom, dateTo } = unionWindowBounds(configs, now);

    const rows = areaToLocation.size === 0
      ? []
      : await fetchReservationList(tenantId, { dateFrom, dateTo, userAgent });

    // ---- LOCATION FILTER (+ per-area date precision) -----------------------
    // Keep a row ONLY IF (a) its area has an enabled config AND (b) its pickup
    // falls inside THAT area's own [lookback, lookahead] window — not merely the
    // broader union window used for the fetch. A MIA row that is inside the
    // union (because LAX has a wider window) but outside MIA's own window is
    // dropped by area precision.
    const kept = [];
    for (const row of rows) {
      const rawLoc = Array.isArray(row) ? row[LIST_INDEX.rgLocPickup] : row.rgLocPickup;
      const area = areaFromLocPickup(rawLoc);
      const cfg = area ? areaConfig.get(area) : null;
      if (!cfg) {
        droppedByArea++;
        continue;
      }
      // Per-area precision window (env fallback per null override).
      const { dateFrom: areaFrom, dateTo: areaTo } = windowBoundsForConfig(cfg, now);
      const rawPickup = Array.isArray(row) ? row[LIST_INDEX.rgDatePickup] : row.rgDatePickup;
      const pickupMs = parseRezDate(rawPickup);
      if (pickupMs == null
        || pickupMs < areaFrom.getTime()
        || pickupMs > areaTo.getTime()) {
        droppedByAreaWindow++;
        continue;
      }
      kept.push({ row, area, locationId: cfg.locationId });
    }
    pickupsFound = kept.length;
    logger.info('[economy-sync] list filtered by area + per-area window', {
      tenantId, runId: runRow.id, fetched: rows.length, kept: kept.length,
      droppedByArea, droppedByAreaWindow,
    });

    // Pre-fetch existing rows for these refs. NOTE: the ExternalReservation
    // unique is (sourceSystem, externalRef) WITHOUT tenantId, so we query by
    // sourceSystem+externalRef only (NOT scoped to this tenant) — that lets us
    // both (a) count new vs updated and (b) detect a cross-tenant collision
    // (S1): a row that already belongs to a DIFFERENT tenant must NOT be
    // flipped by this tenant's sync.
    const refs = kept.map((k) => String(pickColRef(k.row))).filter(Boolean);
    const existingRows = refs.length
      ? await prisma.externalReservation.findMany({
        where: { sourceSystem: SOURCE_SYSTEM, externalRef: { in: refs } },
        select: { externalRef: true, tenantId: true },
      })
      : [];
    // externalRef → owning tenantId (unique per (sourceSystem, externalRef)).
    const existingByRef = new Map(existingRows.map((r) => [r.externalRef, r.tenantId]));
    const knownSet = new Set(
      existingRows.filter((r) => r.tenantId === tenantId).map((r) => r.externalRef)
    );

    for (const { row, area, locationId } of kept) {
      const externalRef = String(pickColRef(row) || '').trim();
      if (!externalRef) { errorsCount++; errorSamples.push('row missing rgConfirmation'); continue; }
      try {
        // ---- S1: cross-tenant guard --------------------------------------
        // The (sourceSystem, externalRef) unique has no tenantId, so a row can
        // only ever belong to one tenant. If a row with this ref already exists
        // under a DIFFERENT tenant, DO NOT upsert (that would flip the other
        // tenant's row) — skip + WARN. (Reuses the pre-query above; no extra DB
        // round-trip.)
        const ownerTenantId = existingByRef.get(externalRef);
        if (ownerTenantId && ownerTenantId !== tenantId) {
          skippedCrossTenant++;
          logger.warn('[economy-sync] cross-tenant ExternalReservation collision — row skipped', {
            tenantId, externalRef, ownerTenantId, runId: runRow.id,
          });
          continue;
        }

        const wasKnown = knownSet.has(externalRef);
        const timeZone = timeZoneForArea(area);

        // Detail enrichment: pickup/dropoff TIME, phone, email, flight (null
        // on a per-row failure — the list row alone still stages the import).
        const detail = await fetchReservationDetail(tenantId, externalRef, { userAgent });
        const mapped = mapRowToExternalReservation(row, {
          detail, timeZone, onDateFallback: noteDateFallback,
        });

        const upserted = await prisma.externalReservation.upsert({
          where: { source_ref_unique: { sourceSystem: SOURCE_SYSTEM, externalRef } },
          create: { ...mapped, tenantId, sourceSystem: SOURCE_SYSTEM },
          update: { ...mapped, lastSyncedAt: new Date(), syncRunCount: { increment: 1 } },
        });

        if (wasKnown) updatedExisting++; else newlyInserted++;

        // Idempotent: skip if already promoted in a prior run.
        if (upserted.promotionStatus === 'AUTO_PROMOTED' || upserted.promotionStatus === 'PROMOTED') {
          continue;
        }

        // ---- S2: EconomyLocationConfig is authoritative for location ------
        // evaluatePromotion is SHARED with TL and, on its own, returns
        // MANUAL_REVIEW(location_unmapped) when no LocationCodeMap row exists —
        // even though the enabled EconomyLocationConfig ALREADY maps this area →
        // Ride locationId (that's why the row is in `kept`). We pass the config
        // locationId as `overrideLocationId` so the matcher SKIPS its
        // LocationCodeMap gate and proceeds to the customer/ACRISS/currency
        // gates. Net effect: location_unmapped can NEVER be the blocking reason
        // for Economy, but if ANY OTHER gate fails (customer_not_found,
        // acriss_unmapped, currency_non_usd, multiple_matches) the row still
        // goes to MANUAL_REVIEW. overrideLocationId defaults to undefined for
        // TL callers, so TL behavior is byte-identical.
        const promoOpts = { prisma, overrideLocationId: locationId };
        let decision = await evaluatePromotion(upserted, promoOpts);

        if (decision.decision === 'MANUAL_REVIEW'
          && decision.reason === REVIEW_REASONS.CUSTOMER_NOT_FOUND
          && autoCreateCustomersEnabled()) {
          try {
            const newCust = await maybeCreateCustomerFromEconomy(prisma, upserted);
            if (newCust) decision = await evaluatePromotion(upserted, promoOpts);
          } catch (createErr) {
            logger.warn('[economy-sync] auto-create customer failed; MANUAL_REVIEW', {
              tenantId, externalRef, message: createErr.message,
            });
          }
        }

        if (decision.decision === 'AUTO') {
          try {
            // Prefer the config-mapped locationId over the promotion matcher's
            // LocationCodeMap resolution — the EconomyLocationConfig is the
            // authoritative "which Ride location" for this area.
            await promoteAutomatically(upserted, decision, { locationId, timeZone });
            autoPromoted++;
          } catch (promoErr) {
            errorsCount++;
            errorSamples.push(`${externalRef}: promote failed: ${promoErr.message}`);
            captureBackendException(promoErr, {
              integration: { source: SOURCE_SYSTEM, tenantId, externalRef },
            });
          }
        } else {
          needsReview++;
          await prisma.externalReservation.update({
            where: { id: upserted.id },
            data: { promotionStatus: 'MANUAL_REVIEW', needsReviewReason: decision.reason || null },
          });
        }

        // Politeness sleep between rows guards the per-row DETAIL fetch. With
        // the ECONOMY_DETAIL_ENABLED kill switch off there is no per-row call,
        // so the sleep would only throttle a large first sync for no reason.
        if (DETAIL_ENABLED) {
          await sleep(randomDelay(DETAIL_DELAY_MIN_MS, DETAIL_DELAY_MAX_MS));
        }
      } catch (err) {
        if (err instanceof EconomyAuthExpiredError) throw err;
        errorsCount++;
        errorSamples.push(`${externalRef}: ${err.message}`);
        captureBackendException(err, {
          integration: { source: SOURCE_SYSTEM, tenantId, externalRef },
        });
      }
    }

    if (errorsCount > 0 && (newlyInserted + updatedExisting) > 0) finalStatus = 'PARTIAL';
    if (errorsCount > 0 && (newlyInserted + updatedExisting) === 0) finalStatus = 'FAILED';
  } catch (err) {
    if (err instanceof EconomyAuthExpiredError) {
      finalStatus = 'AUTH_EXPIRED';
      // Drop the dead in-memory cookie jar so the NEXT run performs a fresh
      // login instead of reusing the poisoned session (QA 2026-07-28: without
      // this, one server-side session kill silently zeroed every run for 6h).
      clearSession(tenantId);
      logger.warn('[economy-sync] session expired', { tenantId, runId: runRow.id, message: err.message });
      await prisma.integrationCredential.updateMany({
        where: { tenantId, sourceSystem: SOURCE_SYSTEM },
        data: { lastTestStatus: 'EXPIRED', lastTestedAt: new Date() },
      }).catch(() => {});
      captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId }, level: 'warning' });
    } else {
      finalStatus = 'FAILED';
      logger.error('[economy-sync] fatal error', {
        tenantId, runId: runRow.id, message: err.message, stack: err.stack,
      });
      captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId } });
    }
  }

  // One line per (field, source) pair per run. `timeLost: true` means the value
  // degraded to a date-only source and every affected reservation is now pinned
  // to local midnight — that is the resDropoffFullDate incident, and it should
  // be visible on day one rather than a month later.
  for (const entry of dateFallbacks.values()) {
    logger.warn('[economy-sync] date resolved from a fallback source — portal may have renamed a field', {
      tenantId,
      runId: runRow.id,
      field: entry.field,
      expectedKey: DATE_SOURCES[entry.field].detail[0].key,
      resolvedFrom: entry.source,
      timeLost: entry.degraded,
      count: entry.count,
      sampleRefs: entry.sampleRefs,
    });
  }

  const finishedAt = new Date();
  await prisma.externalSyncRun.update({
    where: { id: runRow.id },
    data: {
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status: finalStatus,
      pickupsFound,
      newlyInserted,
      updatedExisting,
      autoPromoted,
      needsReview,
      errorsCount,
      notes: errorSamples.length ? errorSamples.slice(0, 5).join(' | ') : null,
    },
  });

  return {
    runId: runRow.id,
    status: finalStatus,
    pickupsFound,
    newlyInserted,
    updatedExisting,
    autoPromoted,
    needsReview,
    errorsCount,
    droppedByArea,
    droppedByAreaWindow,
    skippedCrossTenant,
    dateFallbacks: [...dateFallbacks.values()],
  };
}

function pickColRef(row) {
  return Array.isArray(row) ? row[LIST_INDEX.rgConfirmation] : row?.rgConfirmation;
}

/**
 * Build a fresh Reservation from an ExternalReservation + decision, using the
 * config-mapped locationId + per-area timezone. Mirrors TL's promoteAutomatically
 * but the locationId is passed in (from EconomyLocationConfig) rather than read
 * off the promotion decision.
 *
 * Exported so routes (Fase 5, manual promote) can call the same code path.
 */
export async function promoteAutomatically(extRes, decision, opts = {}) {
  if (decision?.decision !== 'AUTO') {
    throw new Error('promoteAutomatically requires decision.decision === "AUTO"');
  }
  return promoteWithMappings(extRes, {
    customerId: decision.mappedCustomer.id,
    locationId: opts.locationId || decision.mappedLocation?.id,
    vehicleCategory: decision.mappedVehicleCategory,
    timeZone: opts.timeZone,
    promotedByUserId: null,
    isAuto: true,
  });
}

/**
 * Lower-level promote path (used by AUTO and by manual promote in routes).
 * MONEY: writes ONLY estimatedTotal — no charge, no card, no autocharge.
 */
export async function promoteWithMappings(extRes, opts) {
  const {
    customerId,
    locationId,
    vehicleCategory = null,
    vehicleTypeId = null,
    timeZone = 'America/New_York',
    promotedByUserId = null,
    isAuto = false,
  } = opts || {};

  if (!customerId) throw new Error('promote: customerId is required');
  if (!locationId) throw new Error('promote: locationId is required');

  return await prisma.$transaction(async (tx) => {
    const fresh = await tx.externalReservation.findUnique({ where: { id: extRes.id } });
    if (!fresh) throw new Error(`ExternalReservation ${extRes.id} not found`);
    if (fresh.promotionStatus === 'AUTO_PROMOTED' || fresh.promotionStatus === 'PROMOTED') {
      if (fresh.promotedToReservationId) {
        const existing = await tx.reservation.findUnique({ where: { id: fresh.promotedToReservationId } });
        if (existing) return { reservation: existing, alreadyPromoted: true };
      }
    }

    let resolvedVehicleTypeId = vehicleTypeId;
    if (!resolvedVehicleTypeId && vehicleCategory) {
      const vt = await tx.vehicleType.findFirst({
        where: { tenantId: fresh.tenantId, code: { equals: vehicleCategory, mode: 'insensitive' } },
        select: { id: true },
      }).catch(() => null);
      resolvedVehicleTypeId = vt?.id || null;
    }

    const pickupAt = fresh.pickupAt || new Date();
    const returnAt = fresh.dropoffAt || new Date(pickupAt.getTime() + 3 * 24 * 60 * 60 * 1000);

    // Duplicate short-circuit — pass the per-area timezone so pickup-day
    // truncation runs against the operator's wall clock, not server UTC.
    const duplicateId = await findDuplicateReservation(tx, fresh, { timeZone }).catch(() => null);
    if (duplicateId) {
      const linkedReservation = await tx.reservation.findUnique({ where: { id: duplicateId } });
      const linkedUpdate = await tx.externalReservation.update({
        where: { id: fresh.id },
        data: {
          promotionStatus: 'PROMOTED',
          promotedToReservationId: duplicateId,
          promotedAt: new Date(),
          promotedByUserId: promotedByUserId || 'system',
          needsReviewReason: null,
        },
      });
      logger.info(`[economy-sync] ${fresh.externalRef}: LINKED to existing Reservation ${duplicateId}`, {
        tenantId: fresh.tenantId, externalRef: fresh.externalRef, reservationId: duplicateId,
      });
      return { reservation: linkedReservation, externalReservation: linkedUpdate, alreadyPromoted: false, linked: true };
    }

    const reservation = await tx.reservation.create({
      data: {
        tenantId: fresh.tenantId,
        reservationNumber: `${RESERVATION_PREFIX}${fresh.externalRef}`,
        sourceRef: fresh.externalRef,
        status: 'CONFIRMED',
        bookingChannel: BOOKING_CHANNEL,
        customerId,
        vehicleTypeId: resolvedVehicleTypeId,
        pickupAt,
        returnAt,
        pickupLocationId: locationId,
        returnLocationId: locationId,
        estimatedTotal: fresh.totalAmount ?? null,
        notes: `Imported from Economy (RezLight) — ${fresh.externalRef}`,
        sendConfirmationEmail: false,
      },
    });

    const updated = await tx.externalReservation.update({
      where: { id: fresh.id },
      data: {
        promotionStatus: isAuto ? 'AUTO_PROMOTED' : 'PROMOTED',
        promotedToReservationId: reservation.id,
        promotedAt: new Date(),
        promotedByUserId,
        needsReviewReason: null,
      },
    });

    return { reservation, externalReservation: updated, alreadyPromoted: false };
  });
}

/**
 * Convenience: enqueue a one-off sync at NORMAL priority (manual "Run now").
 */
export async function enqueueOneOffSync(tenantId, triggeredBy = 'manual') {
  return enqueueJob(QUEUE_NAME, { tenantId, triggeredBy }, {
    jobId: `economy-sync:${tenantId}:${Date.now()}`,
    priority: 5,
  });
}

/**
 * Register the worker with BullMQ. Idempotent — call once at worker boot.
 */
export function registerEconomySyncWorker() {
  registerWorker(QUEUE_NAME, economySyncHandler, {
    concurrency: 1,
    priority: SCRAPER_PRIORITY,
  });
  logger.info('[economy-sync] worker registered', { queue: QUEUE_NAME });
}
