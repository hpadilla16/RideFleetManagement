/**
 * DB-backed test for GET /api/internal/fleet (TollBridge fleet feed).
 * Requires DATABASE_URL.
 *
 * Pins the partner contract: dedicated-token gating, mandatory sede filter,
 * plate-less vehicles omitted (CA bills by plate only), SOLD -> active:false,
 * cursor pagination, updatedSince incremental sync.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { requireFleetToken, listFleetForPartner } from './fleet-internal.routes.js';

const prisma = new PrismaClient();
const TAG = `FLEETAPI-${Date.now()}`;
const ids = { tenant: null, locLax: null, locFl: null };

test.after(async () => {
  await prisma.vehicle.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.vehicleType.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.location.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test('setup: tenant with LAX + FL sedes and a mixed fleet', async () => {
  const tenant = await prisma.tenant.create({
    data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() }
  });
  ids.tenant = tenant.id;
  const locLax = await prisma.location.create({
    data: { tenantId: tenant.id, code: 'LAXA01', name: 'LAX Fleet Test' }
  });
  ids.locLax = locLax.id;
  const locFl = await prisma.location.create({
    data: { tenantId: tenant.id, code: `FL${TAG.slice(-6)}`, name: 'FL Fleet Test' }
  });
  ids.locFl = locFl.id;

  const vt = await prisma.vehicleType.create({
    data: { tenantId: tenant.id, code: `VT${TAG.slice(-6)}`, name: 'Fleet Test Type' }
  });
  await prisma.vehicle.createMany({
    data: [
      { tenantId: tenant.id, vehicleTypeId: vt.id, internalNumber: `A-${TAG}`, plate: '8ABC123', homeLocationId: locLax.id, make: 'Toyota', model: 'Corolla', year: 2024 },
      { tenantId: tenant.id, vehicleTypeId: vt.id, internalNumber: `B-${TAG}`, plate: '8-def 456', homeLocationId: locLax.id, status: 'SOLD' },
      { tenantId: tenant.id, vehicleTypeId: vt.id, internalNumber: `C-${TAG}`, plate: null, homeLocationId: locLax.id },
      { tenantId: tenant.id, vehicleTypeId: vt.id, internalNumber: `D-${TAG}`, plate: 'FLPLT99', homeLocationId: locFl.id }
    ]
  });
  assert.ok(ids.locLax);
});

test('token gate: 503 without env, 401 wrong token, passes with the dedicated token', () => {
  delete process.env.TOLLBRIDGE_FLEET_TOKEN;
  let res = fakeRes();
  requireFleetToken({ headers: {} }, res, () => assert.fail('must not pass'));
  assert.equal(res.statusCode, 503);

  process.env.TOLLBRIDGE_FLEET_TOKEN = `tb-${TAG}`;
  res = fakeRes();
  requireFleetToken({ headers: { authorization: 'Bearer wrong' } }, res, () => assert.fail('must not pass'));
  assert.equal(res.statusCode, 401);

  let passed = false;
  requireFleetToken({ headers: { authorization: `Bearer tb-${TAG}` } }, fakeRes(), () => { passed = true; });
  assert.equal(passed, true);
});

test('contract: sede filter mandatory, plate-less omitted, SOLD inactive', async () => {
  const missing = await listFleetForPartner({ tenantId: ids.tenant });
  assert.equal(missing.status, 400);

  const badLoc = await listFleetForPartner({ tenantId: ids.tenant, locationCode: 'NOPE' });
  assert.equal(badLoc.status, 404);

  const out = await listFleetForPartner({ tenantId: ids.tenant, locationCode: 'LAXA01' });
  assert.equal(out.status, 200);
  const plates = out.body.vehicles.map((v) => v.plate).sort();
  assert.deepEqual(plates, ['8-def 456', '8ABC123'], 'LAX only, plate-less omitted, FL excluded');

  const sold = out.body.vehicles.find((v) => v.plate === '8-def 456');
  assert.equal(sold.active, false, 'SOLD is out of fleet');
  assert.equal(sold.plateNormalized, '8DEF456', 'normalized plate strips separators/case');
  const alive = out.body.vehicles.find((v) => v.plate === '8ABC123');
  assert.equal(alive.active, true);
  assert.equal(alive.locationCode, 'LAXA01');
  assert.equal(out.body.nextCursor, null);
});

test('pagination + updatedSince', async () => {
  const page1 = await listFleetForPartner({ tenantId: ids.tenant, locationCode: 'LAXA01', limit: 1 });
  assert.equal(page1.body.vehicles.length, 1);
  assert.ok(page1.body.nextCursor, 'more rows follow');

  const page2 = await listFleetForPartner({
    tenantId: ids.tenant, locationCode: 'LAXA01', limit: 5, cursor: page1.body.nextCursor
  });
  assert.equal(page2.body.nextCursor, null);
  assert.equal(page1.body.vehicles.length + page2.body.vehicles.length, 2);
  assert.notEqual(page1.body.vehicles[0].id, page2.body.vehicles[0]?.id);

  const future = await listFleetForPartner({
    tenantId: ids.tenant, locationCode: 'LAXA01', updatedSince: '2099-01-01T00:00:00Z'
  });
  assert.equal(future.body.vehicles.length, 0, 'incremental sync: nothing updated after cutoff');

  const badDate = await listFleetForPartner({ tenantId: ids.tenant, locationCode: 'LAXA01', updatedSince: 'ayer' });
  assert.equal(badDate.status, 400);
});
