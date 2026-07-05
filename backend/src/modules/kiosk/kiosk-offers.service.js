/**
 * Ride Kiosk — upsell offers engine (Fase B2, 2026-07-05).
 * Spec: doc/kiosk-e2e-spec-2026-07-04.md (UpsellRule × AdditionalService × días × canal).
 *
 * Rules: UpsellRule per (tenant, channel) — channel normalized from
 * Reservation.bookingChannel, '*' = tenant default. Services in a rule's
 * prepaidServiceIds (what the broker already charged) are NEVER offered —
 * not as addons, not inside packages. Per-reservation prepaid hook: anything
 * already sitting on the reservation as a selected charge with the same
 * sourceRefId (from a non-kiosk source) is excluded too.
 *
 * Prices are ALWAYS computed server-side from the AdditionalService catalog
 * using the counter/website convention (computeAdditionalServiceLine in
 * booking-engine.service.js — mirrored in serviceOfferLine below):
 * dailyRate > 0 → PER_DAY (dailyRate × days × qty), else FLAT (rate × qty).
 *
 * Accept path writes ReservationCharge rows (source KIOSK_UPSELL,
 * sourceRefId = AdditionalService.id) and recomputes totals via
 * reservationPricingService.getPricing — the same recompute the counter
 * runs (mandatory fees + tolls sync + syncAgreementCharges + estimatedTotal).
 * Idempotent: re-POST replaces the reservation's prior KIOSK_UPSELL rows.
 *
 * Packages: AppSetting kioskPackagesConfig per tenant (scopedSettingKey) —
 * [{key: BASIC|RECOMMENDED|PREMIUM, name, serviceIds[]}], serviceIds
 * validated against the tenant's ACTIVE catalog on save (ids, never codes —
 * code is nullable/non-unique).
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { KioskError } from './kiosk-device.service.js';
import { getSessionForDevice, requireInProgress, recordSessionTelemetry } from './kiosk-session.service.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';
import { recomputeTaxRow } from '../reservations/reservation-extend.service.js';
import { scopedSettingKey } from '../../lib/module-access.js';

// KIOSK_UPSELL rows are excluded from commission matching BY DESIGN (there
// is no selling employee at a kiosk) and are pending inclusion in agreement
// serviceRevenue reporting in Fase B6 — per Hector, 2026-07-05.
export const KIOSK_UPSELL_SOURCE = 'KIOSK_UPSELL';
export const UPSELL_STRATEGIES = ['PACKAGES_3', 'UPGRADE_FIRST'];
export const PACKAGE_KEYS = ['BASIC', 'RECOMMENDED', 'PREMIUM'];
const PACKAGES_SETTING_KEY = 'kioskPackagesConfig';

// bookingChannel is free-ish text ('EXPEDIA', 'Expedia.com', 'STAFF',
// 'KIOSK_WALKUP', ...). Normalize case + brand-name variants ONLY — channels
// keep their identity (STAFF stays STAFF, KIOSK_WALKUP stays KIOSK_WALKUP)
// so a tenant can define a per-channel rule for any of them later; anything
// without a rule falls back to '*' in loadRuleForChannel.
const CHANNEL_ALIASES = {
  EXPEDIA: 'EXPEDIA',
  PRICELINE: 'PRICELINE',
};

export function normalizeChannel(bookingChannel) {
  const raw = String(bookingChannel || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (!raw) return '*';
  if (CHANNEL_ALIASES[raw]) return CHANNEL_ALIASES[raw];
  const prefix = Object.keys(CHANNEL_ALIASES).find((key) => raw.startsWith(`${key}_`));
  return prefix ? CHANNEL_ALIASES[prefix] : raw;
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

// Same convention as reservation-pricing.service rentalDays().
function rentalDays(pickupAt, returnAt) {
  const start = new Date(pickupAt || Date.now());
  const end = new Date(returnAt || Date.now());
  const diff = end.getTime() - start.getTime();
  return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)) || 1);
}

/**
 * Mirrors computeAdditionalServiceLine (booking-engine.service.js) — the
 * counter/website pricing math. Kept identical on purpose; the canonical
 * tests in kiosk-offers.test.mjs pin the numbers.
 */
export function serviceOfferLine(service, days) {
  const qty = Math.max(1, Number(service?.defaultQty ?? 1) || 1);
  const perDay = Number(service?.dailyRate || 0);
  const rate = perDay > 0 ? perDay : Number(service?.rate || 0);
  const total = perDay > 0 ? perDay * days * qty : Number(service?.rate || 0) * qty;
  return {
    serviceId: service.id,
    code: service.code || null,
    name: service.name,
    description: service.displayDescription || service.description || '',
    pricingMode: perDay > 0 ? 'PER_DAY' : 'FIXED',
    quantity: qty,
    days,
    rate: round2(rate),
    total: round2(total),
    taxable: !!service.taxable,
  };
}

function requireTenantId(scope = {}) {
  if (!scope?.tenantId) {
    throw new KioskError('A tenant scope is required (super-admins pass ?tenantId=)', 400, 'TENANT_SCOPE_REQUIRED');
  }
  return scope.tenantId;
}

// Active catalog, location-scoped like additionalServicesService.list:
// global (locationId null) + the device's pickup location.
//
// FAIL-CLOSED (B2 review): services with a linkedFee are EXCLUDED from the
// kiosk. The website auto-adds a SERVICE_LINKED_FEE line for them
// (booking-engine.service.js) and the kiosk doesn't yet — offering them
// here would undercharge vs every other channel. Full linked-fee support
// rides with Fase B3/B4.
async function loadActiveCatalog(tenantId, locationId) {
  const rows = await prisma.additionalService.findMany({
    where: {
      tenantId,
      isActive: true,
      ...(locationId ? { OR: [{ locationId }, { locationId: null }] } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  const linked = rows.filter((service) => service.linkedFeeId);
  if (linked.length) {
    logger.warn('[kiosk-offers] excluding linked-fee services from kiosk offers (unsupported until B3/B4)', {
      tenantId, serviceIds: linked.map((service) => service.id),
    });
  }
  return rows.filter((service) => !service.linkedFeeId);
}

async function loadRuleForChannel(tenantId, channel) {
  const exact = await prisma.upsellRule.findFirst({ where: { tenantId, channel, isActive: true } });
  if (exact) return exact;
  if (channel === '*') return null;
  return prisma.upsellRule.findFirst({ where: { tenantId, channel: '*', isActive: true } });
}

function normalizeIdList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((v) => String(v || '').trim()).filter(Boolean))];
}

async function assertServiceIdsInCatalog(tenantId, ids, label) {
  const clean = normalizeIdList(ids);
  if (!clean.length) return clean;
  const found = await prisma.additionalService.findMany({
    where: { tenantId, isActive: true, id: { in: clean } },
    select: { id: true },
  });
  const known = new Set(found.map((row) => row.id));
  const dangling = clean.filter((id) => !known.has(id));
  if (dangling.length) {
    throw new KioskError(
      `${label} contains unknown or inactive service ids: ${dangling.join(', ')}`,
      422,
      'UNKNOWN_SERVICE_IDS',
    );
  }
  return clean;
}

function packagesSettingKey(tenantId) {
  return scopedSettingKey(PACKAGES_SETTING_KEY, { tenantId });
}

async function readPackagesConfig(tenantId) {
  const row = await prisma.appSetting.findUnique({ where: { key: packagesSettingKey(tenantId) } });
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Resolve everything the offer/accept endpoints need for one session:
 * reservation (tenant-scoped), days, normalized channel, rule, catalog,
 * exclusions, offerable addon lines and computed packages.
 */
async function buildOfferContext(session, device) {
  if (!session.reservationId) {
    throw new KioskError('Attach a reservation first', 422, 'NO_RESERVATION_ATTACHED');
  }
  const resv = await prisma.reservation.findFirst({
    where: { id: session.reservationId, tenantId: device.tenantId },
    select: {
      id: true,
      bookingChannel: true,
      pickupAt: true,
      returnAt: true,
      pickupLocationId: true,
      pricingSnapshot: { select: { taxRate: true } },
      charges: { where: { selected: true }, select: { source: true, sourceRefId: true } },
    },
  });
  if (!resv) throw new KioskError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');

  const days = rentalDays(resv.pickupAt, resv.returnAt);
  const channel = normalizeChannel(resv.bookingChannel);
  const [rule, catalog, packagesConfig] = await Promise.all([
    loadRuleForChannel(device.tenantId, channel),
    loadActiveCatalog(device.tenantId, resv.pickupLocationId),
    readPackagesConfig(device.tenantId),
  ]);
  const catalogById = new Map(catalog.map((service) => [service.id, service]));

  // NEVER offer: the rule's prepaid list (broker already charged it) + the
  // per-reservation hook — anything already on the reservation as a selected
  // charge referencing the same service from a NON-kiosk source (broker
  // import, counter add). Our own KIOSK_UPSELL rows stay offerable so a
  // re-render lets the customer change their selection.
  const excluded = new Set(normalizeIdList(rule?.prepaidServiceIds));
  for (const charge of resv.charges || []) {
    if (!charge?.sourceRefId) continue;
    if (String(charge.source || '').toUpperCase() === KIOSK_UPSELL_SOURCE) continue;
    if (catalogById.has(String(charge.sourceRefId))) excluded.add(String(charge.sourceRefId));
  }

  const addons = normalizeIdList(rule?.offerServiceIds)
    .filter((id) => !excluded.has(id))
    .map((id) => catalogById.get(id))
    .filter(Boolean)
    .map((service) => serviceOfferLine(service, days));

  const packages = (packagesConfig || [])
    .map((pkg) => {
      const componentIds = normalizeIdList(pkg?.serviceIds)
        .filter((id) => !excluded.has(id) && catalogById.has(id));
      if (!componentIds.length) return null;
      const services = componentIds.map((id) => serviceOfferLine(catalogById.get(id), days));
      const total = round2(services.reduce((sum, line) => sum + line.total, 0));
      return {
        key: String(pkg?.key || '').toUpperCase(),
        name: String(pkg?.name || pkg?.key || 'Package'),
        serviceIds: componentIds,
        services,
        total,
        perDay: round2(total / days),
      };
    })
    .filter(Boolean);

  // Everything a kiosk customer may legally accept: rule addons + package components.
  const offerable = new Map(addons.map((line) => [line.serviceId, line]));
  for (const pkg of packages) {
    for (const line of pkg.services) {
      if (!offerable.has(line.serviceId)) offerable.set(line.serviceId, line);
    }
  }

  return { resv, days, channel, rule, packages, addons, offerable };
}

/** GET /sessions/:id/offers — prices always from the server. */
async function computeOffers(sessionId, device) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  const { days, channel, rule, packages, addons } = await buildOfferContext(session, device);

  await recordSessionTelemetry(session, {
    step: 'UPSELL',
    event: 'OFFERS_SHOWN',
    data: {
      channel,
      packageKeys: packages.map((p) => p.key),
      addonServiceIds: addons.map((a) => a.serviceId),
    },
  });

  return {
    channel,
    days,
    strategy: rule?.strategy || 'PACKAGES_3',
    packages,
    addons,
  };
}

/**
 * POST /sessions/:id/offers { acceptedServiceIds[] } — [] = declined all.
 * Validates against what was offerable (prepaid/unknown ids → 422), writes
 * ReservationCharge rows and recomputes totals via the counter pricing path.
 * Idempotent: replaces the reservation's previous KIOSK_UPSELL selections.
 */
async function acceptOffers(sessionId, device, { acceptedServiceIds } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  if (acceptedServiceIds !== undefined && !Array.isArray(acceptedServiceIds)) {
    throw new KioskError('acceptedServiceIds must be an array', 400);
  }

  const { resv, days, channel, offerable } = await buildOfferContext(session, device);
  const ids = normalizeIdList(acceptedServiceIds);
  const notOfferable = ids.filter((id) => !offerable.has(id));
  if (notOfferable.length) {
    throw new KioskError(
      `Not offerable for this reservation: ${notOfferable.join(', ')}`,
      422,
      'SERVICE_NOT_OFFERABLE',
    );
  }

  const chargeRows = ids.map((id, idx) => {
    const line = offerable.get(id);
    return {
      reservationId: resv.id,
      code: line.code,
      name: line.name,
      chargeType: line.pricingMode === 'PER_DAY' ? 'DAILY' : 'UNIT',
      quantity: line.pricingMode === 'PER_DAY' ? days : line.quantity,
      rate: line.rate,
      total: line.total,
      taxable: line.taxable,
      selected: true,
      sortOrder: 1000 + idx,
      source: KIOSK_UPSELL_SOURCE,
      sourceRefId: line.serviceId,
      notes: 'Kiosk upsell',
    };
  });

  // NON-ATOMICITY NOTE (B2 QA): the KIOSK_UPSELL replace commits in its own
  // transaction; recomputeTaxRow and getPricing run AFTER it. A crash between
  // the two can leave the TAX row stale (or absent) relative to the new
  // selection until the next accept — the idempotent re-POST self-heals it,
  // and the kiosk flow always re-POSTs on resume. Future refactor: fold the
  // tax recompute into this tx once recomputeTaxRow grows a db/tx param.
  await prisma.$transaction(async (tx) => {
    // Idempotent replace: a re-POST swaps the previous kiosk selection.
    await tx.reservationCharge.deleteMany({
      where: { reservationId: resv.id, source: KIOSK_UPSELL_SOURCE },
    });
    if (chargeRows.length) {
      await tx.reservationCharge.createMany({ data: chargeRows });
    }
  });

  // TAX (B2 review MUST-CHANGE): getPricing only SUMS existing TAX rows —
  // it never recomputes them — so a taxable kiosk add-on would sell tax-free.
  // Reuse the extension path's canonical recompute (reservation-extend
  // recomputeTaxRow: wipe TAX rows, one new line from the taxable subtotal,
  // rate from pricingSnapshot ?? pickup location) BEFORE getPricing.
  await recomputeTaxRow({
    reservationId: resv.id,
    pricingSnapshot: resv.pricingSnapshot || null,
    pickupLocationId: resv.pickupLocationId,
  });

  // Counter-path recompute (no new math): mandatory fees + toll sync +
  // syncAgreementCharges + reservation.estimatedTotal, all inside getPricing.
  const pricing = await reservationPricingService.getPricing(resv.id, { tenantId: device.tenantId });

  await recordSessionTelemetry(session, {
    step: 'UPSELL',
    event: ids.length ? 'OFFERS_ACCEPTED' : 'OFFERS_DECLINED',
    data: { channel, serviceIds: ids },
  });
  logger.info('[kiosk] offers accepted', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId,
    reservationId: resv.id, accepted: ids.length,
  });

  return {
    ok: true,
    acceptedServiceIds: ids,
    charges: chargeRows.map((row) => ({
      name: row.name,
      chargeType: row.chargeType,
      quantity: row.quantity,
      rate: row.rate,
      total: row.total,
      sourceRefId: row.sourceRefId,
    })),
    totals: pricing.totals,
  };
}

// ── Admin: upsell rules ─────────────────────────────────────────────────────

async function listUpsellRules(scope = {}) {
  const tenantId = requireTenantId(scope);
  return prisma.upsellRule.findMany({ where: { tenantId }, orderBy: { channel: 'asc' } });
}

async function upsertUpsellRule(body = {}, scope = {}) {
  const tenantId = requireTenantId(scope);
  const channel = String(body?.channel || '').trim().toUpperCase();
  if (!channel) throw new KioskError('channel is required (use * for the default rule)', 400);

  const strategy = String(body?.strategy || 'PACKAGES_3').trim().toUpperCase();
  if (!UPSELL_STRATEGIES.includes(strategy)) {
    throw new KioskError(`strategy must be one of ${UPSELL_STRATEGIES.join(', ')}`, 400);
  }

  // Always ids, never codes (code is nullable/non-unique) — validated against
  // the tenant's ACTIVE catalog at save time per the spec.
  const prepaidServiceIds = await assertServiceIdsInCatalog(tenantId, body?.prepaidServiceIds, 'prepaidServiceIds');
  const offerServiceIds = await assertServiceIdsInCatalog(tenantId, body?.offerServiceIds, 'offerServiceIds');

  const data = {
    prepaidServiceIds,
    offerServiceIds,
    strategy,
    isActive: body?.isActive !== false,
  };
  return prisma.upsellRule.upsert({
    where: { tenantId_channel: { tenantId, channel } },
    create: { tenantId, channel, ...data },
    update: data,
  });
}

// ── Admin: packages config ──────────────────────────────────────────────────

async function getPackagesConfig(scope = {}) {
  const tenantId = requireTenantId(scope);
  return { packages: await readPackagesConfig(tenantId) };
}

async function updatePackagesConfig(body = {}, scope = {}) {
  const tenantId = requireTenantId(scope);
  const raw = Array.isArray(body?.packages) ? body.packages : null;
  if (!raw) throw new KioskError('packages[] is required', 400);

  const seen = new Set();
  const packages = [];
  for (const pkg of raw) {
    const key = String(pkg?.key || '').trim().toUpperCase();
    if (!PACKAGE_KEYS.includes(key)) {
      throw new KioskError(`package key must be one of ${PACKAGE_KEYS.join(', ')}`, 400);
    }
    if (seen.has(key)) throw new KioskError(`duplicate package key ${key}`, 400);
    seen.add(key);
    const serviceIds = await assertServiceIdsInCatalog(tenantId, pkg?.serviceIds, `package ${key} serviceIds`);
    if (!serviceIds.length) throw new KioskError(`package ${key} needs at least one serviceId`, 400);
    packages.push({ key, name: String(pkg?.name || key).slice(0, 80), serviceIds });
  }

  const key = packagesSettingKey(tenantId);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(packages) },
    update: { value: JSON.stringify(packages) },
  });
  return { packages };
}

export const kioskOffersService = {
  computeOffers,
  acceptOffers,
  listUpsellRules,
  upsertUpsellRule,
  getPackagesConfig,
  updatePackagesConfig,
};
