/**
 * DB-backed tests for the citation ingest guards (2026-07-26, Orlando-on-LAX
 * bug). Requires DATABASE_URL. MONEY-ADJACENT: auto-matching posts charges.
 *
 * CARES PROVEN HERE:
 *  1. AMBIGUOUS_PLATE: two vehicles share a normalized plate → the citation
 *     binds NO vehicle, holds with holdReason, and never matches/bills.
 *     (The old map silently picked the first vehicle — the architectural
 *     hole behind the Orlando incident class.)
 *  2. AGENCY_STATE_MISMATCH: an FL-claimed citation (agency keywords) on a
 *     CA-home vehicle KEEPS the vehicle bind (display) but holds — even
 *     with a valid issuedAt inside a rental window, no AUTO_CONFIRMED
 *     assignment is created.
 *  3. Regression: a clean citation (agency state agrees, or no signal at
 *     all) still auto-matches to the reservation exactly as before.
 *  4. Never guess: an unknown agency with no plate state produces NO hold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { citationsService } from './citations.service.js';

const prisma = new PrismaClient();
const TAG = `CITGRD-${Date.now()}`;
const ids = { tenant: null, locCA: null, locFL: null, vtype: null, vehCA: null, vehFL: null, dup1: null, dup2: null, customer: null, resCA: null };

test.after(async () => {
  await prisma.citationAssignment.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.citation.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.citationImportRun.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.reservation.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.vehicle.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.vtype) await prisma.vehicleType.delete({ where: { id: ids.vtype } }).catch(() => {});
  for (const l of [ids.locCA, ids.locFL]) if (l) await prisma.location.delete({ where: { id: l } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

test('setup: CA + FL branches, vehicles, a duplicate-plate pair, one active rental', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;
  const [ca, fl] = await Promise.all([
    prisma.location.create({ data: { tenantId: tenant.id, code: `CA-${TAG}`.slice(0, 12), name: 'LA Branch', state: 'CA' } }),
    prisma.location.create({ data: { tenantId: tenant.id, code: `FL-${TAG}`.slice(0, 12), name: 'Orlando Branch', state: 'FL' } })
  ]);
  ids.locCA = ca.id; ids.locFL = fl.id;
  const vt = await prisma.vehicleType.create({ data: { tenantId: tenant.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact' } });
  ids.vtype = vt.id;
  const [vehCA, vehFL, dup1, dup2] = await Promise.all([
    prisma.vehicle.create({ data: { tenantId: tenant.id, internalNumber: `CA1-${TAG}`, vehicleTypeId: vt.id, homeLocationId: ca.id, plate: `CAX${Date.now() % 1e6}` } }),
    prisma.vehicle.create({ data: { tenantId: tenant.id, internalNumber: `FL1-${TAG}`, vehicleTypeId: vt.id, homeLocationId: fl.id, plate: `FLX${Date.now() % 1e6}` } }),
    // The DB has @@unique(tenantId, plate), so EXACT duplicates are
    // impossible — but normalizePlate collapses these two distinct raw
    // plates into the same key, which is exactly how real ambiguity arises.
    prisma.vehicle.create({ data: { tenantId: tenant.id, internalNumber: `D1-${TAG}`, vehicleTypeId: vt.id, homeLocationId: ca.id, plate: `DUP-${TAG.slice(-6)}` } }),
    prisma.vehicle.create({ data: { tenantId: tenant.id, internalNumber: `D2-${TAG}`, vehicleTypeId: vt.id, homeLocationId: fl.id, plate: `DUP${TAG.slice(-6)}` } })
  ]);
  ids.vehCA = vehCA.id; ids.vehFL = vehFL.id; ids.dup1 = dup1.id; ids.dup2 = dup2.id;

  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, firstName: 'Cite', lastName: 'Tester', email: `cite-${TAG}@x.test`.toLowerCase(), phone: '5550001111' }
  });
  ids.customer = customer.id;
  const resCA = await prisma.reservation.create({
    data: {
      tenantId: tenant.id,
      reservationNumber: `R-${TAG}`,
      customerId: customer.id,
      vehicleId: vehCA.id,
      pickupLocationId: ca.id,
      returnLocationId: ca.id,
      pickupAt: new Date('2026-07-01T10:00:00Z'),
      returnAt: new Date('2026-07-30T10:00:00Z'),
      status: 'CHECKED_OUT'
    }
  });
  ids.resCA = resCA.id;
  assert.ok(resCA.id);
});

test('AMBIGUOUS_PLATE: shared plate binds no vehicle and never matches', async () => {
  const dupPlate = `DUP${TAG.slice(-6)}`;
  const out = await citationsService.ingestBatch({
    tenantId: ids.tenant,
    source: 'MANUAL',
    sourceType: 'MANUAL_IMPORT',
    rows: [{ citationNo: `AMB-${TAG}`, plate: dupPlate, agency: 'Somewhere PD', issuedAt: '2026-07-10T12:00:00Z', amount: 50 }]
  });
  assert.equal(out.imported, 1);
  const row = await prisma.citation.findFirst({ where: { tenantId: ids.tenant, citationNo: `AMB-${TAG}` } });
  assert.equal(row.vehicleId, null);
  assert.equal(row.holdReason, 'AMBIGUOUS_PLATE');
  assert.equal(row.status, 'NEEDS_REVIEW');
  const assignments = await prisma.citationAssignment.count({ where: { citationId: row.id } });
  assert.equal(assignments, 0);
});

test('AGENCY_STATE_MISMATCH: Orlando agency on a CA car holds — bind kept, no billing match', async () => {
  const vehCA = await prisma.vehicle.findUnique({ where: { id: ids.vehCA }, select: { plate: true } });
  const out = await citationsService.ingestBatch({
    tenantId: ids.tenant,
    source: 'MANUAL',
    sourceType: 'MANUAL_IMPORT',
    // issuedAt is INSIDE the CA rental window — without the guard this
    // would AUTO_CONFIRM and bill. The agency claims Florida.
    rows: [{ citationNo: `GEO-${TAG}`, plate: vehCA.plate, agency: 'City of Orlando', issuedAt: '2026-07-10T12:00:00Z', amount: 75 }]
  });
  assert.equal(out.imported, 1);
  assert.equal(out.matched, 0);
  const row = await prisma.citation.findFirst({ where: { tenantId: ids.tenant, citationNo: `GEO-${TAG}` } });
  assert.equal(row.vehicleId, ids.vehCA);
  assert.equal(row.holdReason, 'AGENCY_STATE_MISMATCH');
  assert.equal(row.status, 'NEEDS_REVIEW');
  assert.equal(row.reservationId, null);
  const assignments = await prisma.citationAssignment.count({ where: { citationId: row.id } });
  assert.equal(assignments, 0);
});

test('regression: clean citation still auto-matches the rental window', async () => {
  const vehCA = await prisma.vehicle.findUnique({ where: { id: ids.vehCA }, select: { plate: true } });
  const out = await citationsService.ingestBatch({
    tenantId: ids.tenant,
    source: 'MANUAL',
    sourceType: 'MANUAL_IMPORT',
    rows: [{ citationNo: `OK-${TAG}`, plate: vehCA.plate, agency: 'City of Los Angeles', issuedAt: '2026-07-10T12:00:00Z', amount: 60 }]
  });
  assert.equal(out.matched, 1);
  const row = await prisma.citation.findFirst({ where: { tenantId: ids.tenant, citationNo: `OK-${TAG}` } });
  assert.equal(row.vehicleId, ids.vehCA);
  assert.equal(row.holdReason, null);
  assert.equal(row.status, 'MATCHED');
  assert.equal(row.reservationId, ids.resCA);
});

test('never guess: unknown agency + no plate state → no hold', async () => {
  const vehCA = await prisma.vehicle.findUnique({ where: { id: ids.vehCA }, select: { plate: true } });
  const out = await citationsService.ingestBatch({
    tenantId: ids.tenant,
    source: 'MANUAL',
    sourceType: 'MANUAL_IMPORT',
    rows: [{ citationNo: `UNK-${TAG}`, plate: vehCA.plate, agency: 'Parking Enforcement Bureau', issuedAt: '2026-07-11T12:00:00Z', amount: 40 }]
  });
  assert.equal(out.matched, 1);
  const row = await prisma.citation.findFirst({ where: { tenantId: ids.tenant, citationNo: `UNK-${TAG}` } });
  assert.equal(row.holdReason, null);
  assert.equal(row.status, 'MATCHED');
});
