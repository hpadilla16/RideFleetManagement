/**
 * Level 3 / VISA CEDP line items built from a real rental agreement.
 * PURE — no prisma, no network, no clock beyond an injected date.
 *
 * PHASE 1a of doc/us-terminal-checkout-plan-2026-09-04.md §10:
 *
 *   "Build autorental-l3.builder.js + autorental-validation.js and wire them
 *    into the EXISTING autoRentalL3Data() on the Transact CNP path, replacing
 *    the single synthetic line and the hardcoded zero taxes. Ships real
 *    interchange value, exercises the whole L3 mapping and the §5.3 invariant,
 *    and touches no terminal."
 *
 * What was there before (ipos-transact-client.js:305-344, still the fallback):
 * ONE synthetic line — "Vehicle rental", Quantity 1, UnitOfMeasure 'EA',
 * UnitCost = the whole amount, TaxAmount 0, TaxRate 0, header TaxAmount 0.
 * That is a valid CEDP block that carries no information: Visa gets a receipt
 * saying "one unit of something, no tax", which is worth nothing at
 * interchange. RFM already stores the itemization (RentalAgreementCharge rows
 * are shaped like L3 lines — plan §2.11); it just never sent it.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
 *
 * Plan §5.3, and it is not negotiable:
 *
 *     Amount == Σ ExtLineAmount (non-deposit, non-tax) + TaxAmount
 *
 * If that does not hold to the cent, this builder REFUSES and returns
 * { ok: false, reason }. The caller then sends the old single-line payload and
 * logs why. A payload whose lines disagree with the money is worse than a
 * payload that says nothing: Dejavoo's L3 validator can HARD-FAIL a
 * transaction (l2l3Flag "E" — ipos-transact-client.js:330-341), so a mismatched
 * block risks declining a real customer's card to improve a reporting field.
 * Never make that trade.
 *
 * The refusal is not an edge case. Three of the four live callers cannot
 * satisfy the invariant by construction, and that is CORRECT:
 *   • preAuthDeposit (spin-charge.service.js:991, rental-agreements:5211) —
 *     the amount IS the deposit, and deposits are excluded from L3 by
 *     definition. Σ lines would be 0 against a $250 amount. Always falls back.
 *   • spinChargeCardOnFile (rental-agreements.service.js:4971) — an agent
 *     types an arbitrary amount for tolls/damage/late fees. Only matches the
 *     agreement's charge composition when it happens to be the full balance.
 *   • long-term cycle billing (long-term-billing.scheduler.js:244) — one
 *     month of a multi-month plan, not the whole agreement.
 *
 * So this builder is written to be refused often and loudly, not to be forced.
 */

import { isDepositCharge, isTaxCharge } from '../../lib/charge-predicates.js';

/** 2dp money rounding — same semantics as lib/money.js, inlined to stay pure. */
const money = (v) => Number(Number(v || 0).toFixed(2));

const num = (v) => {
  // Prisma Decimal instances stringify cleanly; Number() on the object is NaN.
  const n = typeof v === 'object' && v !== null ? Number(String(v)) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// CEDP field caps. Description is the one that actually bites — charge names
// like "Insurance: Full Protection (Pre-checkin rate)" run past 35 easily.
export const L3_DESCRIPTION_MAX = 35;
export const L3_PURCHASE_IDENTIFIER_MAX = 25;

/**
 * Transliterate to ASCII and truncate. Plan §5.1 flags both (D-8 truncate,
 * M-5 transliterate). Spanish charge names are routine in this tenant base
 * ("Recargo por conductor joven"), and a non-ASCII byte on a fixed-width
 * legacy field is a 904 FORMAT ERROR waiting to happen — the same class of
 * failure shortRef() already had to fix on this rail
 * (ipos-transact-client.js:162-171).
 */
export function l3Description(raw, max = L3_DESCRIPTION_MAX) {
  const s = String(raw == null ? '' : raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // strip combining accents: a-acute -> a
    .replace(/[^\x20-\x7E]/g, '')     // drop anything still non-ASCII-printable
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}

// ---------------------------------------------------------------------------
// UnitOfMeasure
// ---------------------------------------------------------------------------

/**
 * Codes RFM emits. Plan §5.1 leaves the allowed vocabulary open (D-9) and
 * notes the Transact stub hardcodes 'EA'; NOTES §5 gives the derivation
 * (DAILY → 'DAY', UNIT → 'EA', PERCENT → 'EA'). 'DAY' and 'EA' are both
 * standard ANSI X12 355 codes, which is the vocabulary CEDP draws from.
 */
export const UOM_DAY = 'DAY';
export const UOM_EACH = 'EA';

/** Rows that ARE the daily rental line even though chargeType is 'UNIT'. */
const DAILY_CODES = new Set(['DAILY', 'TRIP_DAILY', 'EXTENSION_RATE']);

/**
 * UnitOfMeasure from the row.
 *
 * ⚠️ chargeType ALONE IS NOT ENOUGH, and the codebase is the proof:
 *   • the base rental row is written `chargeType:'DAILY'` in one place
 *     (rental-agreements.service.js:2863, :3225) and `chargeType:'UNIT',
 *     code:'DAILY'` in another (reservation-pricing.service.js:1078). Same
 *     line, two shapes.
 *   • PER_DAY insurance is `chargeType:'UNIT'` with `quantity = rentalDays`
 *     (customer-portal/precheckin-charges.js:240-244,
 *     booking-engine.service.js:1943-1951) — structurally a per-day line that
 *     chargeType calls a unit.
 *
 * So: an explicit DAILY chargeType or a known daily code is DAY. Beyond that,
 * a row is only DAY when the caller supplied `rentalDays` and the row's
 * quantity matches it — evidence, not a guess. Everything else is EA.
 *
 * The 2201 lesson (plan §2.5, §4.6): an invented enum value is a validation
 * rejection, not a nicer report. When unsure, send the boring code.
 */
export function unitOfMeasureFor(row = {}, { rentalDays = null } = {}) {
  const type = String(row?.chargeType || '').trim().toUpperCase();
  const code = String(row?.code || '').trim().toUpperCase();
  const source = String(row?.source || '').trim().toUpperCase();

  if (type === 'DAILY') return UOM_DAY;
  if (DAILY_CODES.has(code)) return UOM_DAY;
  if (source === 'BASE_RATE' && num(row?.quantity) > 1) return UOM_DAY;

  const days = Number(rentalDays);
  if (Number.isFinite(days) && days > 1 && num(row?.quantity) === days) return UOM_DAY;

  return UOM_EACH;
}

// ---------------------------------------------------------------------------
// Tax allocation
// ---------------------------------------------------------------------------

/**
 * Per-line tax DOES NOT EXIST IN RFM. A charge row carries a `taxable Boolean`
 * and tax is one synthesized `chargeType:'TAX'` row. L3 wants a TaxRate per
 * item. So it must be synthesized, and the honest position (plan §5.2) is that
 * per-line rates will not always re-sum to the header TaxAmount — rounding,
 * PERCENT charges, TAX_RECALC adjustments (→ D-11).
 *
 * That is tolerable ONLY because the header TaxAmount stays authoritative and
 * the §5.3 invariant is checked against ExtLineAmount + header TaxAmount, never
 * against the synthesized per-line rates.
 *
 * TWO STRATEGIES, and the two specification documents disagree on which:
 *
 *   LOCATION_RATE (default — plan §5.2)
 *     Stamp Location.taxRate on every non-deposit, non-TAX, non-FEE_ENGINE*
 *     line; 0 on the rest. The plan's reasoning: `taxable` is unreliable, and
 *     this "reproduces the base the summary tax was computed from."
 *
 *   TAXABLE_FLAG (NOTES §5 gap 1)
 *     Stamp the rate only where `row.taxable === true`.
 *
 * The plan wins, because `taxable` is not merely unreliable — it is
 * INCONSISTENT, which is worse than uniformly wrong:
 *     rental-agreements.service.js:2863   base rate → taxable: TRUE
 *     reservation-pricing.service.js:1078 base rate → taxable: FALSE
 * The same conceptual line is written both ways depending on which path
 * created it, so TAXABLE_FLAG produces a different L3 block for two agreements
 * that owe identical money. Kept as a named, tested option so the choice is
 * visible and reversible, not deleted.
 *
 * Making `taxable` meaningful is a pricing-engine change, explicitly out of
 * scope (plan §5.2 → H-11).
 */
export const TAX_ALLOCATION = {
  LOCATION_RATE: 'LOCATION_RATE',
  TAXABLE_FLAG: 'TAXABLE_FLAG',
};

/** Fee-engine rows are priced post-tax; the summary tax was never computed on them. */
const isFeeEngineRow = (row = {}) => String(row?.source || '').trim().toUpperCase().startsWith('FEE_ENGINE');

export function taxRateFor(row = {}, { taxRate = 0, taxAllocation = TAX_ALLOCATION.LOCATION_RATE } = {}) {
  const rate = num(taxRate);
  if (!(rate > 0)) return 0;
  if (isDepositCharge(row) || isTaxCharge(row)) return 0;

  if (taxAllocation === TAX_ALLOCATION.TAXABLE_FLAG) {
    return row?.taxable === true ? rate : 0;
  }
  // LOCATION_RATE
  return isFeeEngineRow(row) ? 0 : rate;
}

// ---------------------------------------------------------------------------
// RentalClassId — restored, and deliberately unused for now
// ---------------------------------------------------------------------------

/**
 * ⚠️ NOTHING CALLS THIS YET. It is restored here, with the L3 mapping it
 * belongs to, so it is in the tree and under test before the AutoRental phase
 * (plan §10 Phase 1b) needs it. Do not delete it as dead code — it was deleted
 * once already and that is the entire reason this comment exists.
 *
 * THE 2201 LESSON (plan §2.5, §4.6; recovered from
 * doc/round-26-followups-2026-05-23.md §11):
 *
 * On 2026-05-23 every live AutoRental/Sale was rejected by SPIn before the
 * terminal showed anything:
 *
 *     statusCode 2201 — "Invalid request data : Rental Class Id must be
 *     4 Digit value or Rental Class Id is not between 0001-0032 and 9999"
 *
 * spin-client.js was sending `(vehicle.classCode || vehicle.vehicleType?.code
 * || '').slice(0, 10)` — ACRISS LETTER codes ('SFAR', 'ECAR') or an empty
 * string. SPIn wants a 4-digit numeric in the ACRISS-numeric range 0001-0032,
 * or the catch-all 9999. Anything else is a hard rejection.
 *
 * This exact function was written, shipped in beta.72 with 7 dedicated tests,
 * live-tested — and is NOT in the current spin-client.js. It was lost when the
 * SPIn AutoRental path was removed. Restored verbatim.
 *
 * '9999' works but loses reporting granularity for chargeback evidence. The
 * recorded followup is a `numericClassCode` column mapping internal classes to
 * ACRISS-numeric — plan §4.6 puts that at Phase 5, "about half a day of work".
 *
 * NOTE — the brief for this phase cited
 * doc/architecture/2026-05-28-dejavoo-spin-checkout-redesign.md as the source.
 * The function is not in that file; it is in
 * doc/round-26-followups-2026-05-23.md §11, which is what plan §4.6 cites.
 */
export function normalizeRentalClassId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (/^\d{4}$/.test(s)) {
    const n = parseInt(s, 10);
    if ((n >= 1 && n <= 32) || n === 9999) return s;
  }
  return '9999';
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export const L3_REFUSAL = {
  NO_CHARGES: 'NO_CHARGES',
  NO_LINE_ITEMS: 'NO_LINE_ITEMS',
  AMOUNT_NOT_POSITIVE: 'AMOUNT_NOT_POSITIVE',
  SUM_MISMATCH: 'SUM_MISMATCH',
};

/**
 * Build the Level 3 line items and summary header for a transaction.
 *
 * @param {object}   input
 * @param {number}   input.amount           the transaction amount, DOLLARS. Authoritative.
 * @param {Array}    input.charges          RentalAgreementCharge / ReservationCharge rows
 * @param {number}  [input.taxAmount]       header tax. Defaults to Σ chargeType 'TAX' rows.
 * @param {number}  [input.taxRate]         Location.taxRate as a PERCENT (9.5 = 9.5%)
 * @param {string}  [input.agreementNumber] → PurchaseIdentifier
 * @param {Date}    [input.orderDate]
 * @param {string}  [input.summaryCommodityCode] per-tenant setting (plan §6.3); omitted when blank
 * @param {number}  [input.rentalDays]      enables the per-day UnitOfMeasure refinement
 * @param {string}  [input.taxAllocation]   TAX_ALLOCATION.*
 * @param {boolean} [input.includeUnselected] default false — `selected:false` rows are off the bill
 *
 * @returns {{ok:true, items:Array, header:object, lineItemCount:number,
 *            taxAmount:number, localTaxFlag:number, localTaxFlagEnum:string,
 *            lineTotal:number, excludedDeposits:number}
 *         | {ok:false, reason:string, detail:object}}
 */
export function buildLevel3LineItems({
  amount,
  charges = [],
  taxAmount = null,
  taxRate = 0,
  agreementNumber = '',
  orderDate = new Date(),
  summaryCommodityCode = '',
  rentalDays = null,
  taxAllocation = TAX_ALLOCATION.LOCATION_RATE,
  includeUnselected = false,
} = {}) {
  const total = money(amount);
  const rows = Array.isArray(charges) ? charges : [];

  if (!(total > 0)) {
    return { ok: false, reason: L3_REFUSAL.AMOUNT_NOT_POSITIVE, detail: { amount: total } };
  }
  if (rows.length === 0) {
    return { ok: false, reason: L3_REFUSAL.NO_CHARGES, detail: { chargeCount: 0 } };
  }

  const selected = rows.filter((r) => (includeUnselected ? true : r?.selected !== false));

  // Deposits ride the separate PreAuth hold and are excluded from agreement
  // total/balance. They never enter LineItemCount and never enter the amount.
  const deposits = selected.filter(isDepositCharge);
  const taxRows = selected.filter((r) => !isDepositCharge(r) && isTaxCharge(r));

  // The TAX row is NEVER emitted as its own line item — its money is already
  // in the header TaxAmount, so a line would double-count it against the
  // §5.3 invariant.
  const lineRows = selected.filter((r) => !isDepositCharge(r) && !isTaxCharge(r));

  const headerTax = taxAmount == null
    ? money(taxRows.reduce((s, r) => s + num(r?.total), 0))
    : money(taxAmount);

  const items = lineRows
    .slice()
    .sort((a, b) => (Number(a?.sortOrder ?? 0) - Number(b?.sortOrder ?? 0)))
    .map((row) => buildLine(row, { taxRate, taxAllocation, rentalDays }));

  if (items.length === 0) {
    return {
      ok: false,
      reason: L3_REFUSAL.NO_LINE_ITEMS,
      detail: { chargeCount: rows.length, deposits: deposits.length, taxRows: taxRows.length },
    };
  }

  const lineTotal = money(items.reduce((s, i) => s + i.ExtLineAmount, 0));
  const reconstructed = money(lineTotal + headerTax);

  // §5.3. To the cent, both ways. No tolerance band — a tolerance is how a
  // rounding bug ships.
  if (reconstructed !== total) {
    return {
      ok: false,
      reason: L3_REFUSAL.SUM_MISMATCH,
      detail: {
        amount: total,
        lineTotal,
        taxAmount: headerTax,
        reconstructed,
        deltaCents: Math.round((total - reconstructed) * 100),
        lineItemCount: items.length,
        excludedDeposits: deposits.length,
      },
    };
  }

  const totalDiscount = money(
    items.filter((i) => i.DiscountIndicator).reduce((s, i) => s + i.DiscountAmount, 0),
  );

  const header = {
    TaxAmount: headerTax,
    // NUMERIC on this rail, on purpose. Plan §4.1 gives the AutoRental REST
    // enum ('LocalOrSales' | 'NotProvided'), but the shipped Transact CEDP
    // header sends a NUMBER (ipos-transact-client.js:311) and this phase edits
    // that live payload. Swapping a live field's primitive type on a rail
    // whose validator hard-fails is precisely the NetGrossIndicator incident
    // (:330-341: the documented string 'N' was rejected, the boolean accepted).
    // `localTaxFlagEnum` below carries the AutoRental form for Phase 2.
    LocalTaxFlag: headerTax > 0 ? 1 : 0,
    NationalTaxAmount: 0,
    TotalDiscountAmount: totalDiscount,
    FreightAmount: 0,
    DutyAmount: 0,
    LineItemCount: items.length,
    PurchaseIdentifier: String(agreementNumber || '').slice(0, L3_PURCHASE_IDENTIFIER_MAX),
    // '3' = Auto Rental Agreement Number. Already correct on this rail.
    PurchaseIdFormatCode: '3',
    OrderDate: toIsoDate(orderDate),
    // Plan §4.1: no column exists anywhere in the schema; it is a merchant
    // attribute supplied per tenant (§6.3). Omitted entirely when unset —
    // an empty string is a value, and unset is not the same as blank.
    ...(String(summaryCommodityCode || '').trim()
      ? { SummaryCommodityCode: String(summaryCommodityCode).trim() }
      : {}),
    // DestZipCode is deliberately NOT sent. Plan §4.1/§4.5: RFM does not model
    // a destination, and `customerZip` is the renter's HOME zip — sending it
    // would be a confidently wrong value, which is worse than a missing one.
  };

  return {
    ok: true,
    items,
    header,
    lineItemCount: items.length,
    taxAmount: headerTax,
    localTaxFlag: header.LocalTaxFlag,
    localTaxFlagEnum: headerTax > 0 ? 'LocalOrSales' : 'NotProvided',
    lineTotal,
    totalDiscount,
    excludedDeposits: deposits.length,
  };
}

/**
 * One CEDP line. All eight mandatory fields, always present:
 * Description, Quantity, UnitOfMeasure, UnitCost, TaxRate, DiscountAmount,
 * DiscountIndicator, ExtLineAmount.
 */
function buildLine(row, { taxRate, taxAllocation, rentalDays }) {
  const ext = money(row?.total);

  // ── Quantity / UnitCost ──────────────────────────────────────────────────
  // Take them from the row when they RECONCILE, else collapse to 1 × ext.
  //
  // CEDP validators check UnitCost × Quantity against ExtLineAmount, and RFM
  // has rows where they genuinely do not multiply out: PERCENTAGE insurance
  // stores rate = the computed dollar amount with quantity 1 (fine), but a
  // repriced or partially-credited row can carry a stale rate. ExtLineAmount
  // is the money and must survive untouched — so when the row does not
  // reconcile, the quantity/rate pair is what gives way, not the total.
  const rawQty = num(row?.quantity);
  const rawRate = num(row?.rate);
  const reconciles = rawQty > 0 && money(rawQty * rawRate) === ext;

  const quantity = reconciles ? round2(rawQty) : 1;
  const unitCost = reconciles ? money(rawRate) : ext;

  // ── Discounts / credits ──────────────────────────────────────────────────
  // A negative ExtLineAmount is a credit: the 'Discount' row
  // (rental-agreements.service.js:2942 — name 'Discount', quantity 1,
  // rate/total both negative) and ADMIN_CORRECTION credits.
  //
  // NOTES §5 gap 6: there is no `source: 'DISCOUNT'` constant, so the line can
  // only be found by its sign. That is actually the more robust key here —
  // sign catches every credit, not just the one named 'Discount'.
  const isDiscount = ext < 0;

  return {
    Description: l3Description(row?.name) || 'Rental charge',
    Quantity: quantity,
    UnitOfMeasure: unitOfMeasureFor(row, { rentalDays }),
    UnitCost: unitCost,
    // Line TaxAmount stays 0 — RFM has no per-line tax amount and the real
    // total is in the header (NOTES §5 gap 1). Confirm with Dejavoo that a
    // non-zero TaxRate alongside a zero line TaxAmount is accepted (NOTES §7
    // Q6 / plan D-11).
    TaxAmount: 0,
    TaxRate: taxRateFor(row, { taxRate, taxAllocation }),
    DiscountAmount: isDiscount ? money(Math.abs(ext)) : 0,
    // BOOLEAN, not the string 'N'. Plan §5.1 proposes `'N'` but flags the
    // vocabulary as unconfirmed (D-10); NOTES §5 and the brief both say
    // boolean. The tiebreaker is live evidence on THIS rail: Dejavoo rejected
    // the documented string form of NetGrossIndicator as "not a valid
    // attribute" and accepted the boolean from their own sample payload
    // (ipos-transact-client.js:330-341). Match the shape their validator
    // actually took.
    DiscountIndicator: isDiscount,
    ExtLineAmount: ext,
    // Unchanged from the shipped payload — see the NetGrossIndicator note
    // above. false = amount does not include tax.
    NetGrossIndicator: false,
    TaxIndicator: 0,
  };
}

const round2 = (v) => Number(Number(v || 0).toFixed(2));

function toIsoDate(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return (Number.isNaN(dt.getTime()) ? new Date() : dt).toISOString().slice(0, 10);
}

export const autoRentalL3Builder = {
  buildLevel3LineItems,
  unitOfMeasureFor,
  taxRateFor,
  l3Description,
  normalizeRentalClassId,
  TAX_ALLOCATION,
  L3_REFUSAL,
};
