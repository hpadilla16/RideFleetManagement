/**
 * Partnerships F2 — createPublicBooking under a program, DB-backed (2026-09-05).
 * Run: npm run test:rates   (DATABASE_URL="postgresql://$(whoami)@localhost:5432/fleet_management?schema=public")
 *
 * The money WRITE (Innovation F2 #7). Pins, through the REAL public checkout:
 *   - a program-mandatory service is added SERVER-SIDE even when the client omits it;
 *   - the reservation carries the program (channel PARTNER, sourceRef, partnerId, terms version)
 *     and prices from the program book, not the online book;
 *   - PREFERRED_TYPE (insurer, confirm-at-pickup): stamps persisted, NO payment link issued,
 *     due-now deposit zeroed on the snapshot, and reservationPriceConfirmedAtPickup() is true;
 *   - PREFERRED_TYPE without the disclosure / with a type the program does not offer → 422
 *     and NO reservation row;
 *   - a program paused between search and checkout → 422 and NO reservation row.
 * SMTP is never touched: SMTP_HOST is blanked, so the portal emails report unsent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { bookingEngineService } from '../booking-engine/booking-engine.service.js';
import { reservationPriceConfirmedAtPickup } from './partner-booking.js';

process.env.SMTP_HOST = '';
const prisma = new PrismaClient();
const TAG = `PCK-${Date.now()}`;
const ONLINE_DAILY = 60;
const PARTNER_DAILY = 48;
const PICKUP = '2026-11-02T14:00:00.000Z';
const RETURN = '2026-11-04T14:00:00.000Z';
const ids = {};

const customer = (n) => ({ firstName: 'Test', lastName: `Partner ${n}`, email: `pck-${TAG}-${n}@example.com`.toLowerCase(), phone: `787555${String(n).padStart(4, '0')}` });
const ownInsurance = { declinedCoverage: true, usingOwnInsurance: true, liabilityAccepted: true };
const book = (extra = {}) => bookingEngineService.createPublicBooking({
  tenantId: ids.tenant, searchType: 'RENTAL', pickupLocationId: ids.location, pickupAt: PICKUP, returnAt: RETURN,
  insuranceSelection: ownInsurance, ...extra
});
const reservationsOf = () => prisma.reservation.count({ where: { tenantId: ids.tenant } });

test.before(async () => {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase(), partnershipsEnabled: true } });
  ids.tenant = t.id;
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Main', tenantId: t.id, taxRate: 10 } });
  ids.location = loc.id;
  const vtA = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `A-${TAG}`.slice(0, 10), name: 'Compact' } });
  const vtB = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `B-${TAG}`.slice(0, 10), name: 'SUV' } });
  ids.vtA = vtA.id; ids.vtB = vtB.id;
  for (const [i, vt] of [[1, vtA], [2, vtB]]) {
    await prisma.vehicle.create({ data: { tenantId: t.id, internalNumber: `${TAG}-${i}`, plate: `${TAG.slice(-6)}${i}`, vehicleTypeId: vt.id, homeLocationId: loc.id, status: 'AVAILABLE' } });
  }
  const online = await prisma.rate.create({
    data: { tenantId: t.id, rateCode: `ON-${TAG}`, purpose: 'RENTAL', daily: ONLINE_DAILY, displayOnline: true, active: true, isActive: true,
      rateItems: { create: [{ vehicleTypeId: vtA.id, daily: ONLINE_DAILY }, { vehicleTypeId: vtB.id, daily: ONLINE_DAILY }] } }
  });
  ids.onlineRate = online.id;
  const pbook = await prisma.rate.create({
    data: { tenantId: t.id, rateCode: `PARTNER-${TAG}`, purpose: 'PARTNER', daily: PARTNER_DAILY, displayOnline: false, active: true, isActive: true,
      rateItems: { create: [{ vehicleTypeId: vtA.id, daily: PARTNER_DAILY }, { vehicleTypeId: vtB.id, daily: PARTNER_DAILY }] } }
  });
  ids.book = pbook.id;
  const rateP = await prisma.partner.create({
    data: { tenantId: t.id, slug: `book-${TAG}`.toLowerCase(), code: `BK${TAG.slice(-6)}`, kind: 'CORPORATE', name: 'Book Partner', status: 'ACTIVE', rateId: pbook.id, termsVersion: 3, termsJson: { es: '<p>t</p>', en: '' } }
  });
  ids.ratePartner = rateP;
  const svc = await prisma.additionalService.create({
    data: { tenantId: t.id, partnerId: rateP.id, name: `Delivery ${TAG}`, rate: 25, chargeType: 'UNIT', isActive: true, displayOnline: true }
  });
  ids.service = svc;
  await prisma.partnerService.create({ data: { partnerId: rateP.id, additionalServiceId: svc.id, mandatory: true, sortOrder: 0 } });
  const prefP = await prisma.partner.create({
    data: { tenantId: t.id, slug: `pref-${TAG}`.toLowerCase(), code: `PF${TAG.slice(-6)}`, kind: 'INSURANCE', name: 'Insurer', status: 'ACTIVE', rateId: null, discountPct: 10,
      vehicleMode: 'PREFERRED_TYPE', preferredTypePricing: 'CONFIRM_AT_PICKUP', askPolicyNumber: true, allowedVehicleTypeIds: [vtB.id], coverageDisclosureVersion: 2,
      coverageDisclosureJson: { es: '<p>x</p>', en: '' }, termsJson: { es: '<p>t</p>', en: '' } }
  });
  ids.prefPartner = prefP;
});

test.after(async () => {
  try {
    const reservations = await prisma.reservation.findMany({ where: { tenantId: ids.tenant }, select: { id: true } });
    const rids = reservations.map((r) => r.id);
    await prisma.reservationCharge.deleteMany({ where: { reservationId: { in: rids } } });
    await prisma.reservationPricingSnapshot.deleteMany({ where: { reservationId: { in: rids } } });
    await prisma.reservation.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.customer.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.partnerService.deleteMany({ where: { partnerId: ids.ratePartner?.id } });
    await prisma.additionalService.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.partner.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.rateItem.deleteMany({ where: { rateId: { in: [ids.onlineRate, ids.book].filter(Boolean) } } });
    await prisma.rate.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.vehicle.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.vehicleType.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.location.deleteMany({ where: { tenantId: ids.tenant } });
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: `tenant:${ids.tenant}:` } } });
    await prisma.tenant.delete({ where: { id: ids.tenant } });
  } finally {
    await prisma.$disconnect();
  }
});

test('RATE program: prices from the book, mandatory service forced server-side, program stamped on the row', async () => {
  const out = await book({ partnerSlug: ids.ratePartner.slug, vehicleTypeId: ids.vtA, customer: customer(1), additionalServices: [] });
  assert.equal(out.partner?.slug, ids.ratePartner.slug);
  assert.ok(out.reservation?.id, 'checkout returns the reservation');
  const row = await prisma.reservation.findUnique({ where: { id: out.reservation.id }, include: { charges: true, partner: true } });
  assert.ok(row);
  assert.equal(row.bookingChannel, 'PARTNER');
  assert.ok(row.reservationNumber.startsWith('PTR-'));
  assert.ok(String(row.sourceRef).startsWith(`PARTNER:${ids.ratePartner.slug}:`));
  assert.equal(row.partnerId, ids.ratePartner.id);
  assert.equal(row.partnerTermsVersion, 3);
  assert.equal(row.partnerPreferredVehicleTypeId, null, 'inventory programs do not stamp a preference');
  assert.equal(Number(row.dailyRate), PARTNER_DAILY, 'program book, not the online book');
  const names = row.charges.map((c) => c.name);
  assert.ok(names.includes(ids.service.name), `mandatory partner service forced: ${names.join(', ')}`);
  assert.ok(row.paymentRequestToken, 'inventory programs still get the online payment link');
  assert.equal(reservationPriceConfirmedAtPickup(row), false);
});

test('PREFERRED_TYPE program: stamps persisted, no payment link, due-now deposit zeroed, price confirmed at pickup', async () => {
  const out = await book({
    partnerSlug: ids.prefPartner.slug, vehicleTypeId: ids.vtB, partnerPreferredVehicleTypeId: ids.vtB,
    partnerDisclosureAccepted: true, partnerPolicyNumber: 'POL-123', customer: customer(2)
  });
  assert.equal(out.partner?.priceConfirmedAtPickup, true);
  assert.ok(out.reservation?.id, 'checkout returns the reservation');
  const row = await prisma.reservation.findUnique({ where: { id: out.reservation.id }, include: { partner: true, pricingSnapshot: true } });
  assert.ok(row);
  assert.equal(row.bookingChannel, 'PARTNER');
  assert.equal(row.partnerPreferredVehicleTypeId, ids.vtB);
  assert.ok(row.partnerDisclosureAcceptedAt instanceof Date);
  assert.equal(row.partnerDisclosureVersion, 2);
  assert.equal(row.partnerPolicyNumber, 'POL-123');
  assert.equal(row.paymentRequestToken, null, 'NO payment link when the amount is confirmed at pickup');
  assert.ok(row.signatureToken, 'the agreement signature link is still issued');
  assert.equal(row.pricingSnapshot?.depositRequired, false);
  assert.equal(Number(row.pricingSnapshot?.depositAmountDue || 0), 0);
  assert.equal(reservationPriceConfirmedAtPickup(row), true, 'portal/email show no figure');
});

test('PREFERRED_TYPE without the disclosure, or with a type the program does not offer → 422, no row', async () => {
  const before = await reservationsOf();
  await assert.rejects(
    () => book({ partnerSlug: ids.prefPartner.slug, vehicleTypeId: ids.vtB, partnerPreferredVehicleTypeId: ids.vtB, customer: customer(3) }),
    (err) => err.status === 422
  );
  await assert.rejects(
    () => book({ partnerSlug: ids.prefPartner.slug, vehicleTypeId: ids.vtA, partnerPreferredVehicleTypeId: ids.vtA, partnerDisclosureAccepted: true, customer: customer(4) }),
    (err) => err.status === 422
  );
  assert.equal(await reservationsOf(), before, 'no reservation row on a refused checkout');
});

test('a program paused between the search and the checkout → 422, no row, never the online price', async () => {
  await bookingEngineService.searchRental({ tenantId: ids.tenant, pickupLocationId: ids.location, pickupAt: PICKUP, returnAt: RETURN, partnerSlug: ids.ratePartner.slug });
  await prisma.partner.update({ where: { id: ids.ratePartner.id }, data: { status: 'PAUSED' } });
  const before = await reservationsOf();
  await assert.rejects(
    () => book({ partnerSlug: ids.ratePartner.slug, vehicleTypeId: ids.vtA, customer: customer(5) }),
    (err) => err.status === 422 && err.code === 'PARTNER_NOT_AVAILABLE' && err.reason === 'PAUSED'
  );
  assert.equal(await reservationsOf(), before);
});
