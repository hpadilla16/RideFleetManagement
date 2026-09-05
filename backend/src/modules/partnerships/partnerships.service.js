/**
 * Partnerships module — admin service (2026-09-05).
 * Plan: doc/partnerships-module-plan-2026-09-05.md · Mockups: doc/partnerships-module-mockups-2026-09-05.html
 *
 * A Partner is a tenant's commercial alliance (insurer, co-op, hotel…) with its
 * own terms, price book, service catalog and a hosted landing page + QR.
 *
 * Money boundaries (Hector's hard rules):
 *   - The price book is a plain Rate with purpose = PARTNER. All arithmetic stays in
 *     rates.service.js / booking-engine — this file only creates and edits rows.
 *   - Nothing here touches payments. Reservation attribution (partnerId) is stamped by
 *     the public checkout in F2; F1 ships the admin + the public landing only.
 *
 * Isolation: every query is tenant-scoped through `ctx.tenantId`; a partner that
 * belongs to another tenant is a 404, never a 403 (no existence oracle).
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { AppError, NotFoundError, ValidationError, ConflictError } from '../../lib/errors.js';
import { isStorageEnabled } from '../rental-agreements/inspection-photos.js';
import { safePath, uploadObject, getPublicUrl } from '../../lib/storage/supabase-storage.js';
import {
  sanitizeLandingJson,
  sanitizeLocalizedHtml,
  sanitizePartnerText
} from './partner-sanitize.js';
import {
  PARTNER_KINDS,
  PARTNER_STATUSES,
  VEHICLE_MODES,
  PREFERRED_TYPE_PRICING,
  normalizeSlug,
  normalizeProgramCode,
  partnerRateCode,
  effectiveStatus,
  publishReadiness,
  hostedUrl,
  qrUrl,
  defaultCoverageDisclosure
} from './partner-rules.js';

// Public bucket: a partner logo is marketing, not PII, and the landing payload is
// cacheable — a signed URL would go stale. Constant on purpose (no new env key:
// env-diff-check.sh fails closed on keys missing from the droplet .env).
export const PARTNER_ASSETS_BUCKET = 'partner-assets';
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
// No SVG in F1: an SVG served from the public bucket executes on the storage origin
// when opened directly, and a regex is not a sanitizer. Raster only.
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const PARTNER_SELECT = {
  id: true, tenantId: true, slug: true, code: true, kind: true, name: true, logoRef: true, status: true,
  validFrom: true, validTo: true, contactName: true, contactEmail: true, contactPhone: true,
  landingJson: true, termsJson: true, termsVersion: true, showTenantTerms: true, showTenantContact: true,
  rateId: true, discountPct: true, vehicleMode: true, allowedVehicleTypeIds: true, defaultVehicleTypeId: true,
  coverageDisclosureJson: true, coverageDisclosureVersion: true, preferredTypePricing: true, askPolicyNumber: true,
  locationIds: true, visitCount: true, lastVisitAt: true, createdBy: true, createdAt: true, updatedAt: true
};

function appBaseUrl() {
  // Same pair the rest of the backend uses for links that land on the RFM frontend.
  return String(process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL || 'https://ridefleetmanager.com');
}

export function logoPublicUrl(logoRef) {
  const ref = String(logoRef || '');
  const idx = ref.indexOf(':');
  if (idx <= 0) return null;
  try {
    return getPublicUrl({ bucket: ref.slice(0, idx), path: ref.slice(idx + 1) });
  } catch {
    return null;
  }
}

function requireTenant(ctx) {
  const tenantId = ctx?.tenantId ? String(ctx.tenantId) : null;
  if (!tenantId) throw new ValidationError('tenantId is required (super-admin must pass ?tenantId=)');
  return tenantId;
}

function decimalToNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function idList(value) {
  if (!Array.isArray(value)) return null;
  const clean = [...new Set(value.map((v) => String(v || '').trim()).filter(Boolean))];
  return clean.length ? clean : null;
}

async function audit({ tenantId, partnerId, actor, action, changed }) {
  try {
    await prisma.partnerAuditLog.create({
      data: {
        tenantId,
        partnerId,
        actorUserId: actor?.sub || actor?.id || null,
        actorRole: actor?.role ? String(actor.role).toUpperCase() : null,
        action,
        changed: changed ?? {}
      }
    });
  } catch (err) {
    logger.warn('[partnerships] audit write failed', { partnerId, action, error: String(err?.message || err) });
  }
}

async function loadPartner(id, tenantId) {
  const row = await prisma.partner.findFirst({ where: { id: String(id || ''), tenantId }, select: PARTNER_SELECT });
  if (!row) throw new NotFoundError('Partner not found');
  return row;
}

async function tenantHostedBase(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true, partnerHostedBaseUrl: true, partnershipsEnabled: true, companyLogoUrl: true, name: true }
  });
  return tenant || { slug: '', partnerHostedBaseUrl: null };
}

/**
 * Classes the partner book can actually quote: items with daily > 0 on a rate
 * that is ACTIVE (resolveForRental requires isActive && active — a detached and
 * re-linked book that stayed inactive must not count as "priced").
 */
async function pricedClassCount(rateId) {
  if (!rateId) return 0;
  return prisma.rateItem.count({ where: { rateId, daily: { gt: 0 }, rate: { isActive: true, active: true, purpose: 'PARTNER' } } });
}

/**
 * An ACTIVE program must stay publishable. After any mutation that can hollow it
 * out (price book detached, every class unpriced, kind changed away from INSURANCE
 * while in PREFERRED_TYPE…) re-check readiness and auto-PAUSE with an audit row
 * rather than serving a live program with nothing to sell.
 */
async function enforceReadiness(partnerId, tenantId, actor) {
  const partner = await loadPartner(partnerId, tenantId);
  if (partner.status !== 'ACTIVE') return partner;
  const readiness = publishReadiness(partner, { pricedClassCount: await pricedClassCount(partner.rateId) });
  if (readiness.ready) return partner;
  await prisma.partner.update({ where: { id: partner.id }, data: { status: 'PAUSED' } });
  await audit({ tenantId, partnerId: partner.id, actor, action: 'STATUS', changed: { from: 'ACTIVE', to: 'PAUSED', reason: 'AUTO_PAUSE_NOT_READY', missing: readiness.missing } });
  logger.warn('[partnerships] auto-paused: program no longer publishable', { partnerId: partner.id, missing: readiness.missing });
  return { ...partner, status: 'PAUSED' };
}

async function decorate(partner, tenant) {
  const [priced, serviceCount, bookings30d] = await Promise.all([
    pricedClassCount(partner.rateId),
    prisma.partnerService.count({ where: { partnerId: partner.id } }),
    prisma.reservation.count({ where: { partnerId: partner.id, createdAt: { gte: new Date(Date.now() - 30 * 86400000) } } })
  ]);
  const readiness = publishReadiness(partner, { pricedClassCount: priced, serviceCount });
  const url = hostedUrl({ hostedBaseUrl: tenant?.partnerHostedBaseUrl, appBaseUrl: appBaseUrl(), tenantSlug: tenant?.slug, slug: partner.slug });
  return {
    ...partner,
    discountPct: decimalToNumber(partner.discountPct),
    logoUrl: logoPublicUrl(partner.logoRef),
    effectiveStatus: effectiveStatus(partner),
    pricedClassCount: priced,
    serviceCount,
    bookings30d,
    readiness,
    hostedUrl: url,
    qrUrl: qrUrl(url),
    hostedIsTenantDomain: !!tenant?.partnerHostedBaseUrl
  };
}

function assertEnum(value, allowed, label) {
  const v = String(value || '').toUpperCase();
  if (!allowed.includes(v)) throw new ValidationError(`${label} must be one of ${allowed.join(', ')}`);
  return v;
}

function parseDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${label} is not a valid date`);
  return d;
}

export const partnershipsService = {
  // ---------------------------------------------------------------- settings
  async getSettings(ctx = {}) {
    const tenantId = requireTenant(ctx);
    const tenant = await tenantHostedBase(tenantId);
    return {
      partnershipsEnabled: !!tenant.partnershipsEnabled,
      partnerHostedBaseUrl: tenant.partnerHostedBaseUrl || null,
      fallbackBaseUrl: `${appBaseUrl().replace(/\/+$/, '')}/p/${encodeURIComponent(tenant.slug || '')}`
    };
  },

  async updateSettings(patch = {}, ctx = {}) {
    const tenantId = requireTenant(ctx);
    let base = patch?.partnerHostedBaseUrl === null || patch?.partnerHostedBaseUrl === undefined
      ? null
      : String(patch.partnerHostedBaseUrl).trim().replace(/\/+$/, '');
    if (base) {
      let parsed;
      try { parsed = new URL(base); } catch { parsed = null; }
      if (!parsed || parsed.protocol !== 'https:') throw new ValidationError('partnerHostedBaseUrl must be an https:// URL');
      if (parsed.search || parsed.hash) throw new ValidationError('partnerHostedBaseUrl must not carry a query string or fragment');
      base = parsed.toString().replace(/\/+$/, '');
    } else {
      base = null;
    }
    await prisma.tenant.update({ where: { id: tenantId }, data: { partnerHostedBaseUrl: base } });
    return this.getSettings(ctx);
  },

  // -------------------------------------------------------------------- list
  async list(ctx = {}) {
    const tenantId = requireTenant(ctx);
    const [rows, tenant] = await Promise.all([
      prisma.partner.findMany({ where: { tenantId }, select: PARTNER_SELECT, orderBy: [{ status: 'asc' }, { name: 'asc' }] }),
      tenantHostedBase(tenantId)
    ]);
    return Promise.all(rows.map((row) => decorate(row, tenant)));
  },

  async summary(ctx = {}) {
    const tenantId = requireTenant(ctx);
    const since = new Date(Date.now() - 30 * 86400000);
    const [active, bookings, visits, booked] = await Promise.all([
      prisma.partner.count({ where: { tenantId, status: 'ACTIVE' } }),
      prisma.reservation.count({ where: { tenantId, partnerId: { not: null }, createdAt: { gte: since } } }),
      prisma.partner.aggregate({ where: { tenantId }, _sum: { visitCount: true } }),
      prisma.reservation.aggregate({
        where: { tenantId, partnerId: { not: null }, createdAt: { gte: since }, status: { notIn: ['CANCELLED'] } },
        _sum: { estimatedTotal: true }
      })
    ]);
    return {
      activePrograms: active,
      bookings30d: bookings,
      // Estimated (reservation totals), NOT collected money — beta.296 rule.
      bookedEstimate30d: decimalToNumber(booked?._sum?.estimatedTotal) || 0,
      visitsTotal: visits?._sum?.visitCount || 0
    };
  },

  // ------------------------------------------------------------------ detail
  async getById(id, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    const tenant = await tenantHostedBase(tenantId);
    const [services, rate, auditLogs] = await Promise.all([
      prisma.partnerService.findMany({
        where: { partnerId: partner.id },
        include: { additionalService: { select: { id: true, code: true, name: true, rate: true, dailyRate: true, chargeType: true, unitLabel: true, mandatory: true, taxable: true, partnerId: true, isActive: true } } },
        orderBy: [{ sortOrder: 'asc' }]
      }),
      partner.rateId
        ? prisma.rate.findUnique({ where: { id: partner.rateId }, include: { rateItems: { orderBy: { sortOrder: 'asc' } } } })
        : null,
      prisma.partnerAuditLog.findMany({ where: { partnerId: partner.id }, orderBy: { createdAt: 'desc' }, take: 25 })
    ]);
    const decorated = await decorate(partner, tenant);
    return {
      ...decorated,
      services: services.map((row) => ({
        id: row.id,
        additionalServiceId: row.additionalServiceId,
        rateOverride: decimalToNumber(row.rateOverride),
        mandatory: !!row.mandatory,
        sortOrder: row.sortOrder,
        service: row.additionalService
          ? { ...row.additionalService, rate: decimalToNumber(row.additionalService.rate), dailyRate: decimalToNumber(row.additionalService.dailyRate), partnerOnly: !!row.additionalService.partnerId }
          : null
      })),
      rate: rate
        ? {
            id: rate.id, rateCode: rate.rateCode, purpose: rate.purpose, displayOnline: rate.displayOnline,
            items: rate.rateItems.map((it) => ({
              vehicleTypeId: it.vehicleTypeId,
              daily: decimalToNumber(it.daily), weekly: decimalToNumber(it.weekly), monthly: decimalToNumber(it.monthly)
            }))
          }
        : null,
      auditLogs
    };
  },

  // ------------------------------------------------------------------ create
  async create(data = {}, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const name = sanitizePartnerText(data.name, { maxLength: 120 });
    if (!name) throw new ValidationError('name is required');
    const slug = normalizeSlug(data.slug || name);
    if (!slug) throw new ValidationError('slug is required');
    const code = normalizeProgramCode(data.code || slug.replace(/-/g, '').slice(0, 8));
    if (!code) throw new ValidationError('code must be 3-16 letters or digits');
    const kind = data.kind ? assertEnum(data.kind, PARTNER_KINDS, 'kind') : 'OTHER';

    const [slugTaken, codeTaken] = await Promise.all([
      prisma.partner.findFirst({ where: { tenantId, slug }, select: { id: true } }),
      prisma.partner.findFirst({ where: { tenantId, code }, select: { id: true } })
    ]);
    if (slugTaken) throw new ConflictError(`A partner with slug "${slug}" already exists`);
    if (codeTaken) throw new ConflictError(`A partner with program code "${code}" already exists`);

    const created = await prisma.partner.create({
      data: {
        tenantId, slug, code, kind, name,
        status: 'DRAFT',
        landingJson: sanitizeLandingJson({ es: { heroTitle: name }, en: { heroTitle: name } }),
        termsJson: sanitizeLocalizedHtml({}),
        coverageDisclosureJson: kind === 'INSURANCE' ? sanitizeLocalizedHtml(defaultCoverageDisclosure(name)) : null,
        createdBy: ctx?.actor?.sub || ctx?.actor?.id || null
      },
      select: PARTNER_SELECT
    });
    await audit({ tenantId, partnerId: created.id, actor: ctx.actor, action: 'CREATE', changed: { name, slug, code, kind } });
    return this.getById(created.id, ctx);
  },

  // ------------------------------------------------------------------ update
  async update(id, patch = {}, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const before = await loadPartner(id, tenantId);
    const data = {};
    const changed = {};
    const locked = before.status !== 'DRAFT'; // slug/code are printed on QR once published

    if (patch.name !== undefined) {
      const name = sanitizePartnerText(patch.name, { maxLength: 120 });
      if (!name) throw new ValidationError('name is required');
      data.name = name;
    }
    if (patch.slug !== undefined) {
      const slug = normalizeSlug(patch.slug);
      if (!slug) throw new ValidationError('slug is required');
      if (slug !== before.slug) {
        if (locked) throw new ConflictError('slug is locked once the program has been published (it is printed on QR codes)');
        const taken = await prisma.partner.findFirst({ where: { tenantId, slug, id: { not: before.id } }, select: { id: true } });
        if (taken) throw new ConflictError(`A partner with slug "${slug}" already exists`);
        data.slug = slug;
      }
    }
    if (patch.code !== undefined) {
      const code = normalizeProgramCode(patch.code);
      if (!code) throw new ValidationError('code must be 3-16 letters or digits');
      if (code !== before.code) {
        if (locked) throw new ConflictError('program code is locked once the program has been published');
        const taken = await prisma.partner.findFirst({ where: { tenantId, code, id: { not: before.id } }, select: { id: true } });
        if (taken) throw new ConflictError(`A partner with program code "${code}" already exists`);
        data.code = code;
      }
    }
    if (patch.kind !== undefined) data.kind = assertEnum(patch.kind, PARTNER_KINDS, 'kind');
    if (patch.validFrom !== undefined) data.validFrom = parseDate(patch.validFrom, 'validFrom');
    if (patch.validTo !== undefined) data.validTo = parseDate(patch.validTo, 'validTo');
    const from = data.validFrom !== undefined ? data.validFrom : before.validFrom;
    const to = data.validTo !== undefined ? data.validTo : before.validTo;
    if (from && to && to < from) throw new ValidationError('validTo must be after validFrom');

    for (const key of ['contactName', 'contactEmail', 'contactPhone']) {
      if (patch[key] !== undefined) data[key] = sanitizePartnerText(patch[key], { maxLength: 160 }) || null;
    }
    if (patch.showTenantTerms !== undefined) data.showTenantTerms = !!patch.showTenantTerms;
    if (patch.showTenantContact !== undefined) data.showTenantContact = !!patch.showTenantContact;
    if (patch.locationIds !== undefined) data.locationIds = idList(patch.locationIds);

    if (patch.landingJson !== undefined) data.landingJson = sanitizeLandingJson(patch.landingJson);
    if (patch.termsJson !== undefined) {
      const terms = sanitizeLocalizedHtml(patch.termsJson);
      const prev = before.termsJson || {};
      if (terms.es !== String(prev.es || '') || terms.en !== String(prev.en || '')) {
        data.termsJson = terms;
        data.termsVersion = (before.termsVersion || 1) + 1;
        changed.termsVersion = data.termsVersion;
      }
    }

    // Pricing mode is ONE of {price book, discount}. The resolver uses rateId when
    // set, so a discount can only be stored when the partner has NO book —
    // detach the book first (detachRate), then set the percentage.
    if (patch.discountPct !== undefined) {
      if (patch.discountPct === null || patch.discountPct === '') data.discountPct = null;
      else {
        if (before.rateId) throw new ConflictError('This partner has its own price book — detach it before setting a discount');
        const pct = Number(patch.discountPct);
        if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) throw new ValidationError('discountPct must be between 0 and 100');
        data.discountPct = pct;
      }
    }

    // Vehicles ("show inventory" switch + insurance preference flow).
    if (patch.vehicleMode !== undefined) {
      const mode = assertEnum(patch.vehicleMode, VEHICLE_MODES, 'vehicleMode');
      const kind = data.kind || before.kind;
      if (mode === 'PREFERRED_TYPE' && kind !== 'INSURANCE') {
        throw new ValidationError('PREFERRED_TYPE is only available for INSURANCE partners');
      }
      data.vehicleMode = mode;
    }
    if (patch.allowedVehicleTypeIds !== undefined) data.allowedVehicleTypeIds = idList(patch.allowedVehicleTypeIds);
    if (patch.defaultVehicleTypeId !== undefined) data.defaultVehicleTypeId = patch.defaultVehicleTypeId ? String(patch.defaultVehicleTypeId) : null;
    if (patch.coverageDisclosureJson !== undefined) {
      const disclosure = sanitizeLocalizedHtml(patch.coverageDisclosureJson);
      const prev = before.coverageDisclosureJson || {};
      if (disclosure.es !== String(prev.es || '') || disclosure.en !== String(prev.en || '')) {
        data.coverageDisclosureJson = disclosure;
        data.coverageDisclosureVersion = (before.coverageDisclosureVersion || 1) + 1;
      }
    }
    if (patch.preferredTypePricing !== undefined) data.preferredTypePricing = assertEnum(patch.preferredTypePricing, PREFERRED_TYPE_PRICING, 'preferredTypePricing');
    if (patch.askPolicyNumber !== undefined) data.askPolicyNumber = !!patch.askPolicyNumber;

    // Validate vehicle-type ids belong to the tenant (fail closed on foreign ids).
    const typeIds = [
      ...(data.allowedVehicleTypeIds || []),
      ...(data.defaultVehicleTypeId ? [data.defaultVehicleTypeId] : [])
    ];
    if (typeIds.length) {
      const found = await prisma.vehicleType.findMany({ where: { tenantId, id: { in: typeIds } }, select: { id: true } });
      const known = new Set(found.map((r) => r.id));
      const foreign = typeIds.filter((tid) => !known.has(tid));
      if (foreign.length) throw new ValidationError(`Unknown vehicle type id(s): ${foreign.join(', ')}`);
    }
    if (data.locationIds) {
      const found = await prisma.location.findMany({ where: { tenantId, id: { in: data.locationIds } }, select: { id: true } });
      if (found.length !== data.locationIds.length) throw new ValidationError('locationIds contains a location that is not yours');
    }

    if (!Object.keys(data).length) return this.getById(before.id, ctx);
    await prisma.partner.update({ where: { id: before.id }, data });
    for (const key of Object.keys(data)) {
      if (['landingJson', 'termsJson', 'coverageDisclosureJson'].includes(key)) changed[key] = 'edited';
      else changed[key] = { from: before[key] ?? null, to: data[key] ?? null };
    }
    await audit({ tenantId, partnerId: before.id, actor: ctx.actor, action: data.termsJson ? 'TERMS' : 'UPDATE', changed });
    await enforceReadiness(before.id, tenantId, ctx.actor);
    return this.getById(before.id, ctx);
  },

  // ------------------------------------------------------------------ status
  async setStatus(id, status, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    const next = assertEnum(status, PARTNER_STATUSES, 'status');
    if (next === partner.status) return this.getById(partner.id, ctx);
    // A published program never goes back to DRAFT: DRAFT is the only state in
    // which slug/code are editable, and both are printed on QR codes by then.
    if (next === 'DRAFT') throw new ConflictError('A program cannot go back to draft once published — pause it instead');
    if (next === 'ACTIVE') {
      const readiness = publishReadiness(partner, { pricedClassCount: await pricedClassCount(partner.rateId) });
      if (!readiness.ready) {
        throw new AppError(`Cannot publish: missing ${readiness.missing.join(', ')}`, 422);
      }
    }
    await prisma.partner.update({ where: { id: partner.id }, data: { status: next } });
    await audit({ tenantId, partnerId: partner.id, actor: ctx.actor, action: 'STATUS', changed: { from: partner.status, to: next } });
    return this.getById(partner.id, ctx);
  },

  // -------------------------------------------------------------------- rate
  /**
   * Create (or return) the partner's price book: one Rate, purpose PARTNER,
   * locationId null (Partner.locationIds gates sedes), every weekday on,
   * displayOnline false (belt; purpose is the lock). Optionally seed the
   * per-class items from the ONLINE rate of one location so the admin edits
   * numbers instead of typing them from scratch.
   */
  async ensureRate(id, { copyFromLocationId = null } = {}, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    if (partner.rateId) return this.getById(partner.id, ctx);

    const rateCode = partnerRateCode(partner.slug);
    const existing = await prisma.rate.findFirst({ where: { tenantId, rateCode }, select: { id: true, purpose: true } });
    if (existing && existing.purpose !== 'PARTNER') {
      throw new ConflictError(`Rate code ${rateCode} already exists with purpose ${existing.purpose}`);
    }

    let seed = [];
    if (copyFromLocationId) {
      const online = await prisma.rate.findFirst({
        where: {
          tenantId, purpose: 'RENTAL', isActive: true, active: true, displayOnline: true,
          OR: [{ locationId: String(copyFromLocationId) }, { locationIds: { contains: String(copyFromLocationId) } }]
        },
        include: { rateItems: true },
        orderBy: [{ updatedAt: 'desc' }]
      });
      seed = (online?.rateItems || []).map((it, idx) => ({
        vehicleTypeId: it.vehicleTypeId, daily: it.daily, weekly: it.weekly, monthly: it.monthly, sortOrder: idx
      }));
    }

    const rate = existing
      // Re-linking a detached book: detachRate deactivated it, and the resolver
      // requires isActive && active — reactivate or every class quotes null.
      ? await prisma.rate.update({ where: { id: existing.id }, data: { active: true, isActive: true, displayOnline: false } })
      : await prisma.rate.create({
          data: {
            tenantId, rateCode, name: `Partner · ${partner.name}`, purpose: 'PARTNER',
            locationId: null, displayOnline: false, active: true, isActive: true,
            ...(seed.length ? { rateItems: { create: seed } } : {})
          }
        });

    await prisma.partner.update({ where: { id: partner.id }, data: { rateId: rate.id, discountPct: null } });
    await audit({ tenantId, partnerId: partner.id, actor: ctx.actor, action: 'PRICING', changed: { rateId: rate.id, seededFrom: copyFromLocationId || null, seededClasses: seed.length } });
    return this.getById(partner.id, ctx);
  },

  /** Drop the price book (switch to discount mode). The Rate row is deactivated, not deleted. */
  async detachRate(id, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    if (!partner.rateId) return this.getById(partner.id, ctx);
    await prisma.$transaction([
      prisma.rate.update({ where: { id: partner.rateId }, data: { active: false, isActive: false } }),
      prisma.partner.update({ where: { id: partner.id }, data: { rateId: null } })
    ]);
    await audit({ tenantId, partnerId: partner.id, actor: ctx.actor, action: 'PRICING', changed: { rateId: { from: partner.rateId, to: null } } });
    await enforceReadiness(partner.id, tenantId, ctx.actor);
    return this.getById(partner.id, ctx);
  },

  /**
   * Upsert the per-class prices. `items` = [{vehicleTypeId, daily, weekly, monthly}].
   * daily <= 0 REMOVES the class from the book (fail-closed: no item → not offered).
   */
  async setRateItems(id, items = [], ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    if (!partner.rateId) throw new ValidationError('Create the partner price book first');
    if (!Array.isArray(items)) throw new ValidationError('items must be an array');
    const typeIds = [...new Set(items.map((it) => String(it?.vehicleTypeId || '')).filter(Boolean))];
    const known = new Set((await prisma.vehicleType.findMany({ where: { tenantId, id: { in: typeIds } }, select: { id: true } })).map((r) => r.id));
    const before = await prisma.rateItem.findMany({ where: { rateId: partner.rateId }, select: { vehicleTypeId: true, daily: true, weekly: true, monthly: true } });

    const ops = [];
    let idx = 0;
    for (const it of items) {
      const vehicleTypeId = String(it?.vehicleTypeId || '');
      if (!known.has(vehicleTypeId)) throw new ValidationError(`Unknown vehicle type id: ${vehicleTypeId}`);
      const daily = Number(it?.daily ?? 0);
      const weekly = Number(it?.weekly ?? 0);
      const monthly = Number(it?.monthly ?? 0);
      for (const [label, v] of [['daily', daily], ['weekly', weekly], ['monthly', monthly]]) {
        if (!Number.isFinite(v) || v < 0 || v > 100000) throw new ValidationError(`${label} for ${vehicleTypeId} is out of range`);
      }
      if (daily <= 0) {
        ops.push(prisma.rateItem.deleteMany({ where: { rateId: partner.rateId, vehicleTypeId } }));
      } else {
        ops.push(prisma.rateItem.upsert({
          where: { rateId_vehicleTypeId: { rateId: partner.rateId, vehicleTypeId } },
          create: { rateId: partner.rateId, vehicleTypeId, daily, weekly, monthly, sortOrder: idx },
          update: { daily, weekly, monthly, sortOrder: idx }
        }));
      }
      idx += 1;
    }
    if (ops.length) await prisma.$transaction(ops);
    await audit({
      tenantId, partnerId: partner.id, actor: ctx.actor, action: 'PRICING',
      changed: {
        before: before.map((b) => ({ vehicleTypeId: b.vehicleTypeId, daily: decimalToNumber(b.daily), weekly: decimalToNumber(b.weekly), monthly: decimalToNumber(b.monthly) })),
        after: items.map((it) => ({ vehicleTypeId: String(it?.vehicleTypeId || ''), daily: Number(it?.daily ?? 0), weekly: Number(it?.weekly ?? 0), monthly: Number(it?.monthly ?? 0) }))
      }
    });
    await enforceReadiness(partner.id, tenantId, ctx.actor);
    return this.getById(partner.id, ctx);
  },

  /** The editor grid: every class of the tenant × (online daily at a location, partner daily). */
  async pricingGrid(id, { locationId = null } = {}, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    const [types, partnerItems, online] = await Promise.all([
      prisma.vehicleType.findMany({ where: { tenantId }, select: { id: true, code: true, name: true }, orderBy: [{ name: 'asc' }] }),
      partner.rateId ? prisma.rateItem.findMany({ where: { rateId: partner.rateId } }) : [],
      prisma.rate.findFirst({
        where: {
          tenantId, purpose: 'RENTAL', isActive: true, active: true, displayOnline: true,
          ...(locationId ? { OR: [{ locationId: String(locationId) }, { locationIds: { contains: String(locationId) } }] } : {})
        },
        include: { rateItems: true },
        orderBy: [{ locationId: 'desc' }, { updatedAt: 'desc' }]
      })
    ]);
    const onlineByType = new Map((online?.rateItems || []).map((it) => [it.vehicleTypeId, it]));
    const partnerByType = new Map(partnerItems.map((it) => [it.vehicleTypeId, it]));
    return {
      partnerId: partner.id,
      rateId: partner.rateId,
      discountPct: decimalToNumber(partner.discountPct),
      onlineRate: online ? { id: online.id, rateCode: online.rateCode, locationId: online.locationId } : null,
      rows: types.map((vt) => {
        const on = onlineByType.get(vt.id);
        const pt = partnerByType.get(vt.id);
        return {
          vehicleTypeId: vt.id, code: vt.code, name: vt.name,
          onlineDaily: on ? decimalToNumber(on.daily) : null,
          daily: pt ? decimalToNumber(pt.daily) : null,
          weekly: pt ? decimalToNumber(pt.weekly) : null,
          monthly: pt ? decimalToNumber(pt.monthly) : null
        };
      })
    };
  },

  // ---------------------------------------------------------------- services
  /** Replace the program's service set. rows = [{additionalServiceId, rateOverride, mandatory, sortOrder}]. */
  async setServices(id, rows = [], ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    if (!Array.isArray(rows)) throw new ValidationError('services must be an array');
    const ids = [...new Set(rows.map((r) => String(r?.additionalServiceId || '')).filter(Boolean))];
    const found = await prisma.additionalService.findMany({
      where: { tenantId, id: { in: ids }, OR: [{ partnerId: null }, { partnerId: partner.id }] },
      select: { id: true }
    });
    const known = new Set(found.map((r) => r.id));
    const foreign = ids.filter((sid) => !known.has(sid));
    if (foreign.length) throw new ValidationError(`Unknown service id(s): ${foreign.join(', ')}`);

    const data = rows.map((r, idx) => {
      const override = r?.rateOverride === null || r?.rateOverride === undefined || r?.rateOverride === '' ? null : Number(r.rateOverride);
      if (override !== null && (!Number.isFinite(override) || override < 0 || override > 100000)) throw new ValidationError('rateOverride out of range');
      return { partnerId: partner.id, additionalServiceId: String(r.additionalServiceId), rateOverride: override, mandatory: !!r?.mandatory, sortOrder: Number.isFinite(Number(r?.sortOrder)) ? Number(r.sortOrder) : idx };
    });
    await prisma.$transaction([
      prisma.partnerService.deleteMany({ where: { partnerId: partner.id } }),
      ...(data.length ? [prisma.partnerService.createMany({ data })] : [])
    ]);
    await audit({ tenantId, partnerId: partner.id, actor: ctx.actor, action: 'SERVICES', changed: { services: data.map((d) => ({ id: d.additionalServiceId, rateOverride: d.rateOverride, mandatory: d.mandatory })) } });
    return this.getById(partner.id, ctx);
  },

  /** A service that exists ONLY for this program (AdditionalService.partnerId). Never displayOnline. */
  async createCustomService(id, data = {}, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    const name = sanitizePartnerText(data.name, { maxLength: 120 });
    if (!name) throw new ValidationError('name is required');
    const rate = Number(data.rate ?? 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100000) throw new ValidationError('rate out of range');
    const chargeType = ['UNIT', 'PER_DAY', 'PERCENTAGE'].includes(String(data.chargeType || '').toUpperCase()) ? String(data.chargeType).toUpperCase() : 'UNIT';
    const service = await prisma.additionalService.create({
      data: {
        tenantId, partnerId: partner.id, name,
        code: sanitizePartnerText(data.code, { maxLength: 24 }) || null,
        description: sanitizePartnerText(data.description, { maxLength: 400 }) || null,
        chargeType, rate,
        dailyRate: chargeType === 'PER_DAY' ? rate : null,
        taxable: !!data.taxable,
        displayOnline: false, // partner-only: never on the public site
        isActive: true
      }
    });
    const count = await prisma.partnerService.count({ where: { partnerId: partner.id } });
    await prisma.partnerService.create({ data: { partnerId: partner.id, additionalServiceId: service.id, mandatory: !!data.mandatory, sortOrder: count } });
    await audit({ tenantId, partnerId: partner.id, actor: ctx.actor, action: 'SERVICES', changed: { createdService: { id: service.id, name, rate, chargeType } } });
    return this.getById(partner.id, ctx);
  },

  // -------------------------------------------------------------------- logo
  async saveLogo(id, dataUrl, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    if (!isStorageEnabled()) throw new AppError('Document storage is not enabled', 503);
    const match = /^data:([\w/.+-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!match) throw new ValidationError('logo must be a base64 data URL');
    const contentType = match[1].toLowerCase();
    const ext = LOGO_TYPES[contentType];
    if (!ext) throw new ValidationError('logo must be PNG, JPEG or WebP');
    const body = Buffer.from(match[2], 'base64');
    if (!body.length) throw new ValidationError('logo is empty');
    if (body.length > LOGO_MAX_BYTES) throw new ValidationError('logo exceeds 2MB');
    const path = safePath('partners', tenantId, partner.id, `logo-${Date.now()}.${ext}`);
    await uploadObject({ bucket: PARTNER_ASSETS_BUCKET, path, body, contentType, upsert: false });
    const logoRef = `${PARTNER_ASSETS_BUCKET}:${path}`;
    await prisma.partner.update({ where: { id: partner.id }, data: { logoRef } });
    await audit({ tenantId, partnerId: partner.id, actor: ctx.actor, action: 'LOGO', changed: { logoRef } });
    return { logoRef, logoUrl: logoPublicUrl(logoRef) };
  },

  // ------------------------------------------------------------------ hosted
  async hosted(id, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    const tenant = await tenantHostedBase(tenantId);
    const url = hostedUrl({ hostedBaseUrl: tenant.partnerHostedBaseUrl, appBaseUrl: appBaseUrl(), tenantSlug: tenant.slug, slug: partner.slug });
    return {
      url,
      qrUrl: qrUrl(url),
      published: partner.status === 'ACTIVE',
      effectiveStatus: effectiveStatus(partner),
      hostedIsTenantDomain: !!tenant.partnerHostedBaseUrl,
      visitCount: partner.visitCount,
      lastVisitAt: partner.lastVisitAt
    };
  },

  async reservations(id, ctx = {}) {
    const tenantId = requireTenant(ctx);
    const partner = await loadPartner(id, tenantId);
    const rows = await prisma.reservation.findMany({
      where: { partnerId: partner.id, tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, reservationNumber: true, status: true, pickupAt: true, returnAt: true, estimatedTotal: true,
        bookingChannel: true, partnerPreferredVehicleTypeId: true, createdAt: true,
        customer: { select: { id: true, firstName: true, lastName: true } },
        vehicleType: { select: { id: true, code: true, name: true } }
      }
    });
    return rows.map((r) => ({ ...r, estimatedTotal: decimalToNumber(r.estimatedTotal) }));
  }
};
