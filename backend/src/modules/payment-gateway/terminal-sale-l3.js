/**
 * Level 2 / Level 3 on the TERMINAL sale — the card-present rail.
 * PURE: no prisma, no network, no logger, no clock beyond an injected date.
 * The caller (spin-client.sale) does the logging; this file only decides.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * A card-present rental at LAX settles at whatever interchange the card brands
 * assign to a bare Sale. Carrying Level 2 (tax) and Level 3 (line items) on the
 * transaction is what moves it to the lower auto-rental rate. RFM already has
 * the itemization and already knows how to shape it — autorental-l3.builder.js
 * was merged 2026-09-04 and is wired into the Transact CNP rail. It has NEVER
 * been sent to the terminal.
 *
 * This module is the terminal-side adapter for that same builder. It builds no
 * line items of its own: buildLevel3LineItems() is the one implementation, the
 * §5.3 sum invariant is enforced there, and a refusal here means the caller
 * sends today's payload byte for byte.
 *
 * ── WHY EVERYTHING DEFAULTS OFF, INCLUDING THE MASTER SWITCH ────────────────
 *
 * The Transact rail defaults `autoRental` ON and only `l3LineItems` OFF
 * (ipos-transact-client.js:104-125), because that rail has been sending an
 * L3Data block on every CNP charge for months and we know it is tolerated.
 *
 * NOTHING is known to be tolerated here. The whole flag family therefore ships
 * OFF, and the reason is a specific, recorded, expensive failure mode:
 *
 *   2026-05-30 (spin-client.js sale(), still in the comment): adding GetToken,
 *   EnableTip and PrintReceipt to the Sale body made SPIn reject the request
 *   with StatusCode 2201 / ResultCode 2 BEFORE the terminal saw anything.
 *   Nothing on screen. Nothing in the Dejavoo portal. A customer standing at
 *   the counter with a card in their hand and an agent looking at an error.
 *
 *   2026-05-23 (doc/round-26-followups-2026-05-23.md §11): every AutoRental
 *   Sale rejected 2201 because RentalClassId carried an ACRISS LETTER code.
 *
 *   2026-05-22 (commit 02af6407): a FLAT AutoRental object crashed SPIn's
 *   ASP.NET parser with an HTTP 500 "An error has occurred".
 *
 * Three separate 2201-class incidents on this exact rail, all caused by the
 * shape of an added field. So the default is off and the way this gets turned
 * on is scripts/probe-terminal-sale-l3.mjs proving, stage by stage, which
 * fields the gateway actually takes — not a reading of the docs, which have
 * already been wrong twice on this rail (NetGrossIndicator's documented string
 * form was rejected; the documented `RentalData` body key had to become
 * `AutoRental`).
 *
 * ── THE ENVELOPE IS AN OPEN QUESTION, AND IS TREATED AS ONE ─────────────────
 *
 * There are two candidate homes for the itemization on a SPIn Sale, and the
 * repository contains live evidence for each:
 *
 *   L3DATA — `{ L3Data: { Header, items } }`. The VISA CEDP shape. PROVEN on
 *     the iPOSpays TRANSACT rail (ipos-transact-client.js:411-447) — same
 *     merchant, same processor, different API. Never sent to SPIn.
 *
 *   CART — `{ Cart: { Items, Total, Amounts } }`. PROVEN to be parsed by SPIn
 *     itself: commit ddd6d4b0 (2026-05-22) records the gateway's own rejection
 *     sentences being satisfied one at a time — "Price field is required for
 *     Items in Cart's Items List", then "List of Amounts required in Cart and
 *     it must contain at least one Amount". A gateway that names a missing
 *     subfield is a gateway that is reading the object. But that was on
 *     `v2/AutoRental/Sale`, and Cart is a terminal DISPLAY structure; whether
 *     it feeds interchange at all is unknown.
 *
 * Guessing between them on a money path is exactly what this task exists to
 * stop, so both are implemented and the probe sends both. `L3DATA` is the
 * default only because it is the shape whose interchange value is documented.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * No endpoint change. `v2/AutoRental/Sale` existed once and was removed; this
 * module rides the SHIPPED `v2/Payment/Sale` that takes real money today, and
 * the probe stays on it too.
 *
 * That leaves one question this branch does NOT answer: the four 2026-05 field
 * shapes were all learned on `v2/AutoRental/Sale`, so it is entirely possible
 * that `AutoRental` and `Cart` are only honoured THERE and that the plain Sale
 * ignores them. If the probe's stages 4-6 approve but no ARLFlag ever comes
 * back, that is the answer, and the next piece of work is restoring the
 * AutoRental endpoint — a bigger change (its own Auth/Capture pair, its own
 * CaptureSignature semantics) than this one, and not one to make on a guess.
 */

import { buildLevel3LineItems, normalizeRentalClassId, L3_PURCHASE_IDENTIFIER_MAX } from './autorental-l3.builder.js';
import { isDepositCharge, isTaxCharge } from '../../lib/charge-predicates.js';

const money = (v) => Number(Number(v || 0).toFixed(2));

/** Auto rental, per the Dejavoo commodity-code reference. Carried forward from
 * the removed buildLevel3FromReservation (commit 0464d39f). */
export const AUTO_RENTAL_COMMODITY_CODE = '4111';

export const L3_ENVELOPE = {
  L3DATA: 'L3DATA',
  CART: 'CART',
};

/** Why no L3 rode along. Every one of these is a normal outcome, not a bug. */
export const TERMINAL_L3_SKIP = {
  DISABLED: 'DISABLED',                 // master flag off — the shipped default
  NO_INPUTS: 'NO_INPUTS',               // caller passed no charges (e.g. a bare charge screen)
  LINE_ITEMS_DISABLED: 'LINE_ITEMS_DISABLED',
  // The payload's claim about the money did not hold — §5.3 SUM_MISMATCH for a
  // Level 3 block, TAX_NOT_WITHIN_AMOUNT for a Level 2 header. `reason` says
  // which. Routine, and always logged.
  BUILDER_REFUSED: 'BUILDER_REFUSED',
};

const truthy = (v) => String(v ?? '').trim().toLowerCase() === 'true';

/**
 * The flag family. ONE prefix (`spinL3*` / `SPIN_L3_*`) so a tenant's terminal
 * L2/L3 posture is greppable in one line, and so nobody can turn on half of it
 * by setting the Transact rail's flag by mistake — they are different APIs with
 * different failure modes and they must not share a switch.
 *
 * Every default is the safe one. `enabled` gates the entire family: with it off
 * this module returns an empty payload and the sale body is untouched.
 */
export function getTerminalL3Config(tenantConfig = {}) {
  return {
    // MASTER. Off ⇒ nothing below matters.
    enabled: tenantConfig.spinL3Enabled === true
      || truthy(process.env.SPIN_L3_ENABLED),
    // Real line items from the agreement's charges.
    lineItems: tenantConfig.spinL3LineItems === true
      || truthy(process.env.SPIN_L3_LINE_ITEMS),
    // LEVEL 2 ONLY: the summary header — the tax figure — with NO line items.
    // A real posture, not just a probe rung. Level 2 qualification wants the
    // tax amount and a purchase identifier; Level 3 wants the itemization on
    // top. This carries the first without risking the second, which matters on
    // a rail that has rejected four different field shapes. Ignored when
    // `lineItems` is on, because a full L3 block already contains the header.
    headerOnly: tenantConfig.spinL3HeaderOnly === true
      || truthy(process.env.SPIN_L3_HEADER_ONLY),
    // The nested AutoRental block (renter, vehicle, pickup/return, distance).
    // Separate from lineItems on purpose: the 2026-05 incidents were caused by
    // AutoRental fields, and a tenant may want the itemization without them.
    autoRental: tenantConfig.spinL3AutoRental === true
      || truthy(process.env.SPIN_L3_AUTO_RENTAL),
    // See the header. L3DATA unless a tenant is explicitly switched to CART.
    envelope: String(
      tenantConfig.spinL3Envelope || process.env.SPIN_L3_ENVELOPE || L3_ENVELOPE.L3DATA,
    ).trim().toUpperCase() === L3_ENVELOPE.CART ? L3_ENVELOPE.CART : L3_ENVELOPE.L3DATA,
    // Merchant attribute; no column exists for it (plan §4.1/§6.3). Blank ⇒ omitted.
    summaryCommodityCode: String(
      tenantConfig.spinL3SummaryCommodityCode
      || process.env.SPIN_L3_SUMMARY_COMMODITY_CODE
      || '',
    ).trim(),
  };
}

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/** ISO-8601 or '' — never a bare invalid Date, which SPIn's parser has choked on. */
function isoOrEmpty(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString();
}

const numOrNull = (v) => {
  const n = typeof v === 'object' && v !== null ? Number(String(v)) : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The nested AutoRental block, restored from commit 02af6407 — the shape SPIn's
 * own parser accepted after the flat form returned HTTP 500. Sub-object names
 * and nesting are NOT ours to tidy: they are the gateway's, and the last time
 * somebody assumed otherwise it cost a live terminal session.
 *
 * The one field that is not verbatim is RentalClassId, which goes through
 * normalizeRentalClassId() — the whole reason that function was written and,
 * per its own comment, deleted once and restored. A raw ACRISS letter code here
 * is the documented 2201.
 *
 * Field caps mirror the historical builder exactly (25/80/20/40/2). They are
 * not verified against a current spec; they are what was on the wire the last
 * time this rail worked, and widening them is a change to test, not to assume.
 */
export function buildAutoRentalBlock({
  agreementNumber = '',
  rentalDays = null,
  renterName = '',
  renterMobile = '',
  vehicle = {},
  dailyRate = null,
  pickupAt = null,
  returnAt = null,
  pickupLocation = {},
  returnLocation = {},
  rentalDistance = null,
} = {}) {
  const loc = (l = {}) => ({
    Address: str(l.address, 80),
    City: str(l.city, 40),
    State: str(l.state, 20),
    Country: str(l.country || 'USA', 20),
    LocationId: str(l.code, 20),
    // RegionCode / CountryCode have NO column in RFM (autorental-validation.js
    // records both as DOES NOT EXIST). The historical builder derived them —
    // RegionCode from the first two characters of a free-text state, CountryCode
    // hardcoded 'US'. Both are reproduced because they were on the accepted
    // wire, and both are flagged: a confidently wrong code is worse than a
    // missing one, and plan D-5 is the open question that settles it.
    RegionCode: str(l.state, 2),
    CountryCode: 'US',
  });

  return {
    AutoRentalAgreement: {
      AgreementReferenceNumber: str(agreementNumber, 25),
      PurchaseIdentifier: '',
      RentalDuration: Number.isFinite(Number(rentalDays)) && Number(rentalDays) > 0
        ? Number(rentalDays) : null,
      RentalPeriod: 'Daily',
      AutoRentalAdjustment: {
        AdjustmentAmount: null,
        // 'X' = no adjustments. Carried forward; the indicator's full
        // vocabulary is undocumented (plan D-4).
        AdjustmentAuditIndicatorCode: 'X',
      },
    },
    AutoRentalRenter: {
      RenterName: str(renterName, 80) || 'Customer',
      ServiceMobile: str(renterMobile, 20),
    },
    AutoRentalVehicle: {
      VehicleMake: str(vehicle?.make, 20),
      VehicleModel: str(vehicle?.model, 20),
      // ⚠️ THE 2201. 4-digit 0001–0032, or the catch-all 9999. Never a letter code.
      RentalClassId: normalizeRentalClassId(
        vehicle?.numericClassCode || vehicle?.classCode || vehicle?.vehicleType?.code,
      ),
    },
    AutoRentalPricing: {
      RentalRate: numOrNull(dailyRate),
      // ⚠️ THIS EXACT STRING, and it took two round trips to find. 2026-05-22:
      //   []                 → 2201 "ExtraCharges are required or NoExtraCharge
      //                        cannot be combined with other charges" (bc29c096)
      //   ['']               → 2201 "Unacceptable value for
      //                        AutoRental.AutoRentalPricing.ExtraCharges[0]" (ddd6d4b0)
      //   ['NoExtraCharge']  → accepted. The gateway's own error sentence named
      //                        the enum value it wanted.
      // Not a placeholder and not tidy-able. This is the "no extras" marker.
      ExtraCharges: ['NoExtraCharge'],
    },
    AutoRentalPickup: { DateTime: isoOrEmpty(pickupAt), ...loc(pickupLocation) },
    AutoRentalReturn: { DateTime: isoOrEmpty(returnAt), ...loc(returnLocation) },
    AutoRentalDistance: {
      RentalDistance: numOrNull(rentalDistance),
      // Constant — RFM has no distance-unit column.
      AutoRentalDistanceUnitofMeasure: 'Miles',
    },
  };
}

/**
 * Cart envelope. Items carry BOTH `Price` and `Total` because the gateway
 * demanded `Price` by name (ddd6d4b0) and our own chargeback layer reads
 * `Total`; dropping either is a change to prove, not to make in passing.
 *
 * `Amounts` must be non-empty — the gateway said so in those words. Subtotal /
 * Tax / Total is a strict improvement on the historical Subtotal / Total pair:
 * it is what makes this a LEVEL 2 payload rather than a display list, since the
 * tax figure is the Level 2 datum. Cart.Total is the transaction amount, so the
 * terminal's totals row and the money agree by construction.
 */
function cartFrom(built, amount) {
  return {
    Items: built.items.map((i) => ({
      Name: i.Description,
      Price: i.ExtLineAmount,
      Quantity: i.Quantity,
      UnitPrice: i.UnitCost,
      Total: i.ExtLineAmount,
      CommodityCode: AUTO_RENTAL_COMMODITY_CODE,
    })),
    Total: amount,
    Amounts: [
      { Name: 'Subtotal', Value: built.lineTotal },
      { Name: 'Tax', Value: built.taxAmount },
      { Name: 'Total', Value: amount },
    ],
  };
}

/**
 * LEVEL 2 ONLY: the summary header, with no line items.
 *
 * This payload makes a DIFFERENT claim from a Level 3 block, so it is checked
 * against a different — and deliberately weaker — invariant. §5.3 exists because
 * line items assert how the amount decomposes, and a decomposition that does not
 * add up is a lie about the money. A Level 2 header asserts only "of this
 * amount, that much was tax". So the rule is just that the claim is POSSIBLE:
 * the amount is positive, the tax is not negative, and the tax is not more than
 * the amount. If it is not possible we say nothing at all.
 *
 * LineItemCount is 0 and must be. Claiming items we are not sending is exactly
 * the "payload whose lines disagree with the money" the L3 builder refuses.
 */
function buildLevel2Header({ total, charges, taxAmount, agreementNumber, orderDate, cfg }) {
  const tax = money(taxAmount == null
    ? (Array.isArray(charges) ? charges : [])
      .filter((r) => !isDepositCharge(r) && isTaxCharge(r))
      .reduce((s, r) => s + Number(String(r?.total ?? 0)), 0)
    : taxAmount);

  if (!(total > 0) || tax < 0 || tax > total) {
    return {
      ok: false,
      reason: 'TAX_NOT_WITHIN_AMOUNT',
      detail: { amount: total, taxAmount: tax },
    };
  }

  if (cfg.envelope === L3_ENVELOPE.CART) {
    return {
      ok: true,
      tax,
      payload: {
        Cart: {
          Items: [],
          Total: total,
          Amounts: [
            { Name: 'Subtotal', Value: money(total - tax) },
            { Name: 'Tax', Value: tax },
            { Name: 'Total', Value: total },
          ],
        },
      },
    };
  }

  return {
    ok: true,
    tax,
    payload: {
      L3Data: {
        Header: {
          TaxAmount: tax,
          LocalTaxFlag: tax > 0 ? 1 : 0,
          NationalTaxAmount: 0,
          TotalDiscountAmount: 0,
          FreightAmount: 0,
          DutyAmount: 0,
          LineItemCount: 0,
          PurchaseIdentifier: String(agreementNumber || '').slice(0, L3_PURCHASE_IDENTIFIER_MAX),
          PurchaseIdFormatCode: '3',
          OrderDate: (orderDate instanceof Date && !Number.isNaN(orderDate.getTime())
            ? orderDate : new Date()).toISOString().slice(0, 10),
          ...(cfg.summaryCommodityCode ? { SummaryCommodityCode: cfg.summaryCommodityCode } : {}),
        },
        items: [],
      },
    },
  };
}

/**
 * Decide what L2/L3 rides on this terminal sale.
 *
 * ALWAYS returns a `payload` object. `{}` means "send today's body unchanged",
 * and that is the answer whenever anything at all is uncertain — the flag is
 * off, no charges were threaded, or the builder refused because the lines and
 * the money disagree. There is no path here that sends a half-built block.
 *
 * @returns {{payload: object, decision: {
 *   enabled: boolean, applied: boolean, envelope: string,
 *   lineItems: boolean, autoRental: boolean,
 *   skipped: string|null, reason: string|null, detail: object|null,
 *   lineItemCount: number, taxAmount: number, lineTotal: number,
 *   excludedDeposits: number, rentalClassId: string|null }}}
 */
export function buildTerminalSaleL3({
  amount,
  charges = null,
  taxAmount = null,
  taxRate = 0,
  agreementNumber = '',
  rentalDays = null,
  orderDate = new Date(),
  autoRental = null,
} = {}, tenantConfig = {}) {
  const cfg = getTerminalL3Config(tenantConfig);

  const base = {
    enabled: cfg.enabled,
    applied: false,
    envelope: cfg.envelope,
    lineItems: false,
    headerOnly: false,
    autoRental: false,
    skipped: null,
    reason: null,
    detail: null,
    lineItemCount: 0,
    taxAmount: 0,
    lineTotal: 0,
    excludedDeposits: 0,
    rentalClassId: null,
  };

  if (!cfg.enabled) {
    return { payload: {}, decision: { ...base, skipped: TERMINAL_L3_SKIP.DISABLED } };
  }

  const payload = {};
  const decision = { ...base };

  const total = money(amount);

  // ── Level 2 only: the header, no items ───────────────────────────────────
  if (!cfg.lineItems && cfg.headerOnly) {
    const level2 = buildLevel2Header({ total, charges, taxAmount, agreementNumber, orderDate, cfg });
    if (level2.ok) {
      decision.applied = true;
      decision.headerOnly = true;
      decision.taxAmount = level2.tax;
      Object.assign(payload, level2.payload);
    } else {
      // NOT a return. The AutoRental block below is an independent switch, and
      // refusing the tax claim is no reason to drop it — same shape as the
      // line-item refusal further down.
      decision.skipped = TERMINAL_L3_SKIP.BUILDER_REFUSED;
      decision.reason = level2.reason;
      decision.detail = level2.detail;
    }
  } else if (!cfg.lineItems) {
    decision.skipped = TERMINAL_L3_SKIP.LINE_ITEMS_DISABLED;
  } else if (!Array.isArray(charges) || charges.length === 0) {
    // Not a failure. spin-charge's prepaid branch and payment-gateway's
    // chargeReservation genuinely have no itemization to send.
    decision.skipped = TERMINAL_L3_SKIP.NO_INPUTS;
  } else {
    const built = buildLevel3LineItems({
      amount,
      charges,
      taxAmount,
      taxRate,
      agreementNumber,
      orderDate,
      summaryCommodityCode: cfg.summaryCommodityCode,
      rentalDays,
    });

    if (built.ok) {
      decision.lineItems = true;
      decision.applied = true;
      decision.lineItemCount = built.lineItemCount;
      decision.taxAmount = built.taxAmount;
      decision.lineTotal = built.lineTotal;
      decision.excludedDeposits = built.excludedDeposits;
      if (cfg.envelope === L3_ENVELOPE.CART) {
        payload.Cart = cartFrom(built, total);
      } else {
        payload.L3Data = { Header: built.header, items: built.items };
      }
    } else {
      // The §5.3 invariant did not hold. The caller sends today's payload and
      // logs this; see the builder's header for why refusal is the common case.
      decision.skipped = TERMINAL_L3_SKIP.BUILDER_REFUSED;
      decision.reason = built.reason;
      decision.detail = built.detail || null;
    }
  }

  // ── AutoRental block ─────────────────────────────────────────────────────
  // Independent of the line items on purpose. It is the half with the 2201
  // history, so it must be switchable on its own — that is what lets the probe
  // (and an operator) tell "the gateway hates our line items" apart from "the
  // gateway hates our rental class code".
  if (cfg.autoRental && autoRental && typeof autoRental === 'object') {
    const block = buildAutoRentalBlock(autoRental);
    payload.AutoRental = block;
    decision.autoRental = true;
    decision.applied = true;
    decision.rentalClassId = block.AutoRentalVehicle.RentalClassId;
  }

  return { payload, decision };
}

export const terminalSaleL3 = {
  getTerminalL3Config,
  buildTerminalSaleL3,
  buildAutoRentalBlock,
  L3_ENVELOPE,
  TERMINAL_L3_SKIP,
  AUTO_RENTAL_COMMODITY_CODE,
};
