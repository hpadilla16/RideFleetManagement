/**
 * DB-backed regression tests for reservationsService.swapVehicle → Vehicle.status sync.
 * Requires DATABASE_URL. Seeds its own tenant/location/vehicleType/vehicles/customer/
 * reservation/agreement per scenario.
 *
 * BUG (reported live 2026-07-16, drift fix dated 2026-06-10): swapVehicle moved the
 * reservation + rental agreement to the replacement car but never synced Vehicle.status.
 * The swapped-OUT car stayed ON_RENT (never returned to AVAILABLE) and the replacement
 * stayed AVAILABLE, until the hourly vehicle-drift-sweep repaired both ~an hour later.
 * Observed in prod on pairs KII873/KHV165 and KST792/KQN763.
 *
 * FIX: at the end of swapVehicle's transaction, call syncVehicleStatusForReservation with
 * the PRE-transaction vehicleId (the old car) + reservationId + toStatus 'CHECKED_OUT'.
 * The helper treats the reservation's current (new) vehicle as primary → ON_RENT, and the
 * now-stale caller-passed vehicleId as the swapped-out car → released to AVAILABLE unless
 * it is locked (IN_MAINTENANCE/OUT_OF_SERVICE/SOLD) or still CHECKED_OUT on another rental.
 *
 * Covers:
 *  1. happy path      — old car → AVAILABLE (the reported bug), new car → ON_RENT,
 *                       Reservation.vehicleId + RentalAgreement.vehicleId both moved.
 *  2. locked old car  — IN_MAINTENANCE is never force-freed by a swap.
 *  3. old car still out on ANOTHER open rental — stays ON_RENT.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationsService } from './reservations.service.js';
import { SWAP_PHOTO_SLOTS, __test as swapPhotosTest } from './swap-photos.js';

const prisma = new PrismaClient();
const TAG = `SWP-${Date.now()}`;

// Mandatory swap photos (2026-07-16): swapVehicle now HARD-BLOCKS without the 8
// standard photos per car (16 total) and uploads them to Supabase Storage. These
// status-sync scenarios are not about photos, so we satisfy the gate with a valid
// minimal set and stub storage via the module's test seam (no Supabase creds
// needed). The gate itself is covered in swap-photos.test.mjs (pure) and
// swap-vehicle-photos.test.mjs (DB-backed).
const objects = new Map();
const previousStorageFlag = process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;

test.before(() => {
  process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'true';
  swapPhotosTest.setStorageAdapter({
    uploader: async ({ bucket, path, body }) => { objects.set(`${bucket}:${path}`, body); return { path }; },
    downloader: async ({ bucket, path }) => ({ body: objects.get(`${bucket}:${path}`) || null })
  });
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const photoSet = () =>
  Object.fromEntries(SWAP_PHOTO_SLOTS.map((slot) => [slot, `data:image/jpeg;base64,${JPEG.toString('base64')}`]));

const ids = {
  tenant: null,
  location: null,
  vehicleType: null,
  customer: null,
  vehicles: [],
  reservations: [],
  agreements: []
};

let scope = null;
let seq = 0;

test.after(async () => {
  swapPhotosTest.reset();
  if (previousStorageFlag === undefined) delete process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
  else process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = previousStorageFlag;
  for (const agreementId of ids.agreements) {
    await prisma.rentalAgreementVehicleSwap.deleteMany({ where: { rentalAgreementId: agreementId } }).catch(() => {});
    await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: agreementId } }).catch(() => {});
    await prisma.rentalAgreement.delete({ where: { id: agreementId } }).catch(() => {});
  }
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
 * A CHECKED_OUT reservation on vehicle A (with a rental agreement — swapVehicle
 * requires status CHECKED_OUT + a vehicle + an existing agreement) and a spare
 * replacement vehicle B. Each test seeds its own so vehicle statuses stay isolated.
 */
async function seedScenario({ vehicleAStatus = 'ON_RENT' } = {}) {
  const n = ++seq;
  const vehicleA = await createVehicle(`A${n}`, vehicleAStatus);
  const vehicleB = await createVehicle(`B${n}`, 'AVAILABLE');

  const pickupAt = new Date(Date.now() - 2 * 86400e3);
  const returnAt = new Date(Date.now() + 2 * 86400e3);

  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `R${n}-${TAG}`,
      tenantId: ids.tenant,
      customerId: ids.customer,
      vehicleId: vehicleA.id,
      vehicleTypeId: ids.vehicleType,
      pickupLocationId: ids.location,
      returnLocationId: ids.location,
      pickupAt,
      returnAt,
      status: 'CHECKED_OUT'
    }
  });
  ids.reservations.push(reservation.id);

  const agreement = await prisma.rentalAgreement.create({
    data: {
      agreementNumber: `RA${n}-${TAG}`,
      reservationId: reservation.id,
      tenantId: ids.tenant,
      vehicleId: vehicleA.id,
      pickupAt,
      returnAt,
      pickupLocationId: ids.location,
      returnLocationId: ids.location,
      customerFirstName: 'Swap',
      customerLastName: 'Tester',
      status: 'FINALIZED',
      odometerOut: 41000,
      total: 0,
      paidAmount: 0,
      balance: 0
    }
  });
  ids.agreements.push(agreement.id);

  return { vehicleA, vehicleB, reservation, agreement };
}

const swapPayload = (vehicleId) => ({
  vehicleId,
  currentCheckin: { odometer: 41250, fuelLevel: '0.5', cleanliness: 4, photos: photoSet() },
  nextCheckout: { odometer: 22000, fuelLevel: '1', cleanliness: 5, photos: photoSet() }
});

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
    data: { firstName: 'Swap', lastName: 'Tester', phone: '7875550144', email: `c-${TAG}@x.com`, tenantId: tenant.id }
  });
  ids.customer = customer.id;
  assert.ok(scope.tenantId);
});

test('swap releases the swapped-out car to AVAILABLE and puts the replacement ON_RENT', async () => {
  const { vehicleA, vehicleB, reservation, agreement } = await seedScenario({ vehicleAStatus: 'ON_RENT' });

  await reservationsService.swapVehicle(reservation.id, swapPayload(vehicleB.id), scope);

  // The reported bug: the swapped-out car stayed ON_RENT until the hourly sweep.
  assert.equal(await statusOf(vehicleA.id), 'AVAILABLE', 'swapped-out vehicle must be released to AVAILABLE');
  assert.equal(await statusOf(vehicleB.id), 'ON_RENT', 'replacement vehicle must be ON_RENT');

  // The pre-existing swap behavior must be untouched.
  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleB.id, 'Reservation.vehicleId moved to the replacement');
  const agRow = await prisma.rentalAgreement.findUnique({ where: { id: agreement.id }, select: { vehicleId: true } });
  assert.equal(agRow.vehicleId, vehicleB.id, 'RentalAgreement.vehicleId moved to the replacement');
});

test('swap never force-frees a locked (IN_MAINTENANCE) swapped-out car', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario({ vehicleAStatus: 'IN_MAINTENANCE' });

  await reservationsService.swapVehicle(reservation.id, swapPayload(vehicleB.id), scope);

  assert.equal(await statusOf(vehicleA.id), 'IN_MAINTENANCE', 'locked status must survive the swap');
  assert.equal(await statusOf(vehicleB.id), 'ON_RENT', 'replacement vehicle must still go ON_RENT');
});

test('swap keeps the old car ON_RENT when it is still out on another open rental', async () => {
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

  await reservationsService.swapVehicle(reservation.id, swapPayload(vehicleB.id), scope);

  assert.equal(await statusOf(vehicleA.id), 'ON_RENT', 'old car is still out on another rental — must stay ON_RENT');
  assert.equal(await statusOf(vehicleB.id), 'ON_RENT', 'replacement vehicle must be ON_RENT');
});
