/**
 * DB-backed tests for LOCATION scoping of the maintenance module (2026-07-24).
 * Requires DATABASE_URL.
 *
 * WHY THIS EXISTS: two separate gaps, neither of which had a test.
 *
 *  a) `maintenance.due()` and `repairOrders.list()` were scoped on 2026-07-23 —
 *     the /maintenance board had been contradicting its own KPI tile, the tile
 *     saying 3 open ROs while the board under it listed the whole tenant's 40 —
 *     but the fix shipped uncovered.
 *  b) `repairOrders.get()`, `vehicleHistory()` and every RO mutation, plus
 *     `maintenance.listSchedules()`, were still tenant-only: a branch user could
 *     open, edit, complete or cancel any RO in the tenant by id, and read any
 *     vehicle's service schedule.
 *
 * RepairOrder has a real `locationId` column so it needs no relation hop;
 * ServiceSchedule has none and inherits its vehicle's home location.
 *
 * Every assertion below was verified to FAIL with its scoping filter removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { maintenanceService } from './maintenance.service.js';
import { repairOrdersService } from './repair-orders.service.js';

const prisma = new PrismaClient();
const TAG = `MNTLOC-${Date.now()}`;
const ids = { tenant: null, locA: null, locB: null, vehA: null, vehB: null, vtype: null,
              roA: null, roB: null, schedA: null, schedB: null };

let scopedToA = null;
let unrestricted = null;

test.after(async () => {
  await prisma.repairOrderLine.deleteMany({ where: { repairOrder: { tenantId: ids.tenant } } }).catch(() => {});
  await prisma.repairOrder.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.serviceSchedule.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.vehicle.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.vtype) await prisma.vehicleType.delete({ where: { id: ids.vtype } }).catch(() => {});
  for (const l of [ids.locA, ids.locB]) if (l) await prisma.location.delete({ where: { id: l } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

test('setup: two branches, a vehicle + an RO + an OVERDUE schedule at each', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;

  const [a, b] = await Promise.all([
    prisma.location.create({ data: { tenantId: tenant.id, code: `A-${TAG}`.slice(0, 12), name: 'Branch A' } }),
    prisma.location.create({ data: { tenantId: tenant.id, code: `B-${TAG}`.slice(0, 12), name: 'Branch B' } })
  ]);
  ids.locA = a.id; ids.locB = b.id;

  const vt = await prisma.vehicleType.create({
    data: { tenantId: tenant.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact' }
  });
  ids.vtype = vt.id;

  // mileage 20000 against a 5000-mile interval last done at 10000 → 5000 miles
  // overdue on both, so `due()` returns one item per branch.
  const [va, vb] = await Promise.all([
    prisma.vehicle.create({ data: { tenantId: tenant.id, internalNumber: `A1-${TAG}`, vehicleTypeId: vt.id, homeLocationId: a.id, plate: `PA${TAG}`.slice(0, 12), mileage: 20000 } }),
    prisma.vehicle.create({ data: { tenantId: tenant.id, internalNumber: `B1-${TAG}`, vehicleTypeId: vt.id, homeLocationId: b.id, plate: `PB${TAG}`.slice(0, 12), mileage: 20000 } })
  ]);
  ids.vehA = va.id; ids.vehB = vb.id;

  const [roA, roB] = await Promise.all([
    prisma.repairOrder.create({ data: { tenantId: tenant.id, vehicleId: va.id, locationId: a.id, roNumber: 1, source: 'MANUAL', status: 'OPEN' } }),
    prisma.repairOrder.create({ data: { tenantId: tenant.id, vehicleId: vb.id, locationId: b.id, roNumber: 1, source: 'MANUAL', status: 'OPEN' } })
  ]);
  ids.roA = roA.id; ids.roB = roB.id;

  const sched = { serviceType: 'LOF', intervalMiles: 5000, lastServiceMiles: 10000, active: true };
  const [sa, sb] = await Promise.all([
    prisma.serviceSchedule.create({ data: { ...sched, tenantId: tenant.id, vehicleId: va.id } }),
    prisma.serviceSchedule.create({ data: { ...sched, tenantId: tenant.id, vehicleId: vb.id } })
  ]);
  ids.schedA = sa.id; ids.schedB = sb.id;

  scopedToA = { tenantId: tenant.id, allowedLocationIds: [a.id] };
  unrestricted = { tenantId: tenant.id, allowedLocationIds: null };
  assert.ok(ids.roA && ids.roB && ids.schedA && ids.schedB);
});

// ── (a) the 2026-07-23 fixes that shipped without tests ──────────────────────

test('due(): a scoped caller sees only its own branch overdue services', async () => {
  const scoped = await maintenanceService.due({}, scopedToA);
  assert.equal(scoped.count, 1, 'one overdue item, not the whole tenant');
  assert.equal(scoped.items[0].vehicleId, ids.vehA);

  const all = await maintenanceService.due({}, unrestricted);
  assert.equal(all.count, 2, 'the tenant admin still sees both — no regression');
});

test('due(): a ?locationId the caller may NOT see never widens the scope', async () => {
  // THE security invariant of effectiveLocationIds, exercised end-to-end:
  // asking for Branch B as a Branch-A user falls back to A, never to B.
  const out = await maintenanceService.due({ locationId: ids.locB }, scopedToA);
  assert.equal(out.count, 1);
  assert.equal(out.items[0].vehicleId, ids.vehA, 'still only Branch A');
});

test('due(): an unrestricted caller CAN filter to a single location', async () => {
  const out = await maintenanceService.due({ locationId: ids.locB }, unrestricted);
  assert.equal(out.count, 1);
  assert.equal(out.items[0].vehicleId, ids.vehB, 'the plain filter still works for an admin');
});

test('repairOrders.list(): scoped to the caller branch, tile and board agree', async () => {
  const scoped = await repairOrdersService.list({}, scopedToA);
  assert.deepEqual(scoped.repairOrders.map((r) => r.id), [ids.roA]);

  const all = await repairOrdersService.list({}, unrestricted);
  assert.equal(all.repairOrders.length, 2);

  // The KPI tile is a different query (summary → count). It must agree with the
  // board above; the two disagreeing is the bug that started this work.
  const summary = await maintenanceService.summary({}, scopedToA);
  assert.equal(summary.open, scoped.repairOrders.length, 'tile and board agree for a scoped caller');
});

// ── (b) the surfaces that were still tenant-only ─────────────────────────────

test('repairOrders.get(): another branch RO is not readable by id', async () => {
  const mine = await repairOrdersService.get(ids.roA, scopedToA);
  assert.equal(mine.id, ids.roA, 'own RO opens normally');

  await assert.rejects(
    () => repairOrdersService.get(ids.roB, scopedToA),
    /not found/i,
    'a scoped caller must not open another branch RO by id'
  );

  const asAdmin = await repairOrdersService.get(ids.roB, unrestricted);
  assert.equal(asAdmin.id, ids.roB, 'the tenant admin still opens it — no regression');
});

test('repairOrders.vehicleHistory(): another branch vehicle yields nothing', async () => {
  const mine = await repairOrdersService.vehicleHistory(ids.vehA, scopedToA);
  assert.equal(mine.repairOrders.length, 1);

  const theirs = await repairOrdersService.vehicleHistory(ids.vehB, scopedToA);
  assert.deepEqual(theirs.repairOrders, [], 'not another branch repair history');

  const asAdmin = await repairOrdersService.vehicleHistory(ids.vehB, unrestricted);
  assert.equal(asAdmin.repairOrders.length, 1);
});

test('repairOrders MUTATIONS: another branch RO cannot be edited, completed or cancelled', async () => {
  // Reads and writes must not diverge — being unable to see a row while still
  // being able to close it is worse than the read leak.
  await assert.rejects(() => repairOrdersService.update(ids.roB, { notes: 'x' }, scopedToA), /not found/i, 'update');
  await assert.rejects(() => repairOrdersService.addLine(ids.roB, { type: 'PART', description: 'x', qty: 1, unitCost: 5 }, scopedToA), /not found/i, 'addLine');
  await assert.rejects(() => repairOrdersService.complete(ids.roB, scopedToA), /not found/i, 'complete');
  await assert.rejects(() => repairOrdersService.cancel(ids.roB, scopedToA), /not found/i, 'cancel');

  // Genuinely untouched — the rejections are not cosmetic.
  const after = await prisma.repairOrder.findUnique({ where: { id: ids.roB }, select: { status: true, notes: true } });
  assert.equal(after.status, 'OPEN');
  assert.equal(after.notes, null);
});

test('repairOrders.create(): cannot open an RO on another branch vehicle', async () => {
  await assert.rejects(
    () => repairOrdersService.create({ vehicleId: ids.vehB, source: 'MANUAL' }, scopedToA),
    /not found/i,
    'the vehicle lookup is location-scoped'
  );
  const count = await prisma.repairOrder.count({ where: { vehicleId: ids.vehB } });
  assert.equal(count, 1, 'no stray RO was created on the other branch vehicle');
});

test('repairOrders.create(): an out-of-scope locationId is REJECTED, not silently created', async () => {
  // Without the up-front check the row is written and then vanishes behind the
  // scoped get() — a 404 on a successful write, leaving an orphan RO at the
  // other branch. Assert both the error AND that nothing was written.
  const before = await prisma.repairOrder.count({ where: { tenantId: ids.tenant } });
  await assert.rejects(
    () => repairOrdersService.create({ vehicleId: ids.vehA, locationId: ids.locB, source: 'MANUAL' }, scopedToA),
    /outside your assigned locations/i
  );
  const after = await prisma.repairOrder.count({ where: { tenantId: ids.tenant } });
  assert.equal(after, before, 'no RO was created');
});

test('repairOrders.create(): a scoped caller CAN still open an RO on its own vehicle', async () => {
  // The happy path. `create` ends by calling the now-scoped `get()`, so if the
  // defaulted locationId (vehicle.homeLocationId) did not land inside the
  // caller's allowed set, a successful write would 404 on the way out. This is
  // the assertion that catches that.
  const created = await repairOrdersService.create({ vehicleId: ids.vehA, source: 'MANUAL', notes: 'own branch' }, scopedToA);
  assert.ok(created.id, 'the RO was created and returned, not 404');
  assert.equal(created.locationId, ids.locA, 'it defaulted to the vehicle home location');

  // And it is immediately readable + mutable by the same caller.
  const reread = await repairOrdersService.get(created.id, scopedToA);
  assert.equal(reread.id, created.id);
  await repairOrdersService.cancel(created.id, scopedToA);

  await prisma.repairOrderLine.deleteMany({ where: { repairOrderId: created.id } });
  await prisma.repairOrder.delete({ where: { id: created.id } });
});

test('repairOrders.create(): an explicit IN-scope locationId is accepted', async () => {
  const created = await repairOrdersService.create({ vehicleId: ids.vehA, locationId: ids.locA, source: 'MANUAL' }, scopedToA);
  assert.equal(created.locationId, ids.locA);
  await prisma.repairOrderLine.deleteMany({ where: { repairOrderId: created.id } });
  await prisma.repairOrder.delete({ where: { id: created.id } });
});

test('listSchedules()/upsertSchedule(): the WRITE happy path still works for a scoped caller', async () => {
  const out = await maintenanceService.upsertSchedule(ids.vehA, { serviceType: 'BRAKES', intervalMiles: 20000, lastServiceMiles: 5000 }, scopedToA);
  assert.ok(out.id, 'a scoped caller can still manage its own vehicle schedules');
  const list = await maintenanceService.listSchedules(ids.vehA, scopedToA);
  assert.equal(list.schedules.length, 2, 'LOF + the new BRAKES');
  await prisma.serviceSchedule.delete({ where: { id: out.id } });
});

test('repairOrders.update(): cannot push an RO out of the caller own scope', async () => {
  await assert.rejects(
    () => repairOrdersService.update(ids.roA, { locationId: ids.locB }, scopedToA),
    /outside your assigned locations/i,
    'reassigning to another branch is refused'
  );
  await assert.rejects(
    () => repairOrdersService.update(ids.roA, { locationId: null }, scopedToA),
    /outside your assigned locations/i,
    'and so is clearing it, which would hide the RO from everyone scoped'
  );
  const after = await prisma.repairOrder.findUnique({ where: { id: ids.roA }, select: { locationId: true } });
  assert.equal(after.locationId, ids.locA, 'the RO stayed at Branch A');

  // The admin may still move it (and move it back).
  await repairOrdersService.update(ids.roA, { locationId: ids.locB }, unrestricted);
  await repairOrdersService.update(ids.roA, { locationId: ids.locA }, unrestricted);
});

test('listSchedules(): another branch vehicle service history is not readable', async () => {
  const mine = await maintenanceService.listSchedules(ids.vehA, scopedToA);
  assert.equal(mine.schedules.length, 1, 'own vehicle schedules are readable');
  assert.equal(mine.vehicleMileage, 20000);

  const theirs = await maintenanceService.listSchedules(ids.vehB, scopedToA);
  assert.deepEqual(theirs.schedules, [], 'no schedules leak from the other branch');
  assert.equal(theirs.vehicleMileage, null, 'and not the odometer either');

  const asAdmin = await maintenanceService.listSchedules(ids.vehB, unrestricted);
  assert.equal(asAdmin.schedules.length, 1, 'the tenant admin still reads it — no regression');
});

test('schedule WRITES are scoped the same as the read', async () => {
  // upsertSchedule / logService take the same vehicleId. Leaving the write open
  // beside a closed read would let a branch user reset another branch service
  // baseline — which silently marks a genuinely overdue car as serviced.
  await assert.rejects(
    () => maintenanceService.upsertSchedule(ids.vehB, { serviceType: 'BRAKES', intervalMiles: 1000 }, scopedToA),
    /not found/i,
    'upsertSchedule'
  );
  await assert.rejects(
    () => maintenanceService.logService(ids.vehB, 'LOF', scopedToA),
    /not found/i,
    'logService'
  );
  // The other branch schedule kept its original baseline.
  const after = await prisma.serviceSchedule.findUnique({ where: { id: ids.schedB }, select: { lastServiceMiles: true } });
  assert.equal(after.lastServiceMiles, 10000, 'baseline untouched — the car is still overdue');
  const brakes = await prisma.serviceSchedule.count({ where: { vehicleId: ids.vehB, serviceType: 'BRAKES' } });
  assert.equal(brakes, 0, 'and no new schedule was created on it');
});

// QA gate finding (2026-07-24). deleteSchedule is the FOURTH sibling on this
// route group and was missed when listSchedules/upsertSchedule/logService were
// scoped — the most destructive of the four left open. A scoped-to-A caller
// could erase Branch B's service interval and get back 200 {ok:true}: B's
// overdue car then silently vanishes from due()/summary() with no error, no
// audit row, and no recovery path.
test('deleteSchedule(): another branch schedule cannot be deleted', async () => {
  const before = await prisma.serviceSchedule.count({ where: { id: ids.schedB } });
  assert.equal(before, 1, 'precondition: Branch B still has its LOF schedule');

  await assert.rejects(
    () => maintenanceService.deleteSchedule(ids.vehB, 'LOF', scopedToA),
    /not found/i,
    'a scoped caller must not delete another branch schedule'
  );

  const after = await prisma.serviceSchedule.count({ where: { id: ids.schedB } });
  assert.equal(after, 1, 'the schedule survived — the rejection is not cosmetic');

  // And Branch B's car is still visibly overdue to the tenant admin, which is
  // the observable consequence that a silent delete would have destroyed.
  const all = await maintenanceService.due({}, unrestricted);
  assert.ok(all.items.some((i) => i.vehicleId === ids.vehB), 'Branch B car still shows as due');
});

test('deleteSchedule(): a scoped caller CAN still delete its OWN schedule', async () => {
  const own = await prisma.serviceSchedule.create({
    data: { tenantId: ids.tenant, vehicleId: ids.vehA, serviceType: 'TIRE_ROTATION', intervalMiles: 7000, lastServiceMiles: 1000, active: true }
  });
  const out = await maintenanceService.deleteSchedule(ids.vehA, 'TIRE_ROTATION', scopedToA);
  assert.deepEqual(out, { ok: true });
  const gone = await prisma.serviceSchedule.count({ where: { id: own.id } });
  assert.equal(gone, 0, 'the happy path still deletes');
});

test('deleteSchedule(): an unrestricted admin can still delete either branch', async () => {
  const tmp = await prisma.serviceSchedule.create({
    data: { tenantId: ids.tenant, vehicleId: ids.vehB, serviceType: 'INSPECTION', intervalDays: 365, lastServiceAt: new Date('2025-01-01'), active: true }
  });
  await maintenanceService.deleteSchedule(ids.vehB, 'INSPECTION', unrestricted);
  const gone = await prisma.serviceSchedule.count({ where: { id: tmp.id } });
  assert.equal(gone, 0, 'no regression for the tenant admin');
});
