/**
 * Mex (TSD RezCentral) sync worker — one BullMQ job per tenant that pulls
 * the near-term `*Estimated T&M Summary` for EACH enabled (TSD account, branch)
 * config, enriches it with the `Email Address Report`, stages the rows into
 * ExternalReservation, and (when possible) auto-promotes them.
 *
 * Thin over the shared booking-source pieces:
 *   - createPromoter(mexSourceSpec)  → promote / link (MONEY: estimatedTotal only)
 *   - maybeCreateCustomerFromSource        → opt-in auto-create (flag-gated)
 *   - evaluatePromotion + findDuplicateReservation (booking-source services)
 *
 * MULTI-CONFIG (Flexways' shape, keyed by two columns): a tenant maps N
 * (tsdNumber, branch) pairs → N Ride locations via MexLocationConfig. Each
 * enabled config is fetched on its own date window and its rows are pinned to
 * that config's locationId via overrideLocationId (the matcher's LocationCodeMap
 * gate is skipped, exactly like NU/Economy/Flexways).
 *
 * TWO FETCHES PER CONFIG, NO DETAIL FETCH: the T&M grid carries the ACRISS class
 * inline, so unlike Flexways there is no per-reservation detail page to hammer.
 * The only second request is the Email Address Report, joined by Confirm — one
 * extra request per config, not per row. Email coverage is ~50% BY DESIGN.
 *
 * CANCELLED / NO-SHOW rows: the T&M feed carries dead bookings (231 of 552 in
 * the recon MTD). They are staged honestly and marked REJECTED
 * (rejectedReason source_cancelled / source_no_show) so they can NEVER be
 * promoted and never pollute the review tray (which lists PENDING +
 * MANUAL_REVIEW). A row that was ALREADY promoted and later turns cancelled at
 * the source is NOT auto-cancelled here — the worker leaves the live Reservation
 * alone (cancelling a live rental is a money/ops decision, not a scraper's) and
 * surfaces it as the `cancelledAfterPromote` run counter + a run note, so the
 * inaction is visible instead of buried in a log. See the plan's Fase 5
 * follow-ups.
 *
 * MONEY: writes ONLY estimatedTotal on the Reservation (from `Total Bill`). No
 * charge, no card, no autocharge — same posture as TL/Economy/NU/Flexways.
 * Prepaid is RATE-CODE driven since 2026-08-05 (see mex.constants.js);
 * unknown codes keep the Pay-on-Arrival posture.
 *
 * See doc/mex-integration-plan-2026-07-13.md
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { captureBackendException } from '../../../lib/sentry.js';
import { registerWorker, enqueueJob } from '../../../lib/queue/index.js';
import { SCRAPER_PRIORITY } from '../../../lib/queue/priorities.js';
import {
  fetchTMSummary,
  fetchEmailReport,
  fetchReservationDetail,
  joinEmailsByConfirm,
  pickUserAgent,
  MexAuthExpiredError,
  MexLayoutError,
} from './mex.service.js';
import {
  formatDetailBreakdown,
  buildImportedQuoteRows,
  effectiveDailyRate,
  quoteReconciliation,
  MEX_CHARGE_SOURCE,
} from './mex-reservation-detail.js';
import { resolveTaxRate } from '../../../lib/tax-rate.js';
import { isBookedPriceRemainder } from '../../../lib/charge-identity.js';
import {
  classifyMexRateCode,
  SOURCE_SYSTEM,
  BOOKING_CHANNEL,
  QUEUE_NAME,
  RESERVATION_PREFIX,
  STATUS,
  TIME_ZONE,
  windowBoundsForConfig,
} from './mex.constants.js';
import { createPromoter } from '../booking-source/promote.js';
import {
  maybeCreateCustomerFromSource,
  autoCreateEnabledFromEnv,
  CUSTOMER_PHONE_PLACEHOLDER,
} from '../booking-source/customer-autocreate.js';
import { evaluatePromotion, REVIEW_REASONS } from '../booking-source/promotion-matcher.service.js';

export { QUEUE_NAME };

// Rejection reasons for source-dead rows (stored on ExternalReservation.rejectedReason).
export const REJECT_REASONS = Object.freeze({
  SOURCE_CANCELLED: 'source_cancelled',
  SOURCE_NO_SHOW: 'source_no_show',
});

// ---------------------------------------------------------------------------
// The sourceSpec for the shared promoter. Prepaid is per-rate-code since
// 2026-08-05 (Hector's list): OTA rows promote with isPrepaid=true and a
// "(prepaid — SOURCE CODE)" notes suffix so the counter knows NOT to collect
// the rate; unknown codes keep "(pay-at-destination)". This NEVER changes the
// money posture: the promoter still writes estimatedTotal and nothing else.
// ---------------------------------------------------------------------------
const mexSourceSpec = Object.freeze({
  reservationPrefix: RESERVATION_PREFIX,
  bookingChannel: BOOKING_CHANNEL,
  sourceLabel: 'Mex',
  logPrefix: '[mex-sync]',
  defaultTimeZone: TIME_ZONE,
  buildReservationExtras: (fresh) => {
    const cls = fresh?.rawJson?.rateClassification || null;
    const detail = fresh?.rawJson?.detail || null;
    const suffix = fresh.isPrepaid === true
      ? ` (prepaid${cls?.product === 'INCLUSIVO' ? ' inclusivo' : ''}${cls?.source ? ` — ${cls.source}` : ''}${cls?.rateCode ? ` ${cls.rateCode}` : ''})`
      : fresh.isPrepaid === false ? ' (pay-at-destination)' : '';
    const lines = [`Imported from Mex — ${fresh.externalRef}` + suffix];
    // The breakdown goes ON the reservation because a pay-at-destination
    // booking is collected at the counter, and the agent needs to see what MEX
    // quoted the customer without opening the portal.
    const breakdown = formatDetailBreakdown(detail);
    if (breakdown) lines.push(breakdown);
    // An agency mailbox is recorded but NOT used as the customer's identity —
    // say so, so nobody thinks the contact is missing.
    if (detail?.email && detail.emailLooksPersonal === false) {
      lines.push(`Booking contact (agency, not the renter): ${detail.email}`);
    }
    // The portal states the payment terms in words. When that disagrees with
    // the rate-code map, SAY SO rather than silently trusting one.
    if (detail?.paymentSignal && cls) {
      const signalPrepaid = detail.paymentSignal === 'PREPAID';
      if (typeof cls.isPrepaid === 'boolean' && cls.isPrepaid !== signalPrepaid) {
        lines.push(
          `⚠ Payment mismatch: rate code ${cls.rateCode || '?'} says `
          + `${cls.isPrepaid ? 'prepaid' : 'pay-at-destination'}, MEX's own note says `
          + `${detail.paymentSignal.replace('_', ' ').toLowerCase()} — verify before collecting.`
        );
      }
    }
    // The daily rate the counter quotes from. Without it the reservation shows
    // a total with nothing behind it (Hector, 2026-08-05).
    const dailyRate = effectiveDailyRate(detail, { days: fresh?.rawJson?.days ?? fresh?.rawJson?.list?.days ?? null });
    return {
      isPrepaid: typeof fresh.isPrepaid === 'boolean' ? fresh.isPrepaid : null,
      ...(dailyRate ? { dailyRate } : {}),
      notes: lines.join('\n'),
    };
  },
});

const { promoteAutomatically, promoteWithMappings } = createPromoter(mexSourceSpec);
export { promoteAutomatically, promoteWithMappings };

function autoCreateCustomersEnabled() {
  return autoCreateEnabledFromEnv('MEX_AUTO_CREATE_CUSTOMERS');
}

/** Is this row live (promotable) at the source? */
export function isPromotableStatus(status) {
  return status === STATUS.CONFIRMED;
}

/** Map a dead row's status → the rejectedReason we stamp. */
export function rejectReasonForStatus(status) {
  if (status === STATUS.NO_SHOW) return REJECT_REASONS.SOURCE_NO_SHOW;
  return REJECT_REASONS.SOURCE_CANCELLED;
}

// ---------------------------------------------------------------------------
// Field mapper — normalized T&M row (already email-joined) → ExternalReservation
// shape. Pure. Exported for tests. The row's dates are already UTC Dates.
// ---------------------------------------------------------------------------

/**
 * NO-EMAIL HANDLING — Hector's decision (A), 2026-07-14. ~50% of Mex rows
 * carry no email. We import them anyway, WITHOUT inventing an address:
 *
 *   customerEmail = null  +  customerPhone = null   (on the STAGED row)
 *
 * A shared fake email is off the table: maybeCreateCustomerFromSource dedupes BY
 * EMAIL, so hundreds of distinct people would collapse into one customer record
 * (rentals, agreements and PII merged), and any real third-party domain would
 * receive their confirmations.
 *
 * The staged phone stays NULL, and CUSTOMER_PHONE_PLACEHOLDER is injected ONLY
 * where it belongs: into the auto-create call (see customerForCreate below).
 *
 * WHY the placeholder must NOT live on the staged row (Innovation, 2026-07-16):
 * the shared matcher's phone path looks up candidates by phone and then accepts
 * any whose name scores Jaro-Winkler >= 0.85. It re-checks EXACT normalized phone
 * equality per candidate, so it can never match a DIFFERENT number — but a staged
 * '0000000000' is exactly equal to the whole placeholder POOL (every Flexways row
 * auto-created 2026-07-14 sits on it), leaving the fuzzy NAME gate as the only
 * thing between this booking and a stranger's record: MARIO GARCIA promotes onto
 * MARIA GARCIA. That is the exact merge decision (A) exists to prevent. With
 * phone=null the phone path never runs at all, and a no-email row with no email
 * match lands honestly on customer_not_found.
 *
 * The shared matcher ALSO now refuses an all-zeros phone outright
 * (isPlaceholderPhone) — that is the durable, all-sources fix. Keeping the staged
 * row's phone null is the belt to its braces: Mex never had a phone to
 * stage in the first place.
 *
 * This is done HERE, in Mex's mapping. The shared helper is NOT changed, so
 * economy/nu/flexways behavior is untouched.
 */
/**
 * Put the booking's quote on the reservation, idempotently: the rental line,
 * MEX's per-day fees, and the tax OUR engine computes over them.
 *
 * Runs after promotion (the row must have a reservation to hang them on).
 * Every row is matched by a stable identity so a re-sync UPDATES instead of
 * stacking a duplicate — the same discipline the toll charge sync uses.
 */
function quoteRowKey(row) {
  const source = String(row?.source || '').toUpperCase();
  const code = String(row?.code || '').toUpperCase();
  if (String(row?.chargeType || '').toUpperCase() === 'TAX' || source === 'TAX' || code === 'TAX') return 'TAX';
  // The rental line has been written under several identities over time
  // (source BASE_RATE, source DAILY, code DAILY). They are all the same line —
  // matching on only one of them left a stale $0.00 "Daily" beside the real one
  // on MEX-WMX000F971.
  if (code === 'DAILY' || source === 'BASE_RATE' || source === 'DAILY') return 'DAILY';
  const ref = String(row?.sourceRefId || '').trim();
  return ref ? `FEE:${ref}` : null;
}

export async function syncImportedFeeCharges(db, reservationId, detail, { days = null } = {}) {
  if (!reservationId || !detail) return { created: 0, updated: 0, removed: 0 };

  // The tax is ours to compute, so we need the rate that applies at pickup.
  //
  // WHY THE SNAPSHOT AND NOT JUST THE LOCATION. A fresh AUTO promotion writes no
  // ReservationPricingSnapshot (promote.js promoteWithMappings), so on that path
  // this resolves to the location exactly as before. The reachable case is the
  // DUPLICATE-LINK path: findDuplicateReservation matches on tenant + customer
  // name + pickup day with no channel filter, so a MEX row can link to a
  // reservation some other flow already created — and be handed straight to this
  // sync. That reservation CAN carry a snapshot, including the deliberate 0 that
  // car-sharing.service.js:253 writes for a tax-exempt trip. Rebuilding the TAX
  // row from the location there invents tax the customer never agreed to.
  //
  // A resolved 0 and the old `|| null` mean the same thing downstream:
  // buildTaxRow() returns null for any pct <= 0, i.e. no TAX row is written.
  const reservation = await db.reservation.findUnique({
    where: { id: reservationId },
    select: {
      dailyRate: true,
      pricingSnapshot: { select: { taxRate: true } },
      pickupLocation: { select: { taxRate: true } },
    },
  });
  const taxRate = resolveTaxRate({
    snapshotRate: reservation?.pricingSnapshot?.taxRate,
    locationRate: reservation?.pickupLocation?.taxRate,
  });

  const wanted = buildImportedQuoteRows(detail, { days, taxRate });
  if (!wanted.length) return { created: 0, updated: 0, removed: 0 };

  const existing = await db.reservationCharge.findMany({
    where: {
      reservationId,
      OR: [
        { source: MEX_CHARGE_SOURCE },
        { code: 'DAILY' }, { source: 'BASE_RATE' }, { source: 'DAILY' },
        { chargeType: 'TAX' }, { source: 'TAX' },
      ],
    },
    select: { id: true, code: true, chargeType: true, source: true, sourceRefId: true, total: true, quantity: true, taxable: true },
    orderBy: { createdAt: 'asc' },
  });
  // At most one row per identity. A second row sharing a key is a duplicate of
  // the same line and is dropped below.
  const byKey = new Map();
  const superseded = [];
  for (const row of existing) {
    const key = quoteRowKey(row);
    if (!key) continue;
    if (byKey.has(key)) superseded.push(row.id);
    else byKey.set(key, row);
  }

  let created = 0;
  let updated = 0;
  const keep = new Set();
  for (const row of wanted) {
    const key = quoteRowKey(row);
    keep.add(key);
    const hit = byKey.get(key);
    if (!hit) {
      await db.reservationCharge.create({ data: { reservationId, ...row } });
      created += 1;
      continue;
    }
    const same = Number(hit.total) === Number(row.total)
      && Number(hit.quantity) === Number(row.quantity)
      && !!hit.taxable === !!row.taxable;
    if (!same) {
      await db.reservationCharge.update({
        where: { id: hit.id },
        data: { name: row.name, quantity: row.quantity, rate: row.rate, total: row.total, taxable: row.taxable },
      });
      updated += 1;
    }
  }

  // Rows this sync owns that the current quote no longer wants — notably the
  // imported tax and the MEX-owned rental line it wrote before the engine took
  // the tax over (2026-08-05). Leaving them behind double-bills.
  //
  // isBookedPriceRemainder EXCLUDES the QUOTE_TAXES_FEES row: it is chargeType
  // TAX, so quoteRowKey buckets it as 'TAX', but it carries fees rather than
  // tax and sweeping it at a resolved rate of 0 loses real money. Only the
  // REMOVAL path consults it — matching it for update-in-place is pre-existing
  // behaviour and deliberately left alone. See lib/charge-identity.js.
  //
  // THE ENGINE'S TAX ROW COUNTS AS OURS. This sync already claims the TAX
  // identity to UPDATE it in place (it is in the `existing` query above and
  // buildTaxRow writes code/source TAX), so leaving it behind when the quote
  // wants no tax row was an asymmetry, not a policy: a reservation over-taxed
  // before the snapshot rate was honoured would keep its stale row through
  // every later sync. Stopping the overcharge has to also undo it.
  const removeIds = [...new Set([
    ...superseded,
    ...existing
      .filter((row) => String(row.source || '').toUpperCase() === MEX_CHARGE_SOURCE
        || String(row.code || '').toUpperCase() === 'IMPORTED_TAX'
        || (quoteRowKey(row) === 'TAX' && !isBookedPriceRemainder(row)))
      .filter((row) => !keep.has(quoteRowKey(row)))
      .map((row) => row.id),
  ])];
  if (removeIds.length) {
    await db.reservationCharge.deleteMany({ where: { id: { in: removeIds } } });
  }

  // The daily rate the counter quotes from, so any later rebuild reproduces the
  // same rental line instead of a $0.00 one.
  const daily = wanted.find((r) => String(r.code).toUpperCase() === 'DAILY')?.rate ?? null;
  if (daily && Number(reservation?.dailyRate) !== Number(daily)) {
    await db.reservation.update({ where: { id: reservationId }, data: { dailyRate: daily } });
  }

  return { created, updated, removed: removeIds.length };
}

// One HTTP round-trip per reservation. A normal sync window is tens of rows;
// this ceiling exists so a pathological window cannot turn one sync into
// thousands of portal hits.
const DETAIL_FETCH_LIMIT = Number(process.env.MEX_DETAIL_FETCH_LIMIT || 200);

export function mapRowToExternalReservation(row) {
  const r = row && typeof row === 'object' ? row : {};
  const email = (r.customerEmail || '').trim() || null;
  return {
    externalRef: String(r.externalRef || '').trim(),
    // `Source` is the booking channel (AMADEUS / SABRE / WEBLINK / BOOKINGGRO).
    channel: r.source || null,
    subBrand: 'MEX',
    supplierRef: r.pnr || null,
    status: r.status || STATUS.CONFIRMED,
    customerFirstName: r.customerFirstName || null,
    customerLastName: r.customerLastName || null,
    customerEmail: email,
    // From the DETAIL screen since 2026-08-05 (the T&M report itself carries
    // no phone). Still null unless the contact looked like a traveller's —
    // never a shared agency desk line.
    customerPhone: (r.customerPhone || '').trim() || null,
    customerCountry: null,
    flightNumber: null,
    vehicleAcriss: r.acriss || null,          // ACRISS inline from the Class column
    vehicleDescription: r.classRaw || null,
    pickupAt: r.pickupAt instanceof Date ? r.pickupAt : null,
    pickupLocation: r.loc || null,            // "61302.MCO" (config pins the real location)
    dropoffAt: r.dropoffAt instanceof Date ? r.dropoffAt : null,
    dropoffLocation: r.loc || null,
    // MONEY: Total Bill (rate + tax) → estimatedTotal only. Never a charge.
    totalAmount: r.totalBill ?? null,
    currency: 'USD',
    // Per-rate-code since 2026-08-05 (Hector's list from MEX): OTA products
    // arrive PREPAID — Expedia PPEXR/BPPPKM/BPPETM/IDAEXD/IPMEXS/PPEXI,
    // Priceline BPPPA/PPPRB — while BPAPR and everything unknown keeps the
    // historical Pay-on-Arrival posture. The `CD` company id corroborates
    // (00346 Expedia / 00543 Priceline are prepaid transmissions).
    isPrepaid: classifyMexRateCode(r.rateCode, r.cd).isPrepaid,
    rawJson: {
      list: r,
      rateClassification: classifyMexRateCode(r.rateCode, r.cd),
      // The portal's own confirmation detail: contact, the estimate broken into
      // rate/tax/extras, the confirmed per-period rate, and each optional
      // service as a line item. Every number here came FROM MEX — nothing is
      // derived, so nothing can drift from what they will actually bill.
      detail: r.detail || null,
      rateCode: r.rateCode ?? null,
      pnr: r.pnr ?? null,
      cd: r.cd ?? null,
      source: r.source ?? null,
      iata: r.iata ?? null,
      days: r.days ?? null,
      totalRate: r.totalRate ?? null,
      totalTax: r.totalTax ?? null,
      sourceStatus: r.status ?? null,
    },
  };
}

/**
 * The job handler. Exported for direct invocation from tests + a bootstrap CLI.
 * Job payload: { tenantId, triggeredBy } — or { kind: 'rate-push', ... } for
 * the outbound rate writeback, which shares THIS queue on purpose: the sync
 * and the push drive the same single-window TSD account, and two concurrent
 * sessions kick each other's login (measured 2026-08-06 — the first push
 * dry-run collided with the 15-min sync and every screen bounced). One queue,
 * concurrency 1 → they can never overlap.
 */
export async function mexSyncHandler(job) {
  if (job?.data?.kind === 'rate-push') return mexRatePushHandler(job);
  const { tenantId, triggeredBy = 'schedule' } = job?.data || {};
  if (!tenantId) throw new Error('mex.sync: job.data.tenantId is required');

  const userAgent = pickUserAgent();
  logger.info('[mex-sync] starting run', { tenantId, triggeredBy });

  // Enabled (TSD account, branch) configs for this tenant. orderBy createdAt asc
  // keeps the sweep deterministic.
  const configs = await prisma.mexLocationConfig.findMany({
    where: { tenantId, enabled: true },
    orderBy: { createdAt: 'asc' },
    select: {
      tsdNumber: true, branch: true, locationId: true, lookbackDays: true, lookaheadDays: true,
    },
  });

  const startedAt = new Date();
  const runRow = await prisma.externalSyncRun.create({
    data: { tenantId, sourceSystem: SOURCE_SYSTEM, status: 'OK', notes: `Triggered by: ${triggeredBy}` },
  });

  let pickupsFound = 0;
  let newlyInserted = 0;
  let updatedExisting = 0;
  let autoPromoted = 0;
  let needsReview = 0;
  let errorsCount = 0;
  let skippedCrossTenant = 0;
  let rejectedCancelled = 0;
  // Rows the source has cancelled/no-showed AFTER we promoted them into a live
  // Reservation. We deliberately do NOT touch the Reservation (see below) — but
  // "we did nothing" must be a NUMBER Hector can see, not just a log line.
  let cancelledAfterPromote = 0;
  let finalStatus = 'OK';
  let layoutError = null;
  const errorSamples = [];
  // Human-readable coverage lines (one per config) for the run notes.
  const coverageNotes = [];
  // Coverage lines that are a PROBLEM, not just information: a range mode that
  // cannot reach the requested window, or rows the server sent that we dropped.
  // These ride at the top of the notes, next to layout drift.
  const rangeGapNotes = [];

  try {
    if (configs.length === 0) {
      logger.info('[mex-sync] no enabled MexLocationConfig for tenant — nothing to sync', { tenantId });
    }

    const now = Date.now();

    for (const config of configs) {
      const targetLocationId = config.locationId;
      if (!targetLocationId) continue;
      const { dateFrom, dateTo } = windowBoundsForConfig(config, now);
      const fetchOpts = {
        tsdNumber: config.tsdNumber, branch: config.branch, from: dateFrom, to: dateTo, userAgent,
      };

      // ---- Fetch 1: the MAIN feed (T&M summary) ----------------------------
      let rows = [];
      try {
        rows = await fetchTMSummary(tenantId, fetchOpts);
      } catch (err) {
        if (err instanceof MexAuthExpiredError) throw err; // fail the whole run
        if (err instanceof MexLayoutError) throw err;      // ATTENTION, not a silent skip
        errorsCount++;
        errorSamples.push(`${config.tsdNumber}.${config.branch}: T&M fetch failed: ${err.message}`);
        captureBackendException(err, {
          integration: { source: SOURCE_SYSTEM, tenantId, tsdNumber: config.tsdNumber, branch: config.branch },
        });
        continue;
      }

      // ---- Fetch 2: emails (enrichment only) -------------------------------
      // ~50% coverage BY DESIGN. A plain transport failure here must NOT lose the
      // whole config — rows without an email still import (they just need a
      // customer match / auto-create), so we degrade instead of aborting.
      //
      // But a degraded email fetch is NEVER silent (Innovation, 2026-07-16). It
      // used to be swallowed into a logger.warn, so a run where 100% of rows lost
      // their email still recorded status OK / errorsCount 0 — which is exactly
      // the input that maximizes no-email rows, i.e. the blast radius of every
      // customer-matching hazard on this feed. Now it COUNTS (→ PARTIAL) and lands
      // in the run notes, where the panel shows it.
      let emailRows = [];
      try {
        emailRows = await fetchEmailReport(tenantId, fetchOpts);
      } catch (err) {
        if (err instanceof MexAuthExpiredError) throw err;
        // An account that never HAD this report is not a drifting layout.
        // Treating it as one failed the whole sync for International Rental
        // Corp while 9 importable reservations sat in the T&M feed
        // (2026-08-05): MEX's SJU account offers 13 Reports POS items and none
        // is the Email Address Report the Advantage clone assumed.
        // Name check, not instanceof: the class may be absent from a stubbed
        // service module, and an instanceof against undefined THROWS inside the
        // catch — turning a graceful skip into a failed run.
        if (err?.name === 'MexReportUnavailableError') {
          logger.info('[mex-sync] portal has no Email Address Report — importing without email enrichment', {
            tenantId, tsdNumber: config.tsdNumber, branch: config.branch,
          });
          emailRows = [];
        } else {
        // Header drift on the email grid is a REAL drift signal, same as the T&M
        // grid's — the report changed shape and the join key may be gone. Let it
        // propagate to the ATTENTION handler rather than quietly importing every
        // row as email-less.
        if (err instanceof MexLayoutError) throw err;
        errorsCount++;
        errorSamples.push(`${config.tsdNumber}.${config.branch}: email report failed (rows imported WITHOUT email enrichment): ${err.message}`);
        logger.warn('[mex-sync] email report failed; continuing without email enrichment', {
          tenantId, tsdNumber: config.tsdNumber, branch: config.branch, message: err.message,
        });
        captureBackendException(err, {
          integration: { source: SOURCE_SYSTEM, tenantId, tsdNumber: config.tsdNumber, branch: config.branch },
          level: 'warning',
        });
        }
      }
      rows = joinEmailsByConfirm(rows, emailRows);

      // Per-reservation detail (2026-08-05). The T&M summary carries no contact
      // and no charge breakdown, so every row imported email-less and sat in
      // MANUAL_REVIEW. One extra fetch per row buys the renter's email/phone
      // AND the full estimate the counter needs for a pay-on-arrival booking.
      // Bounded and fail-soft: a detail we cannot read must never cost us the
      // reservation itself, which imports fine without it.
      let detailsFetched = 0;
      for (const row of rows.slice(0, DETAIL_FETCH_LIMIT)) {
        const ref = String(row?.externalRef || '').trim();
        if (!ref) continue;
        try {
          const detail = await fetchReservationDetail(tenantId, ref);
          if (!detail) continue;
          detailsFetched += 1;
          row.detail = detail;
          // Contact is used for MATCHING only when it identifies a traveller.
          // An OTA desk (reservations@bookinggroup.com) is one address behind
          // every booking that channel ever sends — importing it as identity
          // would collapse the channel into a single customer record.
          if (detail.emailLooksPersonal) {
            row.customerEmail = detail.email || row.customerEmail || null;
            row.customerPhone = detail.homePhone || row.customerPhone || null;
          }
        } catch (err) {
          if (err instanceof MexAuthExpiredError) throw err;
          logger.warn('[mex-sync] reservation detail fetch failed — importing without it', {
            tenantId, externalRef: ref, message: err.message,
          });
        }
      }
      if (rows.length > DETAIL_FETCH_LIMIT) {
        // Never let a cap read as full coverage.
        logger.warn('[mex-sync] detail fetch capped — some rows imported without contact/breakdown', {
          tenantId, rows: rows.length, limit: DETAIL_FETCH_LIMIT,
        });
      }
      logger.info('[mex-sync] reservation details fetched', {
        tenantId, tsdNumber: config.tsdNumber, branch: config.branch,
        details: detailsFetched, rows: rows.length,
      });

      pickupsFound += rows.length;

      // ---- COVERAGE / RECONCILIATION ---------------------------------------
      // The client-side pickup filter guarantees that what we import is CORRECT.
      // It says nothing about what the server never sent. `outOfWindowRows === 0`
      // is NOT proof the server honored our range and is never read as such.
      //
      // Coverage is defended by the MECHANISM (lstRunBy=Date Out sent explicitly +
      // the calendars driven by the day-serial postback the portal implements).
      // These numbers let a human FALSIFY that on any run rather than trust it:
      //   - the footer's own "Rows: N" vs what we parsed → did we drop anything;
      //   - DateOut vs Booked spans → which column the server ranged on (measured
      //     2026-07-17: DateOut hugs the asked range, Booked sprawls 7 months →
      //     ranged on pickup, correct);
      //   - rangeCoverage.uncoveredDays → how much of the asked window the chosen
      //     mode structurally cannot reach ('mtd' → the whole lookahead).
      const d = rows.diagnostics || {};
      logger.info('[mex-sync] config feed fetched', {
        tenantId,
        runId: runRow.id,
        tsdNumber: config.tsdNumber,
        branch: config.branch,
        fetched: rows.length,
        emailsMatched: d.emailsMatched ?? null,
        rangeMode: d.rangeMode ?? null,
        rangePostbacks: d.rangePostbacks ?? null,
        uncoveredDays: d.rangeCoverage?.uncoveredDays ?? null,
        // Raw, PRE-filter: what the server actually handed us.
        serverRows: d.serverRows ?? null,
        footerCount: d.footerCount ?? null,
        unparsedRows: d.unparsedRows ?? null,
        outOfWindowRows: d.outOfWindowRows ?? null,
        requestedFrom: d.requestedFrom ?? null,
        requestedTo: d.requestedTo ?? null,
        serverDateOut: d.serverDateOut ?? null,
        serverBooked: d.serverBooked ?? null,
        targetLocationId,
      });
      const day = (iso) => (iso ? String(iso).slice(0, 10) : '?');
      coverageNotes.push(
        `${config.tsdNumber}.${config.branch}: asked ${day(d.requestedFrom)}→${day(d.requestedTo)} `
        + `[${d.rangeMode ?? '?'}], server sent ${d.serverRows ?? '?'} rows`
        + (d.footerCount != null ? ` (footer says ${d.footerCount})` : '')
        + ` (DateOut ${day(d.serverDateOut?.min)}→${day(d.serverDateOut?.max)}, `
        + `Booked ${day(d.serverBooked?.min)}→${day(d.serverBooked?.max)}), `
        + `${rows.length} in window, ${d.emailsMatched ?? 0} with email`
      );
      // A range mode that cannot reach the asked window under-fetches BY
      // CONSTRUCTION. That must be a headline in the run notes, not a log line:
      // it is precisely the "green run, plausible rows, missing bookings" shape
      // this whole mechanism exists to make impossible.
      if (d.rangeCoverage?.covers === false) {
        rangeGapNotes.push(
          `${config.tsdNumber}.${config.branch}: range mode '${d.rangeMode}' covers only `
          + `${day(d.rangeCoverage.coveredFrom)}→${day(d.rangeCoverage.coveredTo)} of the requested `
          + `${day(d.requestedFrom)}→${day(d.requestedTo)} — ${d.rangeCoverage.uncoveredDays} day(s) `
          + 'of the window are NOT fetched (set MEX_RANGE_MODE=explicit for full coverage)'
        );
      }
      if (d.unparsedRows) {
        rangeGapNotes.push(
          `${config.tsdNumber}.${config.branch}: the grid footer counts ${d.footerCount} rows but `
          + `only ${d.parsedRows} parsed — ${d.unparsedRows} row(s) the server sent were dropped`
        );
      }

      // Pre-fetch existing rows for these refs to count new vs updated AND detect
      // cross-tenant collisions (unique is (sourceSystem, externalRef), no tenantId).
      const refs = rows.map((r) => String(r?.externalRef || '').trim()).filter(Boolean);
      const existingRows = refs.length
        ? await prisma.externalReservation.findMany({
          where: { sourceSystem: SOURCE_SYSTEM, externalRef: { in: refs } },
          select: { externalRef: true, tenantId: true, promotionStatus: true },
        })
        : [];
      const existingByRef = new Map(existingRows.map((r) => [r.externalRef, r.tenantId]));
      const knownSet = new Set(
        existingRows.filter((r) => r.tenantId === tenantId).map((r) => r.externalRef)
      );
      const promotedByRef = new Map(
        existingRows
          .filter((r) => r.tenantId === tenantId
            && (r.promotionStatus === 'AUTO_PROMOTED' || r.promotionStatus === 'PROMOTED'))
          .map((r) => [r.externalRef, r.promotionStatus])
      );

      for (const row of rows) {
        const externalRef = String(row?.externalRef || '').trim();
        if (!externalRef) { errorsCount++; errorSamples.push('row missing Confirm #'); continue; }
        try {
          const ownerTenantId = existingByRef.get(externalRef);
          if (ownerTenantId && ownerTenantId !== tenantId) {
            skippedCrossTenant++;
            logger.warn('[mex-sync] cross-tenant ExternalReservation collision — row skipped', {
              tenantId, externalRef, ownerTenantId, runId: runRow.id,
            });
            continue;
          }

          const wasKnown = knownSet.has(externalRef);
          const alreadyPromoted = promotedByRef.has(externalRef);
          const mapped = mapRowToExternalReservation(row);
          const promotable = isPromotableStatus(row.status);

          // A row that is already a live Reservation and has now gone CANCELLED /
          // NO SHOW at the source: we do NOT touch the Reservation (cancelling a
          // live rental is an ops/money decision). Log loudly so it can be acted
          // on, keep the staged row's status honest, and move on.
          if (alreadyPromoted && !promotable) {
            cancelledAfterPromote++;
            logger.warn('[mex-sync] source says CANCELLED/NO-SHOW but the row is already promoted — live Reservation left untouched (manual review)', {
              tenantId, externalRef, sourceStatus: row.status, runId: runRow.id,
            });
          }

          const upserted = await prisma.externalReservation.upsert({
            where: { source_ref_unique: { sourceSystem: SOURCE_SYSTEM, externalRef } },
            create: { ...mapped, tenantId, sourceSystem: SOURCE_SYSTEM },
            update: { ...mapped, lastSyncedAt: new Date(), syncRunCount: { increment: 1 } },
          });

          if (wasKnown) updatedExisting++; else newlyInserted++;

          // Dead at the source → REJECTED. Never promotable, and kept out of the
          // review tray (which lists PENDING + MANUAL_REVIEW) so ~230 dead rows a
          // month can't bury the real work.
          if (!promotable) {
            const reason = rejectReasonForStatus(row.status);
            const alreadyRejected = upserted.promotionStatus === 'REJECTED'
              && upserted.rejectedReason === reason;
            // Re-read from the upsert (not the pre-fetch map) so a row promoted
            // mid-run is still respected.
            const isLive = upserted.promotionStatus === 'AUTO_PROMOTED'
              || upserted.promotionStatus === 'PROMOTED';
            // Only write when something actually changes: ~230 dead rows a month
            // would otherwise take a pointless UPDATE on every 15-minute sweep.
            if (!isLive && !alreadyRejected) {
              rejectedCancelled++;
              await prisma.externalReservation.update({
                where: { id: upserted.id },
                data: {
                  promotionStatus: 'REJECTED',
                  rejectedReason: reason,
                  rejectedAt: new Date(),
                  needsReviewReason: null,
                },
              });
            }
            continue;
          }

          if (upserted.promotionStatus === 'AUTO_PROMOTED' || upserted.promotionStatus === 'PROMOTED') {
            continue; // idempotent — already promoted
          }

          // The config's mapped locationId is authoritative → overrideLocationId
          // skips the LocationCodeMap gate (location_unmapped can never block);
          // any OTHER gate still routes to MANUAL_REVIEW.
          const promoOpts = { prisma, overrideLocationId: targetLocationId };
          let decision = await evaluatePromotion(upserted, promoOpts);

          if (decision.decision === 'MANUAL_REVIEW'
            && decision.reason === REVIEW_REASONS.CUSTOMER_NOT_FOUND
            && autoCreateCustomersEnabled()) {
            try {
              // The staged row carries NO phone (see mapRowToExternalReservation).
              // Customer.phone is required, so the placeholder is injected HERE,
              // on the way into the create helper only — it never touches the
              // staged row, and so never reaches the matcher as a lookup key.
              const newCust = await maybeCreateCustomerFromSource(prisma, {
                ...upserted,
                customerPhone: upserted.customerPhone || CUSTOMER_PHONE_PLACEHOLDER,
              }, {
                logPrefix: '[mex-sync]', sourceName: 'Mex',
              });
              // Do NOT re-evaluate to re-FIND the customer we just created: with a
              // placeholder phone and no email there is nothing for the matcher to
              // find it by, so it would return customer_not_found again → the row
              // goes to MANUAL_REVIEW → the next sweep re-evaluates it (only
              // AUTO_PROMOTED/PROMOTED are skipped) → it creates ANOTHER customer,
              // ~270 no-email rows × 96 sweeps/day, forever. The customer id we
              // hold IS authoritative; hand it to the re-eval so the remaining
              // gates still run but the customer step is settled.
              if (newCust) {
                decision = await evaluatePromotion(upserted, {
                  ...promoOpts, overrideCustomerId: newCust.id,
                });
              }
            } catch (createErr) {
              logger.warn('[mex-sync] auto-create customer failed; MANUAL_REVIEW', {
                tenantId, externalRef, message: createErr.message,
              });
            }
          }

          if (decision.decision === 'AUTO') {
            try {
              await promoteAutomatically(upserted, decision, {
                locationId: targetLocationId, timeZone: TIME_ZONE,
              });
              autoPromoted++;
              // MEX's own fees follow the booking onto the reservation. Done
              // AFTER promotion (there is no reservation before it) and
              // fail-soft: a fee we could not write is a number to chase, a
              // failed promotion is a reservation nobody can rent against.
              try {
                const promoted = await prisma.externalReservation.findUnique({
                  where: { id: upserted.id }, select: { promotedToReservationId: true },
                });
                if (promoted?.promotedToReservationId) {
                  const feeOut = await syncImportedFeeCharges(prisma, promoted.promotedToReservationId, row.detail, { days: row.days });
                  if (feeOut.created || feeOut.updated) {
                    logger.info('[mex-sync] imported fees written to reservation', {
                      tenantId, externalRef, ...feeOut,
                    });
                  }
                }
              } catch (feeErr) {
                logger.warn('[mex-sync] could not write imported fees', {
                  tenantId, externalRef, message: feeErr.message,
                });
              }
            } catch (promoErr) {
              errorsCount++;
              errorSamples.push(`${externalRef}: promote failed: ${promoErr.message}`);
              captureBackendException(promoErr, { integration: { source: SOURCE_SYSTEM, tenantId, externalRef } });
            }
          } else {
            needsReview++;
            await prisma.externalReservation.update({
              where: { id: upserted.id },
              data: { promotionStatus: 'MANUAL_REVIEW', needsReviewReason: decision.reason || null },
            });
          }
        } catch (err) {
          if (err instanceof MexAuthExpiredError) throw err;
          errorsCount++;
          errorSamples.push(`${externalRef}: ${err.message}`);
          captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId, externalRef } });
        }
      }
    }

    if (errorsCount > 0 && (newlyInserted + updatedExisting) > 0) finalStatus = 'PARTIAL';
    if (errorsCount > 0 && (newlyInserted + updatedExisting) === 0) finalStatus = 'FAILED';
  } catch (err) {
    if (err instanceof MexAuthExpiredError) {
      finalStatus = 'AUTH_EXPIRED';
      logger.warn('[mex-sync] session expired', { tenantId, runId: runRow.id, message: err.message });
      await prisma.integrationCredential.updateMany({
        where: { tenantId, sourceSystem: SOURCE_SYSTEM },
        data: { lastTestStatus: 'EXPIRED', lastTestedAt: new Date() },
      }).catch(() => {});
      captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId }, level: 'warning' });
    } else if (err instanceof MexLayoutError) {
      // The grid rendered but a required column is gone. Record ATTENTION (not a
      // silent OK 0) so the drift is fixed before a shifted mapping can corrupt
      // estimatedTotal or read a cancelled booking as live. Mirrors NU's FIX-A.
      finalStatus = 'ATTENTION';
      layoutError = err.message;
      logger.error('[mex-sync] DataGrid layout drift — refusing to import a shifted mapping', {
        tenantId, runId: runRow.id, message: err.message,
      });
      captureBackendException(err, {
        integration: { source: SOURCE_SYSTEM, tenantId, runId: runRow.id }, level: 'warning',
      });
    } else {
      finalStatus = 'FAILED';
      logger.error('[mex-sync] fatal error', {
        tenantId, runId: runRow.id, message: err.message, stack: err.stack,
      });
      captureBackendException(err, { integration: { source: SOURCE_SYSTEM, tenantId } });
    }
  }

  // Run notes, most-urgent first. Layout drift still wins the headline, but the
  // coverage lines ride along regardless: a green run that silently under-fetches
  // is exactly the failure MC3 is about, and it is only visible in these numbers.
  // `cancelledAfterPromote` is here for the same reason — the worker deliberately
  // does nothing about a live rental the source cancelled (that's an ops/money
  // call, not a scraper's), and "deliberately did nothing" has to be legible or
  // the car just stays blocked on the planner with nobody the wiser.
  const noteParts = [];
  if (layoutError) noteParts.push(`LAYOUT DRIFT: ${layoutError}`);
  if (rangeGapNotes.length) noteParts.push(`⚠️ COVERAGE GAP — ${rangeGapNotes.join(' ; ')}`);
  if (cancelledAfterPromote > 0) {
    noteParts.push(
      `⚠️ ${cancelledAfterPromote} already-promoted reservation(s) are CANCELLED/NO-SHOW at the source `
      + '— the live Reservation was NOT touched; review and cancel manually if correct'
    );
  }
  if (errorSamples.length) noteParts.push(errorSamples.slice(0, 5).join(' | '));
  if (coverageNotes.length) noteParts.push(`Coverage — ${coverageNotes.join(' ; ')}`);
  const notes = noteParts.length ? noteParts.join(' || ') : null;

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
      notes,
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
    skippedCrossTenant,
    rejectedCancelled,
    cancelledAfterPromote,
  };
}

/** Convenience: enqueue a one-off sync (manual "Run now"). */
export async function enqueueOneOffSync(tenantId, triggeredBy = 'manual') {
  return enqueueJob(QUEUE_NAME, { tenantId, triggeredBy }, {
    jobId: `mex-sync:${tenantId}:${Date.now()}`,
    priority: 5,
  });
}

// ---------------------------------------------------------------------------
// Outbound rate push as a queue job (2026-08-06, Hector: "que se haga despues
// del motor de pricing"). Same queue as the sync — see mexSyncHandler.
// ---------------------------------------------------------------------------

/** The rate-push job body. Never force from a schedule: out-of-band deltas
 * stay HELD in RatePushLog for a human, exactly like MI's own cap. */
async function mexRatePushHandler(job) {
  const { tenantId, triggeredBy = 'schedule' } = job?.data || {};
  if (!tenantId) throw new Error('mex.sync rate-push: job.data.tenantId is required');
  const { runMexRatePush } = await import('./mex-rate-push.service.js');
  logger.info('[mex-rate-push] queued run starting', { tenantId, triggeredBy });
  const out = await runMexRatePush(tenantId, { live: true, trigger: 'MI_AUTOAPPLY' });
  logger.info('[mex-rate-push] queued run finished', {
    tenantId,
    mode: out.mode || null,
    skipped: out.skipped || null,
    codes: (out.configs || []).flatMap((c) => c.codes || []).map((c) => ({
      rateCode: c.rateCode,
      error: c.error || null,
      bands: (c.bands || []).length,
    })),
  });
  return out;
}

/** Enqueue one tenant's rate push behind whatever sync is running. */
export async function enqueueRatePush(tenantId, triggeredBy = 'post-pricing-engine') {
  return enqueueJob(QUEUE_NAME, { kind: 'rate-push', tenantId, triggeredBy }, {
    jobId: `mex-rate-push:${tenantId}:${Date.now()}`,
    // Below the manual-sync priority: reservations first, prices after.
    priority: 6,
  });
}

/**
 * Enqueue the push for every tenant that can actually run one: an enabled
 * MexLocationConfig AND the env gate at LIVE. Called by the pricing-engine
 * internal route after a run, best-effort — pricing must never fail because
 * the push could not queue.
 */
export async function enqueueRatePushForEnabledTenants({ tenantId = null } = {}) {
  const { pushMode } = await import('./mex-rate-push.service.js');
  if (pushMode() !== 'LIVE') return { skipped: 'mode_' + pushMode().toLowerCase(), queued: 0 };
  const configs = await prisma.mexLocationConfig.findMany({
    where: { enabled: true, ...(tenantId ? { tenantId } : {}) },
    select: { tenantId: true },
    distinct: ['tenantId'],
  });
  let queued = 0;
  for (const cfg of configs) {
    const jobId = await enqueueRatePush(cfg.tenantId).catch((e) => {
      logger.warn('[mex-rate-push] could not enqueue', { tenantId: cfg.tenantId, message: e.message });
      return null;
    });
    if (jobId) queued += 1;
  }
  return { queued, tenants: configs.length };
}

/** Register the worker with BullMQ. Idempotent — call once at worker boot. */
export function registerMexSyncWorker() {
  registerWorker(QUEUE_NAME, mexSyncHandler, {
    concurrency: 1,
    priority: SCRAPER_PRIORITY,
  });
  logger.info('[mex-sync] worker registered', { queue: QUEUE_NAME });
}
