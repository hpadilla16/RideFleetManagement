/**
 * Airport Report (LAWA) — DB-backed tests (2026-07-29). Requires DATABASE_URL.
 * Pins the full column mapping against the RAReporting sample: PO from
 * sourceRef (franchise only), source-of-business mapping, agent from the
 * CHECKOUT inspection, service list, totals from the agreement, extension
 * subset, and that non-picked-up / cross-tenant rows never appear.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import {
  computeData, sourceOfBusiness, poNumber, rentalDays, serviceList, extensionExtra,
} from './airport-lawa.report.js';

const prisma = new PrismaClient();
const TAG = `LAWA-${Date.now()}`;
const ids = { tenant: null, other: null, loc: null, customer: null, user: null, agreements: [], reservations: [] };

test.after(async () => {
  await prisma.rentalAgreementInspection.deleteMany({ where: { rentalAgreementId: { in: ids.agreements } } }).catch(() => {});
  await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: { in: ids.agreements } } }).catch(() => {});
  await prisma.rentalAgreement.deleteMany({ where: { id: { in: ids.agreements } } }).catch(() => {});
  await prisma.reservation.deleteMany({ where: { id: { in: ids.reservations } } }).catch(() => {});
  if (ids.user) await prisma.user.delete({ where: { id: ids.user } }).catch(() => {});
  for (const t of [ids.tenant, ids.other]) {
    if (!t) continue;
    await prisma.customer.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.location.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: t } }).catch(() => {});
  }
  await prisma.$disconnect();
});

// ── Pure helpers ────────────────────────────────────────────────────────────

test('sourceOfBusiness: FRANCHISE_X → X, STAFF → WALK-IN, passthrough otherwise', () => {
  assert.equal(sourceOfBusiness('FRANCHISE_ECONOMY'), 'ECONOMY');
  assert.equal(sourceOfBusiness('FRANCHISE_MEX'), 'MEX');
  assert.equal(sourceOfBusiness('STAFF'), 'WALK-IN');
  assert.equal(sourceOfBusiness(null), 'WALK-IN');
  assert.equal(sourceOfBusiness('WEBSITE'), 'WEBSITE');
});

test('poNumber: raw external refs pass, synthetic prefixed refs and nulls blank', () => {
  assert.equal(poNumber('EPRLA14636A0'), 'EPRLA14636A0');
  assert.equal(poNumber('PUBLICBOOK:abc123def4567890'), '');
  assert.equal(poNumber('CARSHARE:TRIP1'), '');
  assert.equal(poNumber(null), '');
});

test('rentalDays: ceil with a floor of 1', () => {
  assert.equal(rentalDays('2026-07-01T10:00:00Z', '2026-07-04T10:00:00Z'), 3);
  assert.equal(rentalDays('2026-07-01T10:00:00Z', '2026-07-01T12:00:00Z'), 1);
  assert.equal(rentalDays(null, null), 1);
});

test('serviceList + extensionExtra: sold items only, extension summed separately', () => {
  const charges = [
    { code: 'PDW', name: 'Partial Damage Waiver', source: 'SERVICE', chargeType: 'UNIT', total: 45, selected: true },
    { code: null, name: 'DPO', source: 'ADDITIONAL_SERVICE_PRECHECKIN', chargeType: 'UNIT', total: 30, selected: true },
    { code: 'EXTENSION_RATE', name: 'Extension (2 days @ $40/day)', source: 'EXTENSION_DEFAULT', chargeType: 'DAILY', total: 80, selected: true },
    { code: null, name: 'Daily', source: 'DAILY', chargeType: 'DAILY', total: 100, selected: true },
    { code: null, name: 'Tax', source: 'TAX', chargeType: 'TAX', total: 12, selected: true },
  ];
  assert.equal(serviceList(charges), 'PDW, DPO');
  assert.equal(extensionExtra(charges), 80);
});

// ── DB-backed computeData ───────────────────────────────────────────────────

test('setup', async () => {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = t.id;
  const other = await prisma.tenant.create({ data: { name: `O ${TAG}`, slug: `o-${TAG}`.toLowerCase() } });
  ids.other = other.id;
  const loc = await prisma.location.create({ data: { tenantId: t.id, code: `L${TAG.slice(-6)}`, name: 'LAX Test' } });
  ids.loc = loc.id;
  const cust = await prisma.customer.create({ data: { tenantId: t.id, firstName: 'Air', lastName: 'Port', phone: '5550002222', zip: '90045' } });
  ids.customer = cust.id;
  const agent = await prisma.user.create({ data: {
    email: `agent-${TAG}@x.com`.toLowerCase(), passwordHash: 'x', fullName: 'MANUEL MORENO', role: 'AGENT', tenantId: t.id,
  } });
  ids.user = agent.id;

  // Row 1: Economy import, checked out, with agreement + services + extension.
  const r1 = await prisma.reservation.create({ data: {
    tenantId: t.id, reservationNumber: `ECON-${TAG}-1`, customerId: cust.id,
    pickupLocationId: loc.id, returnLocationId: loc.id,
    pickupAt: new Date('2026-07-10T15:00:00Z'), returnAt: new Date('2026-07-13T15:00:00Z'),
    status: 'CHECKED_OUT', bookingChannel: 'FRANCHISE_ECONOMY', sourceRef: `EPRLA${TAG.slice(-6)}`,
  } });
  ids.reservations.push(r1.id);
  const ag1 = await prisma.rentalAgreement.create({ data: {
    agreementNumber: `RA-${TAG}-1`, reservationId: r1.id, tenantId: t.id,
    pickupAt: r1.pickupAt, returnAt: r1.returnAt, pickupLocationId: loc.id, returnLocationId: loc.id,
    customerFirstName: 'Air', customerLastName: 'Port', status: 'FINALIZED',
    subtotal: 147, taxes: 20.33, total: 167.33, paidAmount: 167.33, balance: 0,
  } });
  ids.agreements.push(ag1.id);
  await prisma.rentalAgreementCharge.createMany({ data: [
    { rentalAgreementId: ag1.id, name: 'Daily', chargeType: 'DAILY', quantity: 3, rate: 30, total: 90, taxable: true, selected: true, sortOrder: 0 },
    { rentalAgreementId: ag1.id, code: 'PDW', name: 'Partial Damage Waiver', chargeType: 'UNIT', quantity: 1, rate: 27, total: 27, taxable: true, selected: true, sortOrder: 1, source: 'SERVICE', sourceRefId: 'svc-1' },
    { rentalAgreementId: ag1.id, code: 'EXTENSION_RATE', name: 'Extension (1 day @ $30/day)', chargeType: 'DAILY', quantity: 1, rate: 30, total: 30, taxable: true, selected: true, sortOrder: 2, source: 'EXTENSION_DEFAULT' },
    { rentalAgreementId: ag1.id, name: 'Tax', chargeType: 'TAX', quantity: 1, rate: 20.33, total: 20.33, taxable: false, selected: true, sortOrder: 3, source: 'TAX' },
  ] });
  await prisma.rentalAgreementInspection.create({ data: {
    rentalAgreementId: ag1.id, phase: 'CHECKOUT', actorUserId: agent.id,
  } });

  // Row 2: walk-in, no agreement, no sourceRef.
  const r2 = await prisma.reservation.create({ data: {
    tenantId: t.id, reservationNumber: `RES-${TAG}-2`, customerId: cust.id,
    pickupLocationId: loc.id, returnLocationId: loc.id,
    pickupAt: new Date('2026-07-11T15:00:00Z'), returnAt: new Date('2026-07-12T15:00:00Z'),
    status: 'CHECKED_IN', bookingChannel: 'STAFF', estimatedTotal: 60,
  } });
  ids.reservations.push(r2.id);

  // Excluded: CONFIRMED (never picked up) and a cross-tenant pickup.
  const r3 = await prisma.reservation.create({ data: {
    tenantId: t.id, reservationNumber: `RES-${TAG}-3`, customerId: cust.id,
    pickupLocationId: loc.id, returnLocationId: loc.id,
    pickupAt: new Date('2026-07-12T15:00:00Z'), returnAt: new Date('2026-07-13T15:00:00Z'),
    status: 'CONFIRMED', bookingChannel: 'STAFF',
  } });
  ids.reservations.push(r3.id);
  const otherLoc = await prisma.location.create({ data: { tenantId: other.id, code: `X${TAG.slice(-6)}`, name: 'Other' } });
  const otherCust = await prisma.customer.create({ data: { tenantId: other.id, firstName: 'Leak', lastName: 'Row', phone: '5550003333' } });
  const r4 = await prisma.reservation.create({ data: {
    tenantId: other.id, reservationNumber: `RES-${TAG}-LEAK`, customerId: otherCust.id,
    pickupLocationId: otherLoc.id, returnLocationId: otherLoc.id,
    pickupAt: new Date('2026-07-10T16:00:00Z'), returnAt: new Date('2026-07-11T16:00:00Z'),
    status: 'CHECKED_OUT', bookingChannel: 'STAFF',
  } });
  ids.reservations.push(r4.id);
  assert.ok(ids.loc);
});

test('computeData: full RAReporting row mapping', async () => {
  const out = await computeData({
    tenantId: ids.tenant,
    query: { from: '2026-07-01', to: '2026-07-18', locationId: ids.loc },
  });
  assert.equal(out.count, 2, 'picked-up rows only; CONFIRMED + cross-tenant excluded');

  const econ = out.rows.find((r) => r.raNumber === `ECON-${TAG}-1`);
  assert.ok(econ, 'economy row present');
  assert.equal(econ.poNumber, `EPRLA${TAG.slice(-6)}`);
  assert.equal(econ.source, 'ECONOMY');
  assert.equal(econ.postalCode, '90045');
  assert.equal(econ.agentOut, 'MANUEL MORENO');
  assert.equal(econ.rentalDays, 3);
  assert.equal(econ.services, 'PDW');
  assert.equal(econ.totalBill, 167.33);
  assert.equal(econ.totalTax, 20.33);
  assert.equal(econ.renterPayments, 167.33);
  assert.equal(econ.extensionExtra, 30);

  const walkin = out.rows.find((r) => r.raNumber === `RES-${TAG}-2`);
  assert.ok(walkin, 'walk-in row present');
  assert.equal(walkin.poNumber, '');
  assert.equal(walkin.source, 'WALK-IN');
  assert.equal(walkin.totalBill, 60, 'no agreement → estimatedTotal fallback');
  assert.equal(walkin.extensionExtra, 0);

  assert.equal(out.totals.totalBill, 227.33);
  assert.equal(out.totals.totalTax, 20.33);
});
