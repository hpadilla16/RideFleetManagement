/**
 * Partnerships — PUBLIC landing payload (2026-09-05).
 * Served by publicBookingRouter GET /partners/:slug (tenant forced by X-Tenant-Token,
 * legacy ?tenantSlug otherwise). Read-only; no prices per date here — that is
 * rental-search's job (F2). Everything returned is what the storefront renders on
 * partners.<tenant-domain>/<slug>: both logos, landing copy, program terms, the
 * vehicle mode (inventory / preferred type + coverage disclosure / assign at pickup),
 * the program's service catalog, and the locations in scope.
 *
 * Fail-closed: any partner that is not ACTIVE *right now* (status, validFrom/validTo)
 * or whose tenant is not ACTIVE / not entitled → { ok:false, reason } (route → 404).
 * Never falls back to online pricing or to another tenant's program.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { effectiveStatus, hostedUrl, applyDiscount } from './partner-rules.js';
import { logoPublicUrl } from './partnerships.service.js';

function num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function resolveTenant({ tenantId, tenantSlug }) {
  if (!tenantId && !tenantSlug) return null;
  return prisma.tenant.findFirst({
    where: {
      status: 'ACTIVE',
      ...(tenantId ? { id: String(tenantId).trim() } : {}),
      ...(tenantSlug ? { slug: String(tenantSlug).trim() } : {})
    },
    select: { id: true, slug: true, name: true, companyLogoUrl: true, partnershipsEnabled: true, partnerHostedBaseUrl: true }
  });
}

export const partnerPublicService = {
  async getLanding({ tenantId, tenantSlug, slug, countVisit = true } = {}) {
    const tenant = await resolveTenant({ tenantId, tenantSlug });
    if (!tenant) return { ok: false, reason: 'TENANT_NOT_FOUND' };
    if (!tenant.partnershipsEnabled) return { ok: false, reason: 'MODULE_DISABLED' };

    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug) return { ok: false, reason: 'PARTNER_NOT_FOUND' };
    const partner = await prisma.partner.findFirst({
      where: { tenantId: tenant.id, slug: cleanSlug },
      include: {
        services: {
          orderBy: [{ sortOrder: 'asc' }],
          include: {
            additionalService: {
              select: { id: true, code: true, name: true, description: true, displayDescription: true, rate: true, dailyRate: true, chargeType: true, unitLabel: true, taxable: true, isActive: true, partnerId: true }
            }
          }
        },
        rate: { select: { id: true, rateItems: { select: { vehicleTypeId: true, daily: true, weekly: true, monthly: true } } } }
      }
    });
    if (!partner) return { ok: false, reason: 'PARTNER_NOT_FOUND' };

    const status = effectiveStatus(partner);
    if (status !== 'ACTIVE') return { ok: false, reason: status, partner: { name: partner.name, slug: partner.slug } };

    // Locations in scope (all active locations of the tenant unless the program narrows them).
    const scopedIds = Array.isArray(partner.locationIds) ? partner.locationIds.map(String) : null;
    const locations = await prisma.location.findMany({
      where: { tenantId: tenant.id, isActive: true, ...(scopedIds?.length ? { id: { in: scopedIds } } : {}) },
      select: { id: true, code: true, name: true, address: true, city: true, state: true },
      orderBy: [{ name: 'asc' }]
    });

    // Vehicle types the program can show / offer as a preference.
    const priced = new Map((partner.rate?.rateItems || []).filter((it) => num(it.daily) > 0).map((it) => [it.vehicleTypeId, it]));
    // Discount mode has no book of its own: the landing's "from" price is the tenant's
    // ONLINE rental rate with the program % applied (lowest daily per class across the
    // program's locations). Display-only — rental-search re-prices every real quote.
    const discountPct = !partner.rateId ? num(partner.discountPct) : 0;
    const discounted = new Map();
    if (discountPct > 0) {
      const onlineItems = await prisma.rateItem.findMany({
        where: {
          daily: { gt: 0 },
          rate: {
            tenantId: tenant.id,
            purpose: 'RENTAL',
            displayOnline: true,
            isActive: true,
            ...(scopedIds?.length ? { OR: [{ locationId: { in: scopedIds } }, { locationId: null }] } : {})
          }
        },
        select: { vehicleTypeId: true, daily: true, weekly: true, monthly: true }
      });
      for (const it of onlineItems) {
        const prev = discounted.get(it.vehicleTypeId);
        if (!prev || num(it.daily) < num(prev.daily)) discounted.set(it.vehicleTypeId, it);
      }
    }
    const allowed = Array.isArray(partner.allowedVehicleTypeIds) ? partner.allowedVehicleTypeIds.map(String) : null;
    // Classes the program can actually price (a program price book, or the online book
    // in discount mode). A preference the search would refuse (no price → dropped by
    // searchRental) is never offered on the landing (Innovation F2 #3).
    const priceable = partner.rateId ? new Set(priced.keys()) : new Set(discounted.keys());
    const typeWhere = { tenantId: tenant.id };
    if (partner.vehicleMode === 'PREFERRED_TYPE') typeWhere.id = { in: (allowed || []).filter((id) => priceable.has(id)) };
    else if (partner.vehicleMode === 'ASSIGN_AT_PICKUP') typeWhere.id = partner.defaultVehicleTypeId || '__none__';
    else if (partner.rateId) typeWhere.id = { in: [...priced.keys()].filter((id) => !allowed || allowed.includes(id)) };
    else if (allowed) typeWhere.id = { in: allowed.filter((id) => priceable.has(id)) };
    else if (!partner.rateId) typeWhere.id = { in: [...priceable] };
    const types = await prisma.vehicleType.findMany({
      where: typeWhere,
      select: { id: true, code: true, name: true, description: true, imageUrl: true, passengers: true, bags: true, doors: true, transmission: true },
      orderBy: [{ name: 'asc' }]
    });

    if (countVisit) {
      prisma.partner.update({ where: { id: partner.id }, data: { visitCount: { increment: 1 }, lastVisitAt: new Date() } })
        .catch((err) => logger.warn('[partnerships] visit count failed', { partnerId: partner.id, error: String(err?.message || err) }));
    }

    const url = hostedUrl({
      hostedBaseUrl: tenant.partnerHostedBaseUrl,
      appBaseUrl: process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL || 'https://ridefleetmanager.com',
      tenantSlug: tenant.slug,
      slug: partner.slug
    });

    return {
      ok: true,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, logoUrl: tenant.companyLogoUrl || null },
      partner: {
        id: partner.id,
        slug: partner.slug,
        code: partner.code,
        kind: partner.kind,
        name: partner.name,
        logoUrl: logoPublicUrl(partner.logoRef),
        validFrom: partner.validFrom,
        validTo: partner.validTo,
        // Partner contact (name/email/phone) is the account-manager record for
        // RFM staff — deliberately NOT public. The landing shows the TENANT's contact.
        landing: partner.landingJson || { es: {}, en: {} },
        terms: partner.termsJson || { es: '', en: '' },
        termsVersion: partner.termsVersion,
        showTenantTerms: !!partner.showTenantTerms,
        showTenantContact: !!partner.showTenantContact,
        pricing: partner.rateId ? { mode: 'RATE' } : { mode: 'DISCOUNT', discountPct: num(partner.discountPct) },
        vehicleMode: partner.vehicleMode,
        preferredTypePricing: partner.preferredTypePricing,
        askPolicyNumber: !!partner.askPolicyNumber,
        coverageDisclosure: partner.vehicleMode === 'PREFERRED_TYPE' ? (partner.coverageDisclosureJson || { es: '', en: '' }) : null,
        coverageDisclosureVersion: partner.coverageDisclosureVersion,
        defaultVehicleTypeId: partner.defaultVehicleTypeId || null,
        hostedUrl: url
      },
      vehicleTypes: types.map((vt) => {
        const it = priced.get(vt.id);
        if (it) {
          return { ...vt, programDaily: num(it.daily), programWeekly: num(it.weekly), programMonthly: num(it.monthly) };
        }
        const on = discounted.get(vt.id);
        // Discount mode: online rate minus the program % ("from" price; quotes re-price live).
        // Weekly/monthly are discounted only when the online book publishes them.
        return {
          ...vt,
          programDaily: on ? applyDiscount(on.daily, discountPct) : null,
          programWeekly: on && num(on.weekly) > 0 ? applyDiscount(on.weekly, discountPct) : null,
          programMonthly: on && num(on.monthly) > 0 ? applyDiscount(on.monthly, discountPct) : null
        };
      }),
      services: partner.services
        .filter((row) => row.additionalService && row.additionalService.isActive)
        .map((row) => ({
          id: row.additionalService.id,
          code: row.additionalService.code,
          name: row.additionalService.name,
          description: row.additionalService.displayDescription || row.additionalService.description || '',
          chargeType: row.additionalService.chargeType,
          unitLabel: row.additionalService.unitLabel,
          taxable: !!row.additionalService.taxable,
          listRate: num(row.additionalService.rate),
          programRate: row.rateOverride === null || row.rateOverride === undefined ? num(row.additionalService.rate) : num(row.rateOverride),
          mandatory: !!row.mandatory,
          partnerOnly: !!row.additionalService.partnerId
        })),
      locations
    };
  }
};
