/**
 * DB-backed regression tests for reservationsService.update → Vehicle.status sync
 * on a VEHICLE REASSIGNMENT. Requires DATABASE_URL. Seeds its own tenant/location/
 * vehicleType/vehicles/customer/reservation per scenario.
 *
 * BUG (reported live 2026-07-16: "swap vehicle isn't putting the old vehicle in
 * available"). beta.317 fixed `swapVehicle` — the direct swap endpoint — but the
 * swap has a SECOND write path: `reservationsService.update`, the admin PATCH,
 * which is what the Loaner swap flow goes through. That path only synced
 * Vehicle.status when the RESERVATION STATUS changed (Bug #44):
 *
 *     if (patch.status !== undefined && updated.status !== current.status) { … }
 *
 * A patch that only reassigned `vehicleId` therefore synced nothing: the
 * swapped-out car stayed ON_RENT (never returned to AVAILABLE — the reported
 * symptom) and the replacement stayed AVAILABLE, until the hourly
 * vehicle-drift-sweep repaired both ~an hour later.
 *
 * FIX: also sync when the patch reassigned the vehicle (`vehicleChanged`), passing
 * the PRE-PATCH vehicleId. Same helper + semantics as beta.317: the reservation's
 * current (new) vehicle is primary → ON_RENT, and the now-stale caller-passed
 * vehicleId is the swapped-out car → released to AVAILABLE unless it is locked
 * (IN_MAINTENANCE/OUT_OF_SERVICE/SOLD) or still CHECKED_OUT on another rental.
 *
 * Covers:
 *  1. happy path       — old car → AVAILABLE (the reported bug), new car → ON_RENT.
 *  2. locked old car   — IN_MAINTENANCE is never force-freed by a reassignment.
 *  3. old car still out on ANOTHER open rental — stays ON_RENT.
 *  4. Bug #44 regression guard — a status-only patch still syncs (must not regress).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationsService } from './reservations.service.js';

const prisma = new PrismaClient();
const TAG = `UVC-${Date.now()}`;

const ids = {
  tenant: null,
  location: null,
  vehicleType: null,
  customer: null,
  vehicles: [],
  reservations: []
};

let scope = null;
let seq = 0;

test.after(async () => {
  if (ids.reservations.length) {
    await prisma.auditLog.deleteMany({ where: { reservationId: { in: ids.reservations } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { id: { in: ids.reservations } } }).catch(() => {});
  }
  for (const vehicleId of ids.vehicles) {
    await prisma.vehicleMileageEntry.deleteMany({ where: { vehicleId } }).catch(() => {});
    await prisma.vehicleFuelReading.deleteMany({ where: { vehicleId } }).catch(() => {});
    await prisma.vehicle.delete({ where: { id: vehicleId } }).catch(() => {});
  }
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where: { id: ids.vehicleType } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

async function createVehicle(label, status) {
  const row = await prisma.vehicle.create({
    data: {
      tenantId: ids.tenant,
      internalNumber: `${label}-${TAG}`.slice(0, 18),
      plate: `${label}${TAG.slice(-6)}`,
      status,
      vehicleTypeId: ids.vehicleType,
      homeLocationId: ids.location
    }
  });
  ids.vehicles.push(row.id);
  return row;
}

/**
 * A reservation on vehicle A plus a spare replacement vehicle B. Each test seeds
 * its own so vehicle statuses stay isolated.
 */
async function seedScenario({ vehicleAStatus = 'ON_RENT', reservationStatus = 'CHECKED_OUT' } = {}) {
  const n = ++seq;
  const vehicleA = await createVehicle(`A${n}`, vehicleAStatus);
  const vehicleB = await createVehicle(`B${n}`, 'AVAILABLE');

  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `R${n}-${TAG}`,
      tenantId: ids.tenant,
      customerId: ids.customer,
      vehicleId: vehicleA.id,
      vehicleTypeId: ids.vehicleType,
      pickupLocationId: ids.location,
      returnLocationId: ids.location,
      pickupAt: new Date(Date.now() - 2 * 86400e3),
      returnAt: new Date(Date.now() + 2 * 86400e3),
      status: reservationStatus
    }
  });
  ids.reservations.push(reservation.id);

  return { vehicleA, vehicleB, reservation };
}

const statusOf = async (vehicleId) => {
  const row = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { status: true } });
  return row?.status;
};

test('setup', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;
  scope = { tenantId: tenant.id };
  const location = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: tenant.id } });
  ids.location = location.id;
  const vehicleType = await prisma.vehicleType.create({ data: { tenantId: tenant.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact SUV' } });
  ids.vehicleType = vehicleType.id;
  const customer = await prisma.customer.create({
    data: { firstName: 'Patch', lastName: 'Tester', phone: '7875550177', email: `c-${TAG}@x.com`, tenantId: tenant.id }
  });
  ids.customer = customer.id;
  assert.ok(scope.tenantId);
});

test('admin PATCH reassigning the vehicle releases the old car to AVAILABLE and puts the new one ON_RENT', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario({ vehicleAStatus: 'ON_RENT' });

  await reservationsService.update(reservation.id, { vehicleId: vehicleB.id }, scope);

  // The reported bug: the swapped-out car stayed ON_RENT until the hourly sweep.
  assert.equal(await statusOf(vehicleA.id), 'AVAILABLE', 'swapped-out vehicle must be released to AVAILABLE');
  assert.equal(await statusOf(vehicleB.id), 'ON_RENT', 'replacement vehicle must be ON_RENT');

  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleB.id, 'Reservation.vehicleId moved to the replacement');
});

test('admin PATCH never force-frees a locked (IN_MAINTENANCE) old car', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario({ vehicleAStatus: 'IN_MAINTENANCE' });

  await reservationsService.update(reservation.id, { vehicleId: vehicleB.id }, scope);

  assert.equal(await statusOf(vehicleA.id), 'IN_MAINTENANCE', 'locked status must survive the reassignment');
  assert.equal(await statusOf(vehicleB.id), 'ON_RENT', 'replacement vehicle must still go ON_RENT');
});

test('admin PATCH keeps the old car ON_RENT when it is still out on another open rental', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario({ vehicleAStatus: 'ON_RENT' });

  // Vehicle A is (also) physically out on a second, unrelated CHECKED_OUT rental.
  const other = await prisma.reservation.create({
    data: {
      reservationNumber: `RX${seq}-${TAG}`,
      tenantId: ids.tenant,
      customerId: ids.customer,
      vehicleId: vehicleA.id,
      vehicleTypeId: ids.vehicleType,
      pickupLocationId: ids.location,
      returnLocationId: ids.location,
      pickupAt: new Date(Date.now() - 86400e3),
      returnAt: new Date(Date.now() + 86400e3),
      status: 'CHECKED_OUT'
    }
  });
  ids.reservations.push(other.id);

  await reservationsService.update(reservation.id, { vehicleId: vehicleB.id }, scope);

  assert.equal(await statusOf(vehicleA.id), 'ON_RENT', 'old car is still out on another rental — must stay ON_RENT');
  assert.equal(await statusOf(vehicleB.id), 'ON_RENT', 'replacement vehicle must be ON_RENT');
});

test('Bug #44 regression guard — a status-only PATCH still syncs the vehicle', async () => {
  // The fix reworked this branch (and switched it to the PRE-patch vehicleId, which
  // for a status-only patch is the same car). It must keep behaving exactly as before.
  const { vehicleA, reservation } = await seedScenario({
    vehicleAStatus: 'ON_RENT',
    reservationStatus: 'CHECKED_OUT'
  });

  await reservationsService.update(reservation.id, { status: 'CHECKED_IN' }, scope);

  assert.equal(await statusOf(vehicleA.id), 'AVAILABLE', 'check-in must still free the car (Bug #44 must not regress)');
});
