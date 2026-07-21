/**
 * resolveForRental — ONLINE path fail-closed backstop (VozIA pricing audit, item c).
 *
 * A rental class with NO class-specific RateItem for the requested vehicleTypeId
 * must NOT be cross-priced via another rate's HEADER `daily` on the ONLINE/public
 * path — it must return null so the class is simply dropped from availability
 * (visible + safe), never quoted at another class's price.
 *
 * INTERNAL/staff path (displayOnline falsy) keeps the legacy `scoped[0]` fallback:
 * staff may legitimately quote off a default rate and a human can catch a wrong number.
 *
 * DB-backed. Run: npm run test:rates
 *   DATABASE_URL="postgresql://$(whoami)@localhost:5432/fleet_management?schema=public"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ratesService } from './rates.service.js';

const prisma = new PrismaClient();
const TAG = `RFC-${Date.now()}`;

// A class WITH its own online RateItem prices at 45; the rate HEADER is 99.
// A cross-price bug would quote the header (99) for a class that has no RateItem.
const OWN_DAILY = 45; // vehicleType A: has a class-specific RateItem
const HEADER_DAILY = 99; // rate header — the cross-price value we must NOT emit online

// Monday pickup (any weekday works — rate day-flags default true), 2-day window.
const PICKUP = '2026-08-10T14:00:00.000Z';
const RETURN = '2026-08-12T14:00:00.000Z';

const ids = { tenant: null, location: null, vtWith: null, vtWithout: null, rate: null };

test.before(async () => {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = t.id;
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'L', tenantId: t.id } });
  ids.location = loc.id;
  const vtA = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `A-${TAG}`.slice(0, 10), name: 'HasRate' } });
  ids.vtWith = vtA.id;
  const vtB = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `B-${TAG}`.slice(0, 10), name: 'NoRate' } });
  ids.vtWithout = vtB.id;
  // One ONLINE, location-scoped rate. Header daily = 99. RateItem only for vtA (daily 45).
  const rate = await prisma.rate.create({
    data: {
      tenantId: t.id,
      rateCode: `RC-${TAG}`,
      name: 'Online rate',
      locationId: loc.id,
      purpose: 'RENTAL',
      daily: HEADER_DAILY,
      displayOnline: true,
      active: true,
      isActive: true,
      rateItems: { create: [{ vehicleTypeId: vtA.id, daily: OWN_DAILY }] }
    }
  });
  ids.rate = rate.id;
});

test.after(async () => {
  if (ids.rate) await prisma.rateItem.deleteMany({ where: { rateId: ids.rate } }).catch(() => {});
  if (ids.rate) await prisma.rate.delete({ where: { id: ids.rate } }).catch(() => {});
  if (ids.vtWith) await prisma.vehicleType.delete({ where: { id: ids.vtWith } }).catch(() => {});
  if (ids.vtWithout) await prisma.vehicleType.delete({ where: { id: ids.vtWithout } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

function args(vehicleTypeId) {
  return [
    { vehicleTypeId, pickupLocationId: ids.location, pickupAt: PICKUP, returnAt: RETURN },
    { tenantId: ids.tenant }
  ];
}

test('ONLINE: class WITH its own RateItem resolves to ITS price (unchanged)', async () => {
  const [q, scope] = args(ids.vtWith);
  const out = await ratesService.resolveForRental(q, scope, { displayOnline: true });
  assert.ok(out, 'expected a quote for the class that has its own online rate');
  assert.equal(Number(out.baseDailyRate), OWN_DAILY, 'must use the class-specific RateItem daily');
  assert.equal(out.rateId, ids.rate);
});

test('ONLINE: class with NO RateItem returns null (fail-closed, not cross-priced via header)', async () => {
  const [q, scope] = args(ids.vtWithout);
  const out = await ratesService.resolveForRental(q, scope, { displayOnline: true });
  // The bite: with the old `|| scoped[0]` fallback this returned a cross-price
  // (baseDailyRate === HEADER_DAILY 99). Fail-closed must be null.
  assert.equal(out, null, 'a class with no own online rate must be dropped, never cross-priced');
});

test('INTERNAL: class with NO RateItem STILL falls back to scoped[0] (behavior preserved)', async () => {
  const [q, scope] = args(ids.vtWithout);
  const out = await ratesService.resolveForRental(q, scope, {}); // displayOnline falsy
  assert.ok(out, 'internal/staff path must NOT be fail-closed — default-rate fallback preserved');
  assert.equal(Number(out.baseDailyRate), HEADER_DAILY, 'internal fallback uses the rate header daily');
  assert.equal(out.rateId, ids.rate);
});

test('INTERNAL: class WITH its own RateItem resolves to ITS price (unchanged)', async () => {
  const [q, scope] = args(ids.vtWith);
  const out = await ratesService.resolveForRental(q, scope, {});
  assert.ok(out);
  assert.equal(Number(out.baseDailyRate), OWN_DAILY, 'own RateItem wins on internal path too');
});
