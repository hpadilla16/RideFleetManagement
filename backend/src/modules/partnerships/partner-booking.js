/**
 * Partnerships F2 — the partner context for the PUBLIC quote + checkout path (2026-09-05).
 * Plan §3.2 (doc/partnerships-module-plan-2026-09-05.md). Money rules, in order:
 *
 *   1. The client never sends prices. It sends `partnerSlug` (or `partnerCode`); the
 *      server resolves the program and PRICES from it. Anything that fails resolution
 *      is a 422 PARTNER_NOT_AVAILABLE — never a silent fall-back to online pricing.
 *   2. A program prices ONLY when it is ACTIVE right now (status + validity window),
 *      belongs to the tenant in scope, and covers the pickup location.
 *   3. Price book mode → resolveForRental(options.rateId) on the partner's PARTNER
 *      book (fail-closed per class). Discount mode → the ONLINE quote with an
 *      effective daily rate (same shape as revenue pricing: dailyRate moves,
 *      baseDailyRate keeps the strike-through). Revenue pricing never applies to a
 *      partner quote — the price is negotiated.
 *   4. Vehicle mode decides WHAT is offered: SHOW_INVENTORY → the priced classes
 *      (optionally narrowed), PREFERRED_TYPE (insurers) → the selectable types and a
 *      coverage disclosure the customer must accept, ASSIGN_AT_PICKUP → one default class.
 *   5. PREFERRED_TYPE + CONFIRM_AT_PICKUP (Hector 2026-09-05) → no online payment: the
 *      reservation is created with no deposit due now and no payment request; the
 *      counter confirms the amount at pickup against the policy.
 *
 * Pure helpers are exported for the DB-free suite; `resolvePartnerContext` is the
 * only prisma-backed function.
 */
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { money } from '../../lib/money.js';
import { effectiveStatus, applyDiscount } from './partner-rules.js';

export class PartnerUnavailableError extends AppError {
  constructor(reason, message = 'This program is not available') {
    super(message, 422);
    this.code = 'PARTNER_NOT_AVAILABLE';
    this.reason = reason;
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the program for a public quote/checkout. Returns null when the request
 * carries no partner at all (ordinary public booking); throws PartnerUnavailableError
 * (422) for anything that names a partner it cannot price.
 */
export async function resolvePartnerContext({ tenantId, partnerSlug, partnerCode, pickupLocationId } = {}) {
  const slug = String(partnerSlug || '').trim().toLowerCase();
  const code = String(partnerCode || '').trim().toUpperCase();
  if (!slug && !code) return null;
  // The tenant in scope is the ceiling: with no tenant we cannot prove the program
  // is theirs, so we do not price (the storefront always carries X-Tenant-Token).
  if (!tenantId) throw new PartnerUnavailableError('TENANT_REQUIRED');

  const partner = await prisma.partner.findFirst({
    where: { tenantId: String(tenantId), ...(slug ? { slug } : { code }) },
    include: {
      rate: { select: { id: true, active: true, isActive: true, purpose: true } },
      services: {
        orderBy: [{ sortOrder: 'asc' }],
        include: { additionalService: { include: { linkedFee: true } } }
      },
      tenant: { select: { partnershipsEnabled: true, status: true } }
    }
  });
  if (!partner) throw new PartnerUnavailableError('PARTNER_NOT_FOUND');
  if (!partner.tenant?.partnershipsEnabled || partner.tenant?.status !== 'ACTIVE') throw new PartnerUnavailableError('MODULE_DISABLED');
  const status = effectiveStatus(partner);
  if (status !== 'ACTIVE') throw new PartnerUnavailableError(status);

  const locationIds = Array.isArray(partner.locationIds) ? partner.locationIds.map(String) : null;
  if (pickupLocationId && locationIds?.length && !locationIds.includes(String(pickupLocationId))) {
    throw new PartnerUnavailableError('LOCATION_NOT_IN_PROGRAM');
  }

  const rateUsable = !!partner.rate && partner.rate.purpose === 'PARTNER' && partner.rate.active && partner.rate.isActive;
  const discountPct = num(partner.discountPct);
  if (!rateUsable && !(discountPct > 0)) throw new PartnerUnavailableError('NO_PRICING');

  return {
    partner: {
      id: partner.id,
      slug: partner.slug,
      code: partner.code,
      name: partner.name,
      kind: partner.kind,
      vehicleMode: partner.vehicleMode,
      preferredTypePricing: partner.preferredTypePricing,
      askPolicyNumber: !!partner.askPolicyNumber,
      termsVersion: partner.termsVersion,
      coverageDisclosureVersion: partner.coverageDisclosureVersion,
      updatedAt: partner.updatedAt
    },
    pricingMode: rateUsable ? 'RATE' : 'DISCOUNT',
    rateId: rateUsable ? partner.rate.id : null,
    discountPct: rateUsable ? null : discountPct,
    allowedVehicleTypeIds: Array.isArray(partner.allowedVehicleTypeIds) ? partner.allowedVehicleTypeIds.map(String) : null,
    defaultVehicleTypeId: partner.defaultVehicleTypeId || null,
    noOnlinePayment: partner.vehicleMode === 'PREFERRED_TYPE' && partner.preferredTypePricing === 'CONFIRM_AT_PICKUP',
    services: partner.services
      .filter((row) => row.additionalService && row.additionalService.isActive)
      .map((row) => ({
        ...row.additionalService,
        // Program price replaces the list price for BOTH flat and per-day services.
        ...(row.rateOverride === null || row.rateOverride === undefined
          ? {}
          : Number(row.additionalService.dailyRate || 0) > 0
            ? { dailyRate: Number(row.rateOverride) }
            : { rate: Number(row.rateOverride) }),
        mandatory: !!row.mandatory,
        partnerOnly: !!row.additionalService.partnerId
      }))
  };
}

/** Which vehicle types the program offers, given the tenant's list. Pure. */
export function partnerEligibleTypeIds(ctx, allTypeIds = []) {
  const all = allTypeIds.map(String);
  if (!ctx) return all;
  const allowed = ctx.allowedVehicleTypeIds;
  if (ctx.partner.vehicleMode === 'ASSIGN_AT_PICKUP') {
    return ctx.defaultVehicleTypeId && all.includes(ctx.defaultVehicleTypeId) ? [ctx.defaultVehicleTypeId] : [];
  }
  if (ctx.partner.vehicleMode === 'PREFERRED_TYPE') {
    return (allowed || []).filter((id) => all.includes(id));
  }
  return allowed?.length ? all.filter((id) => allowed.includes(id)) : all;
}

/**
 * Turn an ONLINE base quote into the program quote in DISCOUNT mode (RATE mode
 * quotes come straight from the partner book). Pure. `onlineQuote` is the
 * resolveForRental shape ({ dailyRate, baseTotal, days, dailyBreakdown… }).
 */
export function applyPartnerDiscount(onlineQuote, discountPct) {
  if (!onlineQuote) return null;
  const dailyRate = applyDiscount(onlineQuote.dailyRate, discountPct);
  const days = Math.max(0, Number(onlineQuote.days || 0));
  const breakdown = (onlineQuote.dailyBreakdown || []).map((row) => ({ ...row, dailyRate: applyDiscount(row.dailyRate, discountPct) }));
  const baseTotal = breakdown.length
    ? money(breakdown.reduce((sum, row) => sum + Number(row.dailyRate || 0), 0))
    : money(dailyRate * days);
  return {
    ...onlineQuote,
    dailyRate,
    baseDailyRate: dailyRate,
    baseTotal,
    dailyBreakdown: breakdown,
    source: 'PARTNER_DISCOUNT'
  };
}

/** What the search payload exposes per class so the storefront can draw the strike-through. Pure. */
export function partnerPricingBlock(ctx, { onlineQuote, programQuote }) {
  if (!ctx) return null;
  const onlineDaily = onlineQuote ? money(onlineQuote.dailyRate) : null;
  const programDaily = programQuote ? money(programQuote.dailyRate) : null;
  return {
    mode: ctx.pricingMode,
    discountPct: ctx.discountPct,
    onlineDailyRate: onlineDaily,
    programDailyRate: programDaily,
    savingsPct: onlineDaily && programDaily && onlineDaily > 0 ? Math.round(((onlineDaily - programDaily) / onlineDaily) * 100) : null,
    priceConfirmedAtPickup: !!ctx.noOnlinePayment
  };
}

/**
 * Checkout-time requirements for a partner booking. Pure. Returns the vehicleTypeId
 * to book and the stamps for the reservation, or throws a 422 AppError naming what
 * is missing. `input` is the public checkout body.
 */
export function partnerCheckoutRequirements(ctx, input = {}, { offeredTypeIds = [] } = {}) {
  if (!ctx) return null;
  const mode = ctx.partner.vehicleMode;
  const offered = offeredTypeIds.map(String);
  let vehicleTypeId = String(input?.vehicleTypeId || '');
  let preferredVehicleTypeId = null;
  let disclosureAcceptedAt = null;
  let disclosureVersion = null;
  let policyNumber = null;

  if (mode === 'PREFERRED_TYPE') {
    preferredVehicleTypeId = String(input?.partnerPreferredVehicleTypeId || input?.vehicleTypeId || '');
    if (!preferredVehicleTypeId || !offered.includes(preferredVehicleTypeId)) {
      throw new AppError('Pick one of the vehicle types offered by this program', 422);
    }
    if (input?.partnerDisclosureAccepted !== true) {
      throw new AppError('You must accept the coverage disclosure to continue', 422);
    }
    vehicleTypeId = preferredVehicleTypeId;
    disclosureAcceptedAt = new Date();
    disclosureVersion = ctx.partner.coverageDisclosureVersion || 1;
    if (ctx.partner.askPolicyNumber && input?.partnerPolicyNumber !== undefined && input?.partnerPolicyNumber !== null) {
      policyNumber = String(input.partnerPolicyNumber).trim().slice(0, 64) || null;
    }
  } else if (mode === 'ASSIGN_AT_PICKUP') {
    if (!ctx.defaultVehicleTypeId) throw new AppError('This program has no default vehicle class', 422);
    vehicleTypeId = ctx.defaultVehicleTypeId;
  } else if (!vehicleTypeId || !offered.includes(vehicleTypeId)) {
    throw new AppError('Selected vehicle class is not offered by this program', 422);
  }

  return {
    vehicleTypeId,
    noOnlinePayment: !!ctx.noOnlinePayment,
    stamps: {
      partnerId: ctx.partner.id,
      partnerTermsVersion: ctx.partner.termsVersion || 1,
      partnerPreferredVehicleTypeId: preferredVehicleTypeId,
      partnerDisclosureAcceptedAt: disclosureAcceptedAt,
      partnerDisclosureVersion: disclosureVersion,
      partnerPolicyNumber: policyNumber
    }
  };
}

/** Program services the server adds even when the client did not tick them. Pure. */
export function mandatoryPartnerServices(offeredServices = []) {
  return (offeredServices || []).filter((service) => service && service.mandatory);
}

/**
 * "No number" rule for a STORED reservation (Hector 2026-09-05, decision #3): an
 * insurer preference booking whose amount is confirmed at pickup must not show a
 * total/balance/daily rate on any customer surface (portal, emails), while staff keep
 * the program price internally. `reservation.partner` must be loaded (select
 * preferredTypePricing); without it the preference stamp alone decides.
 */
export function reservationPriceConfirmedAtPickup(reservation) {
  if (!reservation?.partnerId || !reservation?.partnerPreferredVehicleTypeId) return false;
  const pricing = reservation?.partner?.preferredTypePricing;
  return pricing ? pricing === 'CONFIRM_AT_PICKUP' : true;
}
