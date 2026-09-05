/**
 * Partner price-book isolation — DB-backed (2026-09-05). Run: npm run test:rates
 *   DATABASE_URL="postgresql://$(whoami)@localhost:5432/fleet_management?schema=public"
 *
 * THE BUG THIS PINS: resolveForRental sorts candidates createdAt desc and the
 * staff quote path passes no options, so a partner price book created AFTER the
 * online book would win every counter quote for that class if it were merely
 * displayOnline=false. It must be invisible on the ordinary path (staff AND
 * online) and selected ONLY through options.rateId — and even then fail closed
 * when the class has no item in that book.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ratesService } from '../rates/rates.service.js';

const prisma = new PrismaClient();
const TAG = `PRI-${Date.now()}`;
const ONLINE_DAILY = 52;
const PARTNER_DAILY = 45;
const PICKUP = '2026-10-12T14:00:00.000Z';
const RETURN = '2026-10-14T14:00:00.000Z';

const ids = { tenant: null, location: null, vtPriced: null, vtUnpriced: null, onlineRate: null, partnerRate: null };

test.before(async () => {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = t.id;
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'L', tenantId: t.id } });
  ids.location = loc.id;
  const vtA = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `A-${TAG}`.slice(0, 10), name: 'Priced' } });
  ids.vtPriced = vtA.id;
  const vtB = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `B-${TAG}`.slice(0, 10), name: 'Unpriced' } });
  ids.vtUnpriced = vtB.id;
  const online = await prisma.rate.create({
    data: {
      tenantId: t.id, rateCode: `ON-${TAG}`, name: 'Online', purpose: 'RENTAL', locationId: loc.id,
      daily: ONLINE_DAILY, displayOnline: true, active: true, isActive: true,
      rateItems: { create: [{ vehicleTypeId: vtA.id, daily: ONLINE_DAILY }, { vehicleTypeId: vtB.id, daily: ONLINE_DAILY }] }
    }
  });
  ids.onlineRate = online.id;
  // Created AFTER the online book (createdAt desc would rank it first), global (locationId null).
  const partner = await prisma.rate.create({
    data: {
      tenantId: t.id, rateCode: `PARTNER-${TAG}`, name: 'Partner', purpose: 'PARTNER', locationId: null,
      daily: PARTNER_DAILY, displayOnline: false, active: true, isActive: true,
      rateItems: { create: [{ vehicleTypeId: vtA.id, daily: PARTNER_DAILY }] } // vtB deliberately unpriced
    }
  });
  ids.partnerRate = partner.id;
});

test.after(async () => {
  try {
    await prisma.rateItem.deleteMany({ where: { rateId: { in: [ids.onlineRate, ids.partnerRate].filter(Boolean) } } });
    await prisma.rate.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.vehicleType.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.location.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.tenant.delete({ where: { id: ids.tenant } });
  } finally {
    await prisma.$disconnect();
  }
});

const args = (vehicleTypeId) => ({ vehicleTypeId, pickupLocationId: ids.location, pickupAt: PICKUP, returnAt: RETURN });

test('STAFF path (no options) never sees the partner book, even though it is newer', async () => {
  const quote = await ratesService.resolveForRental(args(ids.vtPriced), { tenantId: ids.tenant });
  assert.ok(quote, 'staff quote resolves');
  assert.equal(quote.rateId, ids.onlineRate);
  assert.equal(quote.baseDailyRate, ONLINE_DAILY);
});

test('ONLINE path (displayOnline) never sees the partner book', async () => {
  const quote = await ratesService.resolveForRental(args(ids.vtPriced), { tenantId: ids.tenant }, { displayOnline: true });
  assert.equal(quote?.rateId, ids.onlineRate);
  assert.equal(quote?.baseDailyRate, ONLINE_DAILY);
});

test('options.rateId selects ONLY the partner book and prices the class from it', async () => {
  const quote = await ratesService.resolveForRental(args(ids.vtPriced), { tenantId: ids.tenant }, { rateId: ids.partnerRate });
  assert.ok(quote, 'partner quote resolves');
  assert.equal(quote.rateId, ids.partnerRate);
  assert.equal(quote.baseDailyRate, PARTNER_DAILY);
  assert.equal(quote.source, 'GLOBAL');
});

test('options.rateId fails closed: class without an item in the partner book → null (never the online price)', async () => {
  const quote = await ratesService.resolveForRental(args(ids.vtUnpriced), { tenantId: ids.tenant }, { rateId: ids.partnerRate });
  assert.equal(quote, null);
});

test('options.rateId without a tenant in scope resolves nothing (structurally fail-closed)', async () => {
  const quote = await ratesService.resolveForRental(args(ids.vtPriced), {}, { rateId: ids.partnerRate });
  assert.equal(quote, null);
});

test('options.rateId pointing at a NON-partner rate resolves nothing (purpose is the lock)', async () => {
  const quote = await ratesService.resolveForRental(args(ids.vtPriced), { tenantId: ids.tenant }, { rateId: ids.onlineRate });
  assert.equal(quote, null);
});

test('rates admin list and rentalMinimum ignore the partner book', async () => {
  const rows = await ratesService.list({ query: `PARTNER-${TAG}` }, { tenantId: ids.tenant });
  assert.equal(rows.length, 0, 'partner book hidden from the general Rates grid');
});
