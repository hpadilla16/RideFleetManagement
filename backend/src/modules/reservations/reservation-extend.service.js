import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { reservationPricingService } from './reservation-pricing.service.js';
import { parseDateTimeInTz } from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';
import {
  isSecurityDepositCharge,
  isDepositCharge,
  isTaxCharge,
} from '../../lib/charge-predicates.js';

// =============================================================================
// Reservation Extension Service
// =============================================================================
//
// Unified extend + addendum flow (Bug 6, 2026-04-30). One operation:
//
//   1. Snapshot all current selected charges (originalCharges).
//   2. Set Reservation.originalReturnAt the FIRST time we extend (so the
//      UI can render "Originally returned X · Now returns Y"). Subsequent
//      extensions leave it alone.
//   3. Create the EXTENSION_RATE charge with taxable=true (yes, Hector —
//      the extension rate IS taxed; the previous taxable=false was a
//      bug carried over from the v1 stub).
//   4. Rescale per-day add-on rows so they keep covering the extended
//      rental window. "Per-day add-on" = source in PER_DAY_LIKE_SOURCES
//      (SERVICE / ADDITIONAL_SERVICE / FEE / SERVICE_LINKED_FEE /
//      INSURANCE), regardless of chargeType. For chargeType=UNIT rows
//      we additionally require quantity > 1 (FIXED / PERCENTAGE rows
//      always have quantity=1). The base rental's own row (any
//      DAILY/UNIT row whose source is NOT in that whitelist) is
//      intentionally NOT rescaled — the EXTENSION_RATE charge IS the
//      additive line for the new days, so bumping the base quantity on
//      top would double-count (Bug 8, 2026-05-12: agents reported a
//      2-day rental with a 3-day extension showed Daily 5 × $100 PLUS
//      Extension 3 × $100 = $800 of base rate for what should have
//      been $500).
//
//      Why whitelist instead of blacklist BASE_RATE: real production
//      data has had at least three different source values for the
//      base rental row over time — 'BASE_RATE' (current), 'DAILY'
//      (legacy), and null/empty (very old reservations). Whitelisting
//      what *should* extend is robust to all of those without us
//      enumerating every base-rate label we've ever shipped.
//
//      Codex P1 follow-up on PR #65 originally surfaced this as
//      "stop ignoring chargeType=DAILY entirely so daily-priced
//      AdditionalServices keep extending" — the whitelist achieves
//      both that and the legacy-source robustness in one rule.
//      FIXED and PERCENT charges are not touched — percentage rows
//      naturally re-evaluate against the new subtotal at display
//      time, fixed fees are one-time.
//   5. Recompute the TAX row from the NEW taxable subtotal (which now
//      includes the extension rate and the rescaled DAILY items).
//   6. Update Reservation.returnAt + estimatedTotal.
//   7. Auto-create a RentalAgreementAddendum with:
//        reasonCategory='EXTENSION', extensionChargeId=<the new charge>,
//        originalCharges/newCharges/chargeDelta JSON snapshots,
//        pickupAt = the OLD returnAt (start of extension period),
//        returnAt = the NEW returnAt,
//        signatureToken (24-byte, 14-day TTL, same shape as manual
//          addendum so the existing /api/public/addendum-signature/:token
//          flow Just Works).
//
// Each extension creates its own addendum — multi-extension is allowed
// and produces a chain of independently-signable/voidable addendums.
//
// deleteExtension(reservationId, extensionChargeId) reverts an extension
// IF its addendum is still PENDING_SIGNATURE. Once SIGNED we refuse —
// signed contract is a legal record; the agent must void the addendum
// first (existing voidAddendum) before deleting.
// =============================================================================

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function scopedReservationWhere(id, scope = {}) {
  return { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) };
}

export function rentalDays(pickupAt, returnAt) {
  const start = new Date(pickupAt || Date.now());
  const end = new Date(returnAt || Date.now());
  const diff = end.getTime() - start.getTime();
  return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)) || 1);
}

// 2026-09-04 — isSecurityDepositCharge / isDepositCharge / isTaxCharge moved to
// lib/charge-predicates.js (PURE, no prisma) so the Level 3 line-item builder
// can import the SAME function objects rather than becoming a fourth copy of
// isDepositCharge. Behaviour is byte-identical; re-exported here so every
// existing importer of this module is unaffected.
// See design/mockups/us-terminal-checkout-NOTES.md §5 gap 7.
// NOTE: `export { x } from '...'` re-exports WITHOUT creating a local binding,
// and this module calls isDepositCharge/isTaxCharge internally (see
// listRepriceableRows and isBaseRentalRow below). So they are imported at the
// top of the file and re-exported by name here.
export { isSecurityDepositCharge, isDepositCharge, isTaxCharge };

export function isExtensionCharge(row = {}) {
  return String(row?.code || '').trim().toUpperCase() === 'EXTENSION_RATE';
}

// Sources whose ReservationCharge rows are provisioned per-day by the
// booking engine (chargeType=UNIT, quantity=days, rate=dailyRate — see
// booking-engine.service.js:1822). When the rental window grows, these
// must rescale alongside daily-priced AdditionalServices.
// INSURANCE was added 2026-05-12 per Hector — insurance coverage should
// extend with the rental window the same way per-day services do.
// KIOSK_UPSELL was added 2026-07-05 (kiosk B2 QA): kiosk-sold per-day
// add-ons (chargeType DAILY, quantity=days, rate=dailyRate — see
// kiosk-offers.service.js acceptOffers) must rescale on extension exactly
// like counter-sold SERVICE rows, or the extra days ride uncharged (and a
// coversTolls package would cover days the customer never paid for).
export const PER_DAY_LIKE_SOURCES = new Set([
  'SERVICE',
  'ADDITIONAL_SERVICE',
  'FEE',
  'SERVICE_LINKED_FEE',
  'INSURANCE',
  'KIOSK_UPSELL',
  // QA Major 1 (2026-08-11): a pre-checkout extra is priced FOR THE TRIP
  // (per-day × days flattened to one line). Changing the day count makes that
  // flat price wrong in either direction, silently — so it routes to a human
  // exactly like every other trip-priced add-on. Also closes the identical
  // latent gap for portal-sold services.
  'ADDITIONAL_SERVICE_PRECHECKIN'
]);

// Returns true if this row is a per-day charge whose quantity should
// follow the reservation's total day count when extended. The
// EXTENSION_RATE row, tax rows, and security deposits never rescale.
//
// Bug 8 (2026-05-12): the rental's base rate row is intentionally NOT
// rescaled. The EXTENSION_RATE charge already adds (extensionDays ×
// dailyRate) for the additional days — if we also bumped the base
// rate row from oldTotalDays to newTotalDays, the new days would be
// billed twice.
//
// Identifying the base rate row reliably is harder than expected — we
// have observed three different source values in production data for
// what is functionally the same row:
//   - 'BASE_RATE'  — current booking-engine.service.js:1887
//   - 'DAILY'      — older booking-engine paths / migrated rows
//   - null / ''    — very old reservations from before the source
//                    column was reliably populated
// So instead of trying to enumerate every "base rate" source string,
// we WHITELIST sources that should rescale: SERVICE / ADDITIONAL_SERVICE
// / FEE / SERVICE_LINKED_FEE / INSURANCE. Anything chargeType=DAILY
// whose source is NOT in that whitelist is treated as the base rental
// and left alone. This stays correct as new booking-engine code ships
// new source labels for the base row.
//
// chargeType=UNIT rows follow the same whitelist; an additional check
// requires quantity == oldTotalDays to confirm the row was provisioned
// as `quantity = days × rate = dailyRate`. Rows whose quantity has been
// manually overridden (agent set 1 unit instead of N days) are left
// alone — heuristic fails safely.
function shouldRescaleDailyRow(row = {}, oldTotalDays = 0) {
  if (isExtensionCharge(row)) return false;
  if (isTaxCharge(row)) return false;
  if (isSecurityDepositCharge(row)) return false;
  const chargeType = String(row?.chargeType || '').trim().toUpperCase();
  const source = String(row?.source || '').trim().toUpperCase();
  // Whitelist: only rescale rows we know are per-day add-ons.
  // Every other DAILY / UNIT row is treated as the base rental.
  if (!PER_DAY_LIKE_SOURCES.has(source)) return false;
  if (chargeType === 'DAILY') return true;
  if (chargeType === 'UNIT') {
    const qty = Number(row?.quantity);
    if (!Number.isFinite(qty) || qty <= 1) return false;

    // INSURANCE has a stable invariant from computeInsuranceLine in
    // booking-engine.service.js:
    //   PER_DAY    → quantity = days   (always > 1 on multi-day rentals)
    //   FIXED      → quantity = 1
    //   PERCENTAGE → quantity = 1
    // So an INSURANCE UNIT row with qty > 1 is unambiguously per-day.
    // Safe to rescale even when oldTotalDays has drifted from qty:
    // surfaced on RES-368604 on 2026-05-12 — Insurance was quoted as
    // 2 days, but a returnAt shift made rentalDays() recompute
    // oldTotalDays = ceil(52/24) = 3, so the strict qty===oldTotalDays
    // check refused to rescale. The INSURANCE-specific path here
    // sidesteps that drift without putting other UNIT rows at risk.
    if (source === 'INSURANCE') return true;

    // SERVICE / FEE / etc do NOT have that invariant —
    // computeAdditionalServiceLine stores `quantity` as the user/default
    // unit count (chairs, GPS units, etc.), not as a day count. A FLAT
    // 2-unit child-seat service has qty=2 totally independent of the
    // rental's day count. So we keep the strict qty === oldTotalDays
    // match here to avoid rewriting multi-unit FLAT rows into
    // day-count charges (Codex P1 on PR #67). Per-day toll services
    // provisioned as qty=days × rate=dailyRate still rescale because
    // qty === oldTotalDays holds.
    //
    // Known residual gap: a multi-unit FLAT service whose `quantity`
    // coincidentally equals oldTotalDays (e.g., 2 child seats on a
    // 2-day rental) is still wrongly rescaled. Fully closing this
    // requires looking up the source service's pricingMode at
    // extension time; tracked as a follow-up.
    if (Number.isFinite(oldTotalDays) && qty === Number(oldTotalDays)) return true;
  }
  return false;
}

function snapshotCharge(row = {}) {
  // Trim a charge to just the fields we need to capture in addendum
  // JSON. Decimal columns come back as strings or Decimal objects —
  // normalize to strings so JSON round-trips cleanly.
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    chargeType: row.chargeType,
    quantity: String(row.quantity ?? ''),
    rate: String(row.rate ?? ''),
    total: String(row.total ?? ''),
    taxable: !!row.taxable,
    selected: row.selected !== false,
    sortOrder: row.sortOrder ?? 0,
    source: row.source ?? null,
    sourceRefId: row.sourceRefId ?? null
  };
}

function summarizeChargeTotals(charges = []) {
  const rows = Array.isArray(charges) ? charges : [];
  const subtotal = Number(rows
    .filter((r) => !isTaxCharge(r) && !isDepositCharge(r))
    .reduce((sum, r) => sum + toNumber(r?.total), 0)
    .toFixed(2));
  const taxes = Number(rows
    .filter((r) => isTaxCharge(r))
    .reduce((sum, r) => sum + toNumber(r?.total), 0)
    .toFixed(2));
  const total = Number((subtotal + taxes).toFixed(2));
  return { subtotal, taxes, total };
}

function buildExtensionChargeData({
  reservationId,
  extensionDays,
  extensionDailyRate,
  currentDailyRate,
  sortOrder
}) {
  if (extensionDays <= 0) {
    throw new Error('Extension days must be > 0');
  }
  const overrideProvided = extensionDailyRate !== null && extensionDailyRate !== undefined;
  const rateToUse = overrideProvided ? toNumber(extensionDailyRate) : toNumber(currentDailyRate, 0);
  const total = Number((extensionDays * rateToUse).toFixed(2));

  return {
    reservationId,
    code: 'EXTENSION_RATE',
    name: `Extension (${extensionDays} day${extensionDays !== 1 ? 's' : ''} @ $${rateToUse.toFixed(2)}/day)`,
    chargeType: 'DAILY',
    quantity: extensionDays,
    rate: rateToUse,
    total,
    // Hector 2026-04-30: extension rate IS taxable. The TAX row is
    // recomputed in step 5 of extendReservation against the new
    // taxable subtotal (which now includes this row).
    taxable: true,
    selected: true,
    source: overrideProvided ? 'EXTENSION_OVERRIDE' : 'EXTENSION_DEFAULT',
    sourceRefId: null,
    sortOrder,
    notes: null
  };
}

// Recompute the TAX row(s) for a reservation after charges have changed.
// Mirrors the canonical pattern in customer-portal.routes.js: blow away
// old TAX rows, compute a single new tax line from the taxable subtotal
// using pricingSnapshot.taxRate (falling back to pickup location's
// taxRate). Returns the resulting TAX charge row, or null if there's no
// tax to apply (no taxable charges, or no tax rate available).
// Exported (2026-07-05, kiosk B2 review): the kiosk upsell accept path
// reuses this exact recompute so taxable kiosk add-ons are never sold
// tax-free. Behavior is unchanged for the extension path.
// `client` (2026-08-08): the VozIA reschedule rebuilds the base-rate row and
// this tax row together, and those two writes MUST be one transaction — a
// reservation left with a new Daily line and the OLD tax line is a wrong price
// that every later read will faithfully recompute and keep. Defaults to the
// module prisma so the extension and kiosk callers are byte-identical.
export async function recomputeTaxRow({ reservationId, pricingSnapshot, pickupLocationId }, client = prisma) {
  const remaining = await client.reservationCharge.findMany({
    where: { reservationId, selected: true }
  });

  await client.reservationCharge.deleteMany({
    where: { reservationId, chargeType: 'TAX' }
  });

  const taxableTotal = remaining
    .filter((c) => !isTaxCharge(c) && !!c.taxable)
    .reduce((sum, c) => sum + toNumber(c.total), 0);

  if (taxableTotal <= 0) return null;

  let taxRate = toNumber(pricingSnapshot?.taxRate);
  if (!taxRate && pickupLocationId) {
    const loc = await client.location.findUnique({
      where: { id: pickupLocationId },
      select: { taxRate: true }
    });
    taxRate = toNumber(loc?.taxRate);
  }
  if (taxRate <= 0) return null;

  const taxAmount = Number((taxableTotal * taxRate / 100).toFixed(2));
  return client.reservationCharge.create({
    data: {
      reservationId,
      source: 'TAX_RECALC',
      name: `Sales Tax (${taxRate.toFixed(2)}%)`,
      chargeType: 'TAX',
      quantity: 1,
      rate: taxAmount,
      total: taxAmount,
      taxable: false,
      selected: true,
      sortOrder: 999
    }
  });
}

async function getReservationOrThrow(reservationId, scope = {}) {
  const row = await prisma.reservation.findFirst({
    where: scopedReservationWhere(reservationId, scope),
    include: {
      pricingSnapshot: true,
      rentalAgreement: { select: { id: true, status: true, tenantId: true } },
      charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
    }
  });
  if (!row) throw new Error('Reservation not found');
  return row;
}


/**
 * Refusals that MUST happen before the dates are committed.
 *
 * The reprice runs after reservationsService.update (which owns the real gates
 * — operating hours, vehicle conflict, agreement-immutable), so by the time it
 * discovers an unsupported shape the move has already landed. The route calls
 * this FIRST so a refusal leaves the reservation untouched instead of moved
 * with a price nobody could compute.
 */

/**
 * Is this THE base rental row?
 *
 * POSITIVE identification, deliberately. The first version of the reprice
 * classified by exclusion — anything that was not tax/deposit/extension/a known
 * per-day add-on was "the base rate". That predicate is safe in
 * shouldRescaleDailyRow, where a false positive only means "don't rescale". Here
 * the consequence is deleteMany, so the same logic is fail-DESTRUCTIVE: it would
 * have deleted ADDITIONAL_SERVICE_PRECHECKIN rows (add-ons a customer already
 * bought online, which nothing recreates), WEBSITE_FEE, ISSUE_CENTER claims, and
 * would have un-voided an admin's waived MANDATORY_FEE.
 *
 * The shapes are the three prod has, and this mirrors long-term.service.js's
 * predicate, which has run in production:
 *   'BASE_RATE' — current booking-engine
 *   'DAILY'     — older paths / migrated rows
 *   null / ''   — very old rows, identified by code or name instead
 */
export function isBaseRentalRow(row = {}) {
  if (isTaxCharge(row) || isDepositCharge(row) || isExtensionCharge(row)) return false;
  const source = String(row?.source || '').trim().toUpperCase();
  const code = String(row?.code || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  if (source === 'BASE_RATE' || source === 'DAILY') return true;
  if (!source && (code === 'DAILY' || name === 'DAILY')) return true;
  return false;
}

export function assertRepriceable(charges = [], oldDays = 0, newDays = 0, bookingChannel = null, workflowMode = null) {
  const rows = Array.isArray(charges) ? charges : [];

  // WORKFLOW MODE FIRST. A dealership courtesy loaner is created through the
  // ordinary reservation path — CONFIRMED, no bookingChannel (so it defaults to
  // STAFF), dailyRate 0, estimatedTotal 0, and NO charge rows — because the
  // dealer covers it. Every other guard here passes it, and repricing it
  // creates a retail BASE_RATE row and bills a customer for a car they were
  // lent for free.
  //
  // This is a REGRESSION RISK CREATED BY THIS CHANGE, not a pre-existing bug:
  // the old code only stamped the reservation columns, and the very defect
  // being fixed (a pricing read recomputing from the charge rows) dragged a
  // loaner back toward 0 on the next read. Rebuilding the charge rows makes the
  // retail price the durable, self-reinforcing truth instead.
  const mode = String(workflowMode || 'RENTAL').trim().toUpperCase();
  if (mode !== 'RENTAL') {
    const err = new Error(
      'This booking is not a standard rental (it is a courtesy loaner or car-sharing trip) and is not priced at counter rates. A human in RideFleet has to change its dates — for a loaner, the return date moves via the dealership-loaner extend flow, which has no price side-effects.'
    );
    err.code = 'UNSUPPORTED_WORKFLOW_MODE';
    err.status = 409;
    throw err;
  }

  // BOOKING CHANNEL FIRST — this is the guard that matters most, and label
  // predicates cannot replace it.
  //
  // Measured on prod 2026-08-08: of 6,375 pre-pickup reservations, 6,353 have
  // NO charge rows at all — MIGRATION (2,856) and the FRANCHISE_* brokers
  // (3,497). Those carry a broker NET or prepaid total written straight onto
  // estimatedTotal (promote.js: "writes ONLY estimatedTotal"). Repricing one
  // deletes nothing, creates a RETAIL base row, and replaces the broker's
  // number with counter pricing — on the overwhelming majority of everything
  // this tool can reach.
  //
  // CAR_SHARING is the mirror failure: its base row is source
  // 'CAR_SHARING_TRIP' (4 live rows right now), which no base-rate label
  // predicate recognises, so the delete misses it and a second, retail base
  // row is added ON TOP — billed twice, with every downstream guard reporting
  // success because the count only ever sees the row we created.
  //
  // An ALLOWLIST is the only shape that fails closed on the NEXT integration
  // channel instead of silently repricing it.
  const channel = String(bookingChannel || '').trim().toUpperCase();
  // VOZIA is on the list deliberately: quote-convert stamps it
  // (quotes.service.js), and those reservations are priced by the SAME engine
  // through the SAME preview() as STAFF — so repricing them is exactly as
  // safe, and refusing them would mean Chloe cannot change a booking she made
  // herself ten minutes earlier.
  if (channel && !['WEBSITE', 'STAFF', 'VOZIA'].includes(channel)) {
    const err = new Error(
      'This reservation came from a partner or import channel and is not priced at counter rates. Changing its dates here would replace the agreed price. A human has to make this change.'
    );
    err.code = 'UNSUPPORTED_BOOKING_CHANNEL';
    err.status = 409;
    throw err;
  }

  // A monthly plan's base row is a MONTHLY_CYCLE; stacking a daily line on it
  // would bill both. An OTA prepaid booking has had its base row deleted on
  // purpose (customer-portal third-party flow) and left a voucher marker —
  // recreating a full-price Daily line would re-bill a prepaid rental.
  const blocked = rows.find((c) => {
    const source = String(c?.source || '').trim().toUpperCase();
    return source === 'MONTHLY_CYCLE' || source === 'OTA_PREPAID_VOUCHER';
  });
  if (blocked) {
    const err = new Error(
      'This reservation is priced on a plan this tool cannot reprice (monthly cycle or prepaid third-party voucher). A human has to make this change.'
    );
    err.code = 'UNSUPPORTED_PRICING_PLAN';
    err.status = 409;
    throw err;
  }

  // Per-day add-ons (insurance, prepaid tolls, per-day services) carry their
  // own day count. If the LENGTH changes they all have to be rescaled, and
  // getting that subtly wrong underbills the add-on while the customer is
  // quoted a total that includes it. extendReservation solves it properly with
  // shouldRescaleDailyRow; until this path reuses that, fail CLOSED on money.
  // An admin who VOIDED the base rate (selected:false, kept for history by
  // Admin Corrections) waived the rental. getReservationOrThrow returns voided
  // rows, so they match isBaseRentalRow, would be deleted by id, and come back
  // as a fresh billable row — silently un-waiving it, with the like-for-like
  // guard agreeing because it compares the NEW row to the quote. Refused HERE
  // rather than mid-reprice so it costs the caller nothing, which is the
  // invariant the rest of this change is built on.
  const voidedBase = rows.find((c) => isBaseRentalRow(c) && c?.selected === false);
  if (voidedBase) {
    const err = new Error(
      'The rental charge on this reservation was voided by an administrator. Repricing it would make it billable again. A human has to change its dates.'
    );
    err.code = 'VOIDED_BASE_RATE';
    err.status = 409;
    throw err;
  }

  // A length change we cannot anchor is the case we understand LEAST, so it
  // must not be the case where the guard is disabled. oldDays===0 means no
  // recognisable base row.
  if (!oldDays && newDays) {
    const anyPerDay = rows.find(
      (c) => c?.selected !== false && PER_DAY_LIKE_SOURCES.has(String(c?.source || '').trim().toUpperCase())
    );
    if (anyPerDay) {
      const err = new Error(
        'This reservation has per-day add-ons but no base rate this tool can identify. A human has to reprice it.'
      );
      err.code = 'PER_DAY_ADDONS_PRESENT';
      err.status = 409;
      throw err;
    }
  }
  if (oldDays && newDays && oldDays !== newDays) {
    const perDayAddOn = rows.find(
      (c) => c?.selected !== false && PER_DAY_LIKE_SOURCES.has(String(c?.source || '').trim().toUpperCase())
    );
    if (perDayAddOn) {
      const err = new Error(
        'Changing the length of this rental would also change its per-day add-ons (insurance, prepaid tolls or services). A human has to reprice it.'
      );
      err.code = 'PER_DAY_ADDONS_PRESENT';
      err.status = 409;
      throw err;
    }
  }
}

/**
 * "Already there" is not a change (2026-08-10: VozIA fired rescheduleReservation
 * 3x on one live call). True when the REQUESTED window and pickup location match
 * what the reservation already holds — the caller's reschedule then no-ops with
 * `alreadyApplied` instead of rebuilding identical charge rows, and instead of
 * 409ing REPRICE_DRIFT for a state that is already true (which tells the agent
 * the change FAILED, whose measured response is retrying the write).
 *
 * Compared through the preview's OWN parse of the requested strings (tenant
 * wall-clock), never string equality — "T14:00" and "T14:00:00" are the same
 * instant and the voice model emits both spellings for one spoken request.
 * Missing preview echoes fail OPEN to the normal path: worst case is the
 * pre-existing behavior, never a skipped legitimate change.
 */
export function isSameRentalWindow(previewOut = {}, current = {}, requestedPickupLocationId = null) {
  if (!previewOut?.pickupAt || !previewOut?.returnAt) return false;
  if (!current?.pickupAt || !current?.returnAt) return false;
  const p1 = new Date(previewOut.pickupAt).getTime();
  const r1 = new Date(previewOut.returnAt).getTime();
  const p2 = new Date(current.pickupAt).getTime();
  const r2 = new Date(current.returnAt).getTime();
  if (!Number.isFinite(p1) || !Number.isFinite(r1) || !Number.isFinite(p2) || !Number.isFinite(r2)) return false;
  if (p1 !== p2 || r1 !== r2) return false;
  const loc = requestedPickupLocationId || current.pickupLocationId;
  return loc === current.pickupLocationId;
}

export const reservationExtendService = {
  /**
   * Reprice a reservation whose DATES just moved (VozIA reschedule).
   *
   * Lives in the EXTEND service, not the pricing service: this module already
   * owns "reprice because the dates changed" (extendReservation), already has
   * the charge classifiers and recomputeTaxRow, and already imports the pricing
   * service. Putting it in reservation-pricing.service.js would have created an
   * import CYCLE — and PER_DAY_LIKE_SOURCES is a module-level const, so in a
   * cycle it can evaluate to undefined and every predicate below silently
   * inverts. It belonged in a route handler even less: that version could not
   * be tested against a real charge set.
   *
   * THE BUG THIS EXISTS FOR (measured on RES-107160, twice):
   * `Reservation.estimatedTotal` has two writers — the reschedule, which
   * stamped the quote engine's number, and syncMandatoryLocationFees, which
   * recomputes it from the ReservationCharge rows and runs inside getPricing,
   * a READ. Moving dates without rebuilding those rows left them on the old
   * daily rate, so the next pricing read silently reverted the price the
   * customer had just agreed to. Nothing errored.
   *
   * The fix is not "write the number harder" — it is to make the charge rows
   * correct and then let the CANONICAL read produce the total, so the number
   * we report is by construction the one the system will keep.
   */
  async repriceForNewDates(reservationId, engineRow = {}, scope = {}) {
    const current = await getReservationOrThrow(reservationId, scope);
    const charges = Array.isArray(current.charges) ? current.charges : [];
    // NOT rentalDays(current...): by the time this runs the dates have already
    // been committed, so that count is the NEW duration and the guard could
    // never fire. And a plain ceil disagrees with the engine's count on
    // locations with a grace period or rates with a minimum charge, which would
    // refuse ordinary pure-shift requests. The quantity the reservation was
    // actually billed for is the honest baseline.
    const bad = !Number.isFinite(Number(engineRow.subtotal)) || Number(engineRow.subtotal) <= 0
      || !Number.isFinite(Number(engineRow.dailyRate)) || !(Number(engineRow.days) > 0);
    if (bad) {
      const err = new Error('The quote for the new dates is incomplete, so the price cannot be rebuilt.');
      err.code = 'INVALID_QUOTE_ROW';
      err.status = 422;
      throw err;
    }

    const billedBaseRow = charges.find(isBaseRentalRow);
    const billedDays = billedBaseRow ? Number(billedBaseRow.quantity) || 0 : 0;
    assertRepriceable(charges, billedDays, Number(engineRow.days) || 0, current.bookingChannel, current.workflowMode);

    await prisma.$transaction(async (tx) => {
      // Selected in JS and deleted BY ID, because a Prisma negated string
      // filter never matches NULL and prod really does have base rows with a
      // null source (the beta.297 duplicate-charge incident). Which rows count
      // as the base rental is isBaseRentalRow's business — see the rationale
      // there for why it identifies positively instead of by exclusion.
      const baseIds = charges.filter(isBaseRentalRow).map((c) => c.id);
      if (baseIds.length) {
        await tx.reservationCharge.deleteMany({ where: { reservationId: current.id, id: { in: baseIds } } });
      }

      // Same shape the current public booking path writes, so every
      // downstream predicate (code-based, source-based, reports) sees it as
      // the base rate: booking-engine.service.js.
      await tx.reservationCharge.create({
        data: {
          reservationId: current.id,
          code: 'DAILY',
          name: 'Daily',
          chargeType: 'UNIT',
          // The ENGINE's own numbers. `total` is `subtotal`, NOT days × rate:
          // rates.service derives dailyRate as baseTotal/days rounded, so with
          // per-date overrides the product disagrees with the quote by cents.
          quantity: Number(engineRow.days) || 0,
          rate: engineRow.dailyRate,
          total: engineRow.subtotal,
          taxable: true,
          selected: true,
          sortOrder: 0,
          source: 'BASE_RATE'
        }
      });

      const pricingSnapshot = await tx.reservationPricingSnapshot.findUnique({
        where: { reservationId: current.id }
      });
      await recomputeTaxRow(
        { reservationId: current.id, pricingSnapshot, pickupLocationId: current.pickupLocationId },
        tx
      );

      // The SNAPSHOT rate too, not just Reservation.dailyRate. The snapshot
      // takes precedence for percentage mandatory fees, for a later extension's
      // price, and for the customer portal display — leaving it stale prices
      // the next extension at the OLD rate. replacePricing already does this.
      if (pricingSnapshot) {
        await tx.reservationPricingSnapshot.update({
          where: { reservationId: current.id },
          data: { dailyRate: engineRow.dailyRate }
        });
      }
      await tx.reservation.update({
        where: { id: current.id },
        data: { dailyRate: engineRow.dailyRate }
      });
    });

    // THE FIXED POINT. getPricing is the canonical read: it re-syncs mandatory
    // fees (re-pricing PER_DAY and PERCENTAGE ones against the new window),
    // tolls and the agreement, and writes estimatedTotal through
    // summarizeChargeTotals — the one formula, which excludes deposits. Ending
    // here means the number we report IS what the system will hold, instead of
    // a number a later read gets to overrule.
    const priced = await reservationPricingService.getPricing(reservationId, scope);
    // COUNT them, don't just find ours. A base row we failed to recognise would
    // survive the delete and be billed alongside the new one — and a guard that
    // only inspects the row it just created cannot see that. This is the
    // duplication M2 was about; the like-for-like total check does not cover it.
    const baseRows = (priced.charges || []).filter(isBaseRentalRow);
    if (baseRows.length > 1) {
      const err = new Error(
        `Repricing left ${baseRows.length} base-rate rows on this reservation, which would double-bill the rental. A human has to fix it before it is quoted.`
      );
      err.code = 'DUPLICATE_BASE_RATE';
      throw err;
    }
    const baseRow = baseRows[0] || null;
    return {
      total: priced.totals.total,
      subtotal: priced.totals.subtotal,
      taxes: priced.totals.taxes,
      dailyRate: Number(engineRow.dailyRate),
      baseTotal: baseRow ? Number(baseRow.total) : null
    };
  },

  async extendReservation({
    reservationId,
    newReturnAt,
    extensionDailyRate,
    note,
    actorUserId,
    actorRole,
    tenantScope
  }) {
    // 1. Validate inputs
    if (!newReturnAt) {
      throw new Error('New return date is required');
    }
    // The extend dialog submits the raw <input type="datetime-local"> value —
    // a naive "2026-08-07T19:00" with no timezone. `new Date()` reads a naive
    // string as the SERVER's local time, and the container runs in UTC, so
    // 7:00 PM was stored as 19:00Z and rendered back to San Juan as 3:00 PM.
    // Staff typed an evening return, saved, and watched it jump backwards
    // (Hector, 2026-08-07). create() and update() in reservations.service.js
    // were fixed for exactly this; the extension path was missed.
    //
    // parseDateTimeInTz passes strings that already carry a Z or an offset
    // straight through, so explicit-TZ callers (VozIA) are unaffected.
    const tenantTz = await resolveTenantTimeZone(tenantScope?.tenantId);
    const nextReturnDate = parseDateTimeInTz(newReturnAt, tenantTz);
    if (!nextReturnDate || Number.isNaN(nextReturnDate.getTime())) {
      throw new Error('newReturnAt is invalid');
    }

    // 2. Load reservation (with agreement + charges)
    const current = await getReservationOrThrow(reservationId, tenantScope);

    const currentReturnDate = new Date(current.returnAt);
    if (nextReturnDate <= currentReturnDate) {
      throw new Error('New return date must be after the current return date');
    }

    const reservationStatus = String(current.status || '').toUpperCase();
    const disallowedStates = ['CANCELLED', 'CHECKED_IN'];
    if (disallowedStates.includes(reservationStatus)) {
      throw new Error(`Cannot extend a reservation with status ${current.status}`);
    }

    // 3. Validate extensionDailyRate (Codex bot finding from PR #30:
    //    toNumber('abc') silently returns 0. Use Number() + finite check
    //    so we reject malformed payloads instead of treating them as
    //    free extensions.)
    let validatedExtensionDailyRate = null;
    if (extensionDailyRate !== null && extensionDailyRate !== undefined && extensionDailyRate !== '') {
      const rate = Number(extensionDailyRate);
      if (!Number.isFinite(rate)) {
        throw new Error('extensionDailyRate must be a valid number');
      }
      if (rate < 0) {
        throw new Error('extensionDailyRate cannot be negative');
      }
      validatedExtensionDailyRate = rate;
    }

    // 4. Snapshot pre-extension charges for the addendum's audit trail
    const originalChargesSnapshot = (current.charges || []).map(snapshotCharge);

    // 5. Compute extension days + old/new total days (for rescale)
    const extensionDays = rentalDays(current.returnAt, nextReturnDate);
    const newTotalDays = rentalDays(current.pickupAt, nextReturnDate);
    const oldTotalDays = rentalDays(current.pickupAt, current.returnAt);

    // 6. Set originalReturnAt on FIRST extension only. Use the
    //    persisted column as source of truth so we never overwrite it
    //    on extensions 2..N.
    const originalReturnAtForFirstExt = current.originalReturnAt
      ? null
      : currentReturnDate;

    // 7. Update Reservation.returnAt (and originalReturnAt if first ext)
    await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        returnAt: nextReturnDate,
        ...(originalReturnAtForFirstExt
          ? { originalReturnAt: originalReturnAtForFirstExt }
          : {})
      }
    });

    // 7b. Mirror returnAt onto the RentalAgreement so downstream consumers
    //     that read agreement.returnAt (notably checkin-close.service.js
    //     for LATE_RETURN dueBackAt) see the extended date. Without this
    //     the late-fee engine kept billing against the pre-extension
    //     returnAt — RES-623949 was billed $650 for "26 hours late" even
    //     though the customer returned on time vs. the extended dueBack
    //     (2026-05-27 bug). The two-table mirror is required because the
    //     agreement keeps its own copy of returnAt (schema.prisma:1263).
    if (current.rentalAgreement?.id) {
      await prisma.rentalAgreement.update({
        where: { id: current.rentalAgreement.id },
        data: { returnAt: nextReturnDate }
      });
    }

    // 8. Rescale per-day rows to the new total day count so tolls /
    //    per-day services / daily AdditionalServices keep covering the
    //    rental window after the extension. The BASE_RATE row
    //    (source='BASE_RATE') is the ONLY DAILY row deliberately left
    //    alone — the EXTENSION_RATE charge is the only base-rate
    //    line that grows (Bug 8, 2026-05-12). EXTENSION_RATE / TAX /
    //    security deposit are also skipped (see shouldRescaleDailyRow
    //    above).
    for (const row of current.charges || []) {
      if (!shouldRescaleDailyRow(row, oldTotalDays)) continue;
      const newQuantity = newTotalDays;
      const newTotal = Number((newQuantity * toNumber(row.rate)).toFixed(2));
      await prisma.reservationCharge.update({
        where: { id: row.id },
        data: { quantity: newQuantity, total: newTotal }
      });
    }

    // 9. Create the new EXTENSION_RATE charge (always taxable=true)
    const maxSortOrder = (current.charges || [])
      .reduce((m, r) => Math.max(m, Number.isInteger(r.sortOrder) ? r.sortOrder : 0), 0);
    const extensionChargeData = buildExtensionChargeData({
      reservationId,
      extensionDays,
      extensionDailyRate: validatedExtensionDailyRate,
      currentDailyRate: toNumber(current.pricingSnapshot?.dailyRate, toNumber(current.dailyRate)),
      sortOrder: maxSortOrder + 1
    });
    const extensionCharge = await prisma.reservationCharge.create({
      data: extensionChargeData
    });

    // 10. Recompute TAX row from the new taxable subtotal (which now
    //     includes the extension rate + the rescaled DAILY items).
    await recomputeTaxRow({
      reservationId,
      pricingSnapshot: current.pricingSnapshot,
      pickupLocationId: current.pickupLocationId
    });

    // 10b. MONEY-FIX (2026-07-12): mirror the new EXTENSION_RATE row + the
    //      rebuilt TAX row onto the binding RentalAgreement via the canonical
    //      reconciler, so RentalAgreement.subtotal/taxes/total/balance (what
    //      the customer actually owes) pick up the extension's rate AND its
    //      tax. Steps 7-10 above only wrote the RESERVATION side; without this
    //      call the extension charge + its tax never reached the agreement
    //      total/balance. Mirrors the kiosk upsell flow (kiosk-offers.service.js
    //      recomputeTaxRow → getPricing → syncAgreementCharges) and every other
    //      money mutation (addManualCharge/void). { allowClosed: true } so a
    //      late-return / post-checkout extension on a CLOSED agreement also
    //      reconciles. Called AFTER the ReservationCharge writes above commit
    //      (this function runs no $transaction) so syncAgreementCharges — which
    //      re-mirrors from the reservation's selected charges — sees them.
    //      syncAgreementCharges no-ops when the reservation has no agreement.
    await reservationPricingService.syncAgreementCharges(
      reservationId,
      tenantScope || {},
      { allowClosed: true }
    );

    // 11. Recompute estimatedTotal across all selected charges
    const finalCharges = await prisma.reservationCharge.findMany({
      where: { reservationId, selected: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    const newChargesSnapshot = finalCharges.map(snapshotCharge);
    const { total: newEstimatedTotal } = summarizeChargeTotals(finalCharges);
    await prisma.reservation.update({
      where: { id: reservationId },
      data: { estimatedTotal: newEstimatedTotal }
    });

    // 12. Auto-create RentalAgreementAddendum (only if the reservation
    //     has an agreement — extending a pre-checkout reservation skips
    //     the addendum since there's nothing signed to amend yet).
    let addendum = null;
    if (current.rentalAgreement?.id) {
      const chargeDelta = {
        previousReturnAt: currentReturnDate.toISOString(),
        newReturnAt: nextReturnDate.toISOString(),
        extensionDays,
        extensionChargeId: extensionCharge.id,
        extensionDailyRate: toNumber(extensionChargeData.rate),
        extensionTotal: toNumber(extensionChargeData.total),
        previousEstimatedTotal: toNumber(current.estimatedTotal),
        newEstimatedTotal,
        rescaledDailyChargeIds: (current.charges || [])
          // Codex bot P2 on PR #36: passing shouldRescaleDailyRow bare to
          // .filter makes Array.filter pass (item, index, array), so
          // index would be treated as oldTotalDays. Wrap to thread the
          // real oldTotalDays through — otherwise this metadata silently
          // misses per-day UNIT rows for Bug 7a scenarios.
          .filter((r) => shouldRescaleDailyRow(r, oldTotalDays))
          .map((r) => r.id)
      };

      // Same 24-byte / 14-day TTL signature token as the manual
      // createAddendum flow in rental-agreements.service.js, so the
      // existing /api/public/addendum-signature/:token consumer Just
      // Works for these auto-created ones too.
      const signatureToken = crypto.randomBytes(24).toString('base64url');
      const signatureTokenExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

      addendum = await prisma.rentalAgreementAddendum.create({
        data: {
          rentalAgreementId: current.rentalAgreement.id,
          tenantId: current.tenantId || current.rentalAgreement.tenantId || tenantScope?.tenantId || null,
          // pickupAt = start of extension period (the OLD returnAt),
          // returnAt = new returnAt. This lets deleteExtension recover
          // the previous returnAt directly from the addendum row.
          pickupAt: currentReturnDate,
          returnAt: nextReturnDate,
          reason: String(note || '').trim() || `Reservation extended to ${nextReturnDate.toISOString()}`,
          reasonCategory: 'EXTENSION',
          initiatedBy: actorUserId || null,
          // Mirror manual createAddendum's pattern (rental-agreements.service.js):
          // capture the actor's actual role for an accurate audit trail. Sentry
          // bot finding on PR #34 — was hardcoded 'ADMIN' which broke audit
          // accuracy when an AGENT or OPS user did the extension.
          initiatedByRole: String(actorRole || 'ADMIN').trim().toUpperCase(),
          status: 'PENDING_SIGNATURE',
          signatureToken,
          signatureTokenExpiresAt,
          originalCharges: JSON.stringify(originalChargesSnapshot),
          newCharges: JSON.stringify(newChargesSnapshot),
          chargeDelta: JSON.stringify(chargeDelta),
          extensionChargeId: extensionCharge.id
        }
      });
    }

    // 13. Audit log
    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || tenantScope?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: actorUserId || null,
        metadata: JSON.stringify({
          reservationExtended: true,
          previousReturnAt: current.returnAt,
          nextReturnAt: nextReturnDate,
          extensionDays,
          newTotalDays,
          extensionDailyRate: validatedExtensionDailyRate,
          extensionChargeId: extensionCharge.id,
          addendumId: addendum?.id || null,
          firstExtensionForReservation: !!originalReturnAtForFirstExt,
          note: String(note || '').trim() || null
        })
      }
    });

    // 14. Return updated reservation snapshot
    const final = await prisma.reservation.findFirst({
      where: { id: reservationId },
      include: {
        pricingSnapshot: true,
        charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      }
    });

    return {
      reservation: final,
      extensionCharge,
      extensionDays,
      newTotalDays,
      addendum
    };
  },

  // ---------------------------------------------------------------------------
  // deleteExtension: revert a single extension cleanly. Only the LATEST
  // extension can be removed (LIFO) — if the agent needs to undo an older
  // one, they delete extensions in reverse order to keep state consistent.
  //
  // Refuses if the linked addendum is SIGNED. Signed contracts are legal
  // records; the agent must voidAddendum() (existing) first.
  // ---------------------------------------------------------------------------
  async deleteExtension({ reservationId, extensionChargeId, actorUserId, tenantScope }) {
    if (!reservationId) throw new Error('reservationId is required');
    if (!extensionChargeId) throw new Error('extensionChargeId is required');

    const reservation = await getReservationOrThrow(reservationId, tenantScope);

    const extensionCharge = (reservation.charges || []).find(
      (c) => c.id === extensionChargeId && isExtensionCharge(c)
    );
    if (!extensionCharge) {
      throw new Error('Extension charge not found on this reservation');
    }

    // LIFO ordering: the charge being deleted must be the most-recently
    // created EXTENSION_RATE row. Otherwise we'd leave the chain in a
    // weird state (later extensions referencing days that the deleted
    // one set up).
    //
    // Order by sortOrder DESC (deterministic — extendReservation always
    // assigns ext.sortOrder = max(prior charges) + 1), with createdAt
    // DESC as a defensive tiebreaker for any legacy rows that may share
    // a sortOrder.
    const allExtensions = (reservation.charges || [])
      .filter(isExtensionCharge)
      .sort((a, b) => {
        const so = Number(b.sortOrder ?? 0) - Number(a.sortOrder ?? 0);
        if (so !== 0) return so;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    if (allExtensions[0]?.id !== extensionChargeId) {
      throw new Error('Only the most recent extension can be deleted. Delete newer extensions first.');
    }

    // Find the linked addendum (if any) and gate on its status.
    const addendum = await prisma.rentalAgreementAddendum.findFirst({
      where: { extensionChargeId }
    });
    if (addendum && String(addendum.status || '').toUpperCase() === 'SIGNED') {
      throw new Error('Cannot delete extension: the addendum has been signed. Void the addendum first.');
    }

    // Recover the previous returnAt from the addendum's pickupAt
    // (we deliberately stored it there). If there's no addendum (extension
    // pre-dates an agreement, edge case), fall back to chained logic:
    //   - if this is the only extension → use originalReturnAt
    //   - else → use the prior extension's createdAt window (best effort
    //     via the audit log; for now we just refuse and ask Hector to
    //     restore via the agreement workflow).
    let previousReturnAt = null;
    if (addendum?.pickupAt) {
      previousReturnAt = new Date(addendum.pickupAt);
    } else if (allExtensions.length === 1 && reservation.originalReturnAt) {
      previousReturnAt = new Date(reservation.originalReturnAt);
    } else {
      throw new Error('Cannot recover previous return date for this extension (no addendum trail).');
    }

    // Revert per-day charges from the addendum's originalCharges
    // snapshot. Each row in the snapshot was captured PRE-extension; we
    // reset its quantity/total to those values. Only rows that were
    // rescale-eligible at extension time get touched — extension rows,
    // tax, security deposit are skipped. Rows that no longer exist
    // (agent deleted an addon between extension and revert) are skipped.
    //
    // Bug 7a: this snapshot now includes rescaled UNIT rows (per-day
    // SERVICE/FEE), not just chargeType=DAILY. Restoring snap.quantity
    // is idempotent for rows that weren't rescaled, so the simplest
    // safe rule is to revert anything that's not extension/tax/deposit.
    if (addendum?.originalCharges) {
      let snapshot = [];
      try { snapshot = JSON.parse(addendum.originalCharges); } catch { snapshot = []; }
      for (const snap of snapshot) {
        if (!snap?.id) continue;
        if (isExtensionCharge(snap)) continue;
        if (isTaxCharge(snap)) continue;
        if (isSecurityDepositCharge(snap)) continue;
        const live = await prisma.reservationCharge.findUnique({ where: { id: snap.id } });
        if (!live) continue;
        await prisma.reservationCharge.update({
          where: { id: snap.id },
          data: {
            quantity: toNumber(snap.quantity, 1),
            total: toNumber(snap.total, 0)
          }
        });
      }
    }

    // Delete the EXTENSION_RATE charge itself.
    await prisma.reservationCharge.delete({ where: { id: extensionChargeId } });

    // Recompute taxes against the now-smaller taxable subtotal.
    await recomputeTaxRow({
      reservationId,
      pricingSnapshot: reservation.pricingSnapshot,
      pickupLocationId: reservation.pickupLocationId
    });

    // MONEY-FIX (2026-07-12): removing an extension must ALSO reconcile the
    // agreement — the reverted per-day rows, the deleted EXTENSION_RATE line,
    // and the rebuilt TAX row have to come back off RentalAgreement.subtotal/
    // taxes/total/balance. Same canonical reconciler as extendReservation, run
    // AFTER the ReservationCharge delete + tax recompute above commit so it
    // re-mirrors the now-smaller selected charge set. { allowClosed: true }
    // mirrors the extend path for CLOSED-agreement reversals.
    await reservationPricingService.syncAgreementCharges(
      reservationId,
      tenantScope || {},
      { allowClosed: true }
    );

    // Set returnAt back to its pre-extension value. If this was the last
    // remaining extension, ALSO clear originalReturnAt so the UI stops
    // rendering "Originally returned X · Now returns Y".
    const wasLastExtension = allExtensions.length === 1;
    await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        returnAt: previousReturnAt,
        ...(wasLastExtension ? { originalReturnAt: null } : {})
      }
    });

    // Mirror the revert onto the RentalAgreement (counterpart to step 7b
    // in createExtension). Keeps agreement.returnAt and reservation.returnAt
    // in sync so the late-fee engine reads the correct dueBackAt.
    if (reservation.rentalAgreement?.id) {
      await prisma.rentalAgreement.update({
        where: { id: reservation.rentalAgreement.id },
        data: { returnAt: previousReturnAt }
      });
    }

    // Recompute estimatedTotal.
    const finalCharges = await prisma.reservationCharge.findMany({
      where: { reservationId, selected: true }
    });
    const { total: newEstimatedTotal } = summarizeChargeTotals(finalCharges);
    await prisma.reservation.update({
      where: { id: reservationId },
      data: { estimatedTotal: newEstimatedTotal }
    });

    // Void the addendum (if any) — keeps the historical record but
    // marks it as no-longer-applicable.
    if (addendum) {
      await prisma.rentalAgreementAddendum.update({
        where: { id: addendum.id },
        data: { status: 'VOID' }
      });
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId: reservation.tenantId || tenantScope?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: actorUserId || null,
        metadata: JSON.stringify({
          reservationExtensionDeleted: true,
          extensionChargeId,
          revertedReturnAt: previousReturnAt,
          previousReturnAt: reservation.returnAt,
          wasLastExtension,
          addendumId: addendum?.id || null,
          newEstimatedTotal
        })
      }
    });

    const final = await prisma.reservation.findFirst({
      where: { id: reservationId },
      include: {
        pricingSnapshot: true,
        charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      }
    });

    return {
      reservation: final,
      revertedReturnAt: previousReturnAt,
      wasLastExtension,
      voidedAddendumId: addendum?.id || null
    };
  }
};
