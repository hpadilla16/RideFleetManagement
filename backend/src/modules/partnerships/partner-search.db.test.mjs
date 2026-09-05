/**
 * Partnerships F2 — searchRental under a program, DB-backed (2026-09-05).
 * Run: npm run test:rates   (DATABASE_URL="postgresql://$(whoami)@localhost:5432/fleet_management?schema=public")
 *
 * Pins the money seam end to end through the REAL public search:
 *   - no partner → the online book prices (unchanged behaviour);
 *   - partner in RATE mode → the PARTNER book prices, the online rate rides along as
 *     the strike-through, an unpriced class is NOT offered (fail-closed);
 *   - partner in DISCOUNT mode → online × (1 − pct) as an effective daily rate;
 *   - PREFERRED_TYPE narrows to the selectable types and carries no deposit due now;
 *   - PAUSED / wrong location / unknown → 422 PARTNER_NOT_AVAILABLE, never online prices;
 *   - the search cache never serves a program entry to the online path or vice-versa.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { bookingEngineService } from '../booking-engine/booking-engine.service.js';

const prisma = new PrismaClient();
const TAG = `PSR-${Date.now()}`;
const ONLINE_DAILY = 52;
const PARTNER_DAILY = 45;
const PICKUP = '2026-10-12T14:00:00.000Z';
const RETURN = '2026-10-14T14:00:00.000Z';
const ids = {};

test.before(async () => {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase(), partnershipsEnabled: true } });
  ids.tenant = t.id;
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Main', tenantId: t.id, taxRate: 10 } });
  ids.location = loc.id;
  const other = await prisma.location.create({ data: { code: `O-${TAG}`.slice(0, 12), name: 'Other', tenantId: t.id } });
  ids.otherLocation = other.id;
  const vtA = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `A-${TAG}`.slice(0, 10), name: 'Compact' } });
  const vtB = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `B-${TAG}`.slice(0, 10), name: 'SUV' } });
  ids.vtA = vtA.id; ids.vtB = vtB.id;
  const online = await prisma.rate.create({
    data: {
      tenantId: t.id, rateCode: `ON-${TAG}`, purpose: 'RENTAL', locationId: null, daily: ONLINE_DAILY,
      displayOnline: true, active: true, isActive: true,
      rateItems: { create: [{ vehicleTypeId: vtA.id, daily: ONLINE_DAILY }, { vehicleTypeId: vtB.id, daily: ONLINE_DAILY }] }
    }
  });
  ids.onlineRate = online.id;
  const book = await prisma.rate.create({
    data: {
      tenantId: t.id, rateCode: `PARTNER-${TAG}`, purpose: 'PARTNER', locationId: null, daily: PARTNER_DAILY,
      displayOnline: false, active: true, isActive: true,
      rateItems: { create: [{ vehicleTypeId: vtA.id, daily: PARTNER_DAILY }] } // vtB deliberately unpriced
    }
  });
  ids.book = book.id;
  const rateP = await prisma.partner.create({
    data: { tenantId: t.id, slug: `book-${TAG}`.toLowerCase(), code: `BK${TAG.slice(-6)}`, kind: 'CORPORATE', name: 'Book Partner', status: 'ACTIVE', rateId: book.id, termsJson: { es: '<p>t</p>', en: '' }, locationIds: [loc.id] }
  });
  ids.ratePartner = rateP;
  const discP = await prisma.partner.create({
    data: { tenantId: t.id, slug: `disc-${TAG}`.toLowerCase(), code: `DS${TAG.slice(-6)}`, kind: 'COOPERATIVE', name: 'Discount Partner', status: 'ACTIVE', discountPct: 12, termsJson: { es: '<p>t</p>', en: '' } }
  });
  ids.discPartner = discP;
  const prefP = await prisma.partner.create({
    data: { tenantId: t.id, slug: `pref-${TAG}`.toLowerCase(), code: `PF${TAG.slice(-6)}`, kind: 'INSURANCE', name: 'Insurer', status: 'ACTIVE', rateId: null, discountPct: 10, vehicleMode: 'PREFERRED_TYPE', allowedVehicleTypeIds: [vtB.id], coverageDisclosureJson: { es: '<p>x</p>', en: '' }, termsJson: { es: '<p>t</p>', en: '' } }
  });
  ids.prefPartner = prefP;
  const paused = await prisma.partner.create({
    data: { tenantId: t.id, slug: `paused-${TAG}`.toLowerCase(), code: `PS${TAG.slice(-6)}`, kind: 'HOTEL', name: 'Paused', status: 'PAUSED', discountPct: 50, termsJson: { es: '<p>t</p>', en: '' } }
  });
  ids.pausedPartner = paused;
});

test.after(async () => {
  try {
    await prisma.partner.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.rateItem.deleteMany({ where: { rateId: { in: [ids.onlineRate, ids.book].filter(Boolean) } } });
    await prisma.rate.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.vehicleType.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.location.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: `tenant:${ids.tenant}:` } } });
    await prisma.tenant.delete({ where: { id: ids.tenant } });
  } finally {
    await prisma.$disconnect();
  }
});

const search = (extra = {}) => bookingEngineService.searchRental({
  tenantId: ids.tenant, pickupLocationId: ids.location, pickupAt: PICKUP, returnAt: RETURN, ...extra
});
const byType = (payload, id) => (payload.results || []).find((r) => r.vehicleType?.id === id);

test('no partner → online prices for both classes (behaviour unchanged)', async () => {
  const out = await search();
  assert.equal(out.partner, null);
  assert.equal(byType(out, ids.vtA)?.quote?.dailyRate, ONLINE_DAILY);
  assert.equal(byType(out, ids.vtB)?.quote?.dailyRate, ONLINE_DAILY);
  assert.equal(byType(out, ids.vtA)?.quote?.partnerPricing, null);
});

test('RATE mode → the partner book prices; the unpriced class is not offered; online rides as the strike-through', async () => {
  const out = await search({ partnerSlug: ids.ratePartner.slug });
  assert.equal(out.partner?.slug, ids.ratePartner.slug);
  assert.equal(out.partner?.pricingMode, 'RATE');
  const a = byType(out, ids.vtA);
  assert.ok(a, 'priced class offered');
  assert.equal(a.quote.dailyRate, PARTNER_DAILY);
  assert.equal(a.quote.baseDailyRate, ONLINE_DAILY, 'online rate kept for the strike-through');
  assert.equal(a.quote.partnerPricing.programDailyRate, PARTNER_DAILY);
  assert.equal(a.quote.partnerPricing.onlineDailyRate, ONLINE_DAILY);
  assert.equal(a.quote.revenuePricingApplied, false);
  assert.equal(byType(out, ids.vtB), undefined, 'class without a program price is NOT offered (never the online price)');
});

test('the cache keeps program and online entries apart (same dates, same location)', async () => {
  const online = await search();
  assert.equal(byType(online, ids.vtA)?.quote?.dailyRate, ONLINE_DAILY);
  const program = await search({ partnerSlug: ids.ratePartner.slug });
  assert.equal(byType(program, ids.vtA)?.quote?.dailyRate, PARTNER_DAILY);
  const onlineAgain = await search();
  assert.equal(byType(onlineAgain, ids.vtA)?.quote?.dailyRate, ONLINE_DAILY);
});

test('the program CODE alone does nothing on the public path (V1 = link/QR; codes are guessable)', async () => {
  const out = await search({ partnerCode: ids.discPartner.code });
  assert.equal(out.partner, null);
  assert.equal(byType(out, ids.vtA)?.quote?.dailyRate, ONLINE_DAILY);
});

test('DISCOUNT mode → online × (1 − 12%) as an effective daily rate, both classes offered', async () => {
  const out = await search({ partnerSlug: ids.discPartner.slug });
  assert.equal(out.partner?.pricingMode, 'DISCOUNT');
  const a = byType(out, ids.vtA);
  assert.equal(a.quote.dailyRate, 45.76);
  assert.equal(a.quote.baseDailyRate, ONLINE_DAILY);
  assert.equal(a.quote.partnerPricing.savingsPct, 12);
  assert.ok(byType(out, ids.vtB), 'discount applies to every online-priced class');
});

test('PREFERRED_TYPE → only the selectable types, no deposit due now, priceConfirmedAtPickup', async () => {
  const out = await search({ partnerSlug: ids.prefPartner.slug });
  assert.equal(out.partner?.vehicleMode, 'PREFERRED_TYPE');
  assert.equal(out.partner?.noOnlinePayment, true);
  assert.equal(byType(out, ids.vtA), undefined, 'not selectable');
  const b = byType(out, ids.vtB);
  assert.ok(b);
  assert.equal(b.deposit.required, false);
  assert.equal(b.deposit.amountDue, 0);
  assert.equal(b.quote.partnerPricing.priceConfirmedAtPickup, true);
});

test('PAUSED / wrong location / unknown / other tenant → 422 PARTNER_NOT_AVAILABLE, never online prices', async () => {
  for (const [extra, reason] of [
    [{ partnerSlug: ids.pausedPartner.slug }, 'PAUSED'],
    [{ partnerSlug: ids.ratePartner.slug, pickupLocationId: ids.otherLocation }, 'LOCATION_NOT_IN_PROGRAM'],
    [{ partnerSlug: 'no-such-program' }, 'PARTNER_NOT_FOUND']
  ]) {
    await assert.rejects(() => search(extra), (err) => err.status === 422 && err.code === 'PARTNER_NOT_AVAILABLE' && err.reason === reason, `expected ${reason}`);
  }
  await assert.rejects(() => bookingEngineService.searchRental({ tenantSlug: 'no-such-tenant-xyz', pickupLocationId: ids.location, pickupAt: PICKUP, returnAt: RETURN, partnerSlug: ids.ratePartner.slug }), (err) => err.status === 422);
});
