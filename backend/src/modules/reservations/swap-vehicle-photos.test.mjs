/**
 * DB-backed tests for the MANDATORY SWAP PHOTOS gate (2026-07-16).
 * Requires DATABASE_URL. Seeds its own tenant/location/vehicleType/vehicles/
 * customer/reservation/agreement per scenario.
 *
 * Hector's rule: 8 standard photos for the car coming back AND 8 for the car being
 * handed over (16 total). HARD BLOCK, no override, no admin bypass. The gate lives
 * in swapVehicle — the UI is not the gate.
 *
 * 🚨 The other half of this file's job: prove that NO base64 lands in
 * RentalAgreementVehicleSwap.previousInspectionJson / nextInspectionJson. 16
 * multi-MB blobs in those columns is exactly the shape of the beta.310 planner
 * snapshot outage (38s / 504). Photos go to Supabase Storage; the JSON holds refs.
 *
 * Storage is stubbed via swap-photos' `__test.setStorageAdapter` (the repo's
 * established test-seam pattern) so the suite needs no Supabase credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationsService } from './reservations.service.js';
import { SWAP_PHOTO_SLOTS, __test as swapPhotosTest } from './swap-photos.js';

const prisma = new PrismaClient();
const TAG = `SWP-PH-${Date.now()}`;

const ids = { tenant: null, location: null, vehicleType: null, customer: null, vehicles: [], reservations: [], agreements: [] };
let scope = null;
let seq = 0;

// ── stubbed Supabase Storage ────────────────────────────────────────────────
// Records every uploaded object so we can assert the bytes went to STORAGE and
// only refs went to the DB. The downloader mirrors it so the service's mandatory
// read-back byte-verification passes.
const objects = new Map();
const uploads = [];
const previousStorageFlag = process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;

test.before(() => {
  process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'true';
  swapPhotosTest.setStorageAdapter({
    uploader: async ({ bucket, path, body, contentType }) => {
      objects.set(`${bucket}:${path}`, body);
      uploads.push({ bucket, path, contentType, size: body.byteLength });
      return { path };
    },
    downloader: async ({ bucket, path }) => ({ body: objects.get(`${bucket}:${path}`) || null })
  });
});

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

// A realistic-size JPEG (~120 KB) so "did the bytes end up in the JSON column?"
// is measurable rather than theoretical.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120 * 1024, 9)]);
const jpegDataUrl = () => `data:image/jpeg;base64,${JPEG.toString('base64')}`;

const fullPhotoSet = () => Object.fromEntries(SWAP_PHOTO_SLOTS.map((slot) => [slot, jpegDataUrl()]));

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

async function seedScenario() {
  const n = ++seq;
  const vehicleA = await createVehicle(`PA${n}`, 'ON_RENT');
  const vehicleB = await createVehicle(`PB${n}`, 'AVAILABLE');
  const pickupAt = new Date(Date.now() - 2 * 86400e3);
  const returnAt = new Date(Date.now() + 2 * 86400e3);

  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `RP${n}-${TAG}`,
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
      agreementNumber: `RAP${n}-${TAG}`,
      reservationId: reservation.id,
      tenantId: ids.tenant,
      vehicleId: vehicleA.id,
      pickupAt,
      returnAt,
      pickupLocationId: ids.location,
      returnLocationId: ids.location,
      customerFirstName: 'Swap',
      customerLastName: 'Photos',
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

const payload = (vehicleId, { previousPhotos = fullPhotoSet(), nextPhotos = fullPhotoSet() } = {}) => ({
  vehicleId,
  currentCheckin: { odometer: 41250, fuelLevel: '0.5', cleanliness: 4, photos: previousPhotos },
  nextCheckout: { odometer: 22000, fuelLevel: '1', cleanliness: 5, photos: nextPhotos }
});

const statusOf = async (vehicleId) =>
  (await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { status: true } }))?.status;

test('setup', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;
  scope = { tenantId: tenant.id };
  ids.location = (await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: tenant.id } })).id;
  ids.vehicleType = (await prisma.vehicleType.create({ data: { tenantId: tenant.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact SUV' } })).id;
  ids.customer = (await prisma.customer.create({
    data: { firstName: 'Swap', lastName: 'Photos', phone: '7875550155', email: `cp-${TAG}@x.com`, tenantId: tenant.id }
  })).id;
  assert.ok(scope.tenantId);
});

// ── REJECT ──────────────────────────────────────────────────────────────────

test('swap is REJECTED with no photos at all, and nothing is mutated', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario();
  await assert.rejects(
    () => reservationsService.swapVehicle(reservation.id, payload(vehicleB.id, { previousPhotos: {}, nextPhotos: {} }), scope),
    /Vehicle swap blocked: all 8 photos are required/
  );
  // Hard block means NOTHING happened — not a partial swap.
  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleA.id, 'reservation must not move to the replacement');
  assert.equal(await statusOf(vehicleA.id), 'ON_RENT');
  assert.equal(await statusOf(vehicleB.id), 'AVAILABLE');
  assert.equal(await prisma.rentalAgreementVehicleSwap.count({ where: { previousVehicleId: vehicleA.id } }), 0);
});

test('swap is REJECTED when the car coming back is missing one slot — error names the car and the slot', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario();
  const previousPhotos = fullPhotoSet();
  delete previousPhotos.trunk;
  await assert.rejects(
    () => reservationsService.swapVehicle(reservation.id, payload(vehicleB.id, { previousPhotos }), scope),
    (err) => {
      assert.match(err.message, /Vehicle coming back \(.*\): trunk/, 'names the incoming car + slot');
      assert.doesNotMatch(err.message, /Replacement vehicle/, 'the complete car is not blamed');
      return true;
    }
  );
  assert.equal(await statusOf(vehicleA.id), 'ON_RENT');
});

test('swap is REJECTED when the replacement car is missing slots — error names that car', async () => {
  const { vehicleB, reservation } = await seedScenario();
  const nextPhotos = fullPhotoSet();
  delete nextPhotos.dashboard;
  delete nextPhotos.rearSeat;
  await assert.rejects(
    () => reservationsService.swapVehicle(reservation.id, payload(vehicleB.id, { nextPhotos }), scope),
    (err) => {
      assert.match(err.message, /Replacement vehicle \(.*\): rearSeat, dashboard/);
      assert.doesNotMatch(err.message, /Vehicle coming back/);
      return true;
    }
  );
});

test('swap is REJECTED for a slot that carries junk instead of an image (no bypass by faking a key)', async () => {
  const { vehicleB, reservation } = await seedScenario();
  const previousPhotos = { ...fullPhotoSet(), front: 'not-a-photo' };
  await assert.rejects(
    () => reservationsService.swapVehicle(reservation.id, payload(vehicleB.id, { previousPhotos }), scope),
    /Vehicle coming back \(.*\): front \(not a valid image\)/
  );
});

test('swap is REJECTED (fail-closed) when photo storage is disabled — never inlines base64', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario();
  process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'false';
  try {
    await assert.rejects(
      () => reservationsService.swapVehicle(reservation.id, payload(vehicleB.id), scope),
      /photo storage is not enabled/
    );
  } finally {
    process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'true';
  }
  assert.equal(await statusOf(vehicleA.id), 'ON_RENT', 'nothing mutated');
  assert.equal(await statusOf(vehicleB.id), 'AVAILABLE');
});

// ── ACCEPT ──────────────────────────────────────────────────────────────────

test('swap is ACCEPTED with all 16 photos: refs (not base64) persisted, bytes in storage', async () => {
  const { vehicleA, vehicleB, reservation, agreement } = await seedScenario();
  uploads.length = 0;

  await reservationsService.swapVehicle(reservation.id, payload(vehicleB.id), scope);

  // All 16 bytes went to STORAGE, under the tenant-scoped inspection namespace.
  assert.equal(uploads.length, 16, 'exactly 16 objects uploaded');
  for (const up of uploads) {
    assert.equal(up.bucket, 'inspection-photos');
    assert.match(up.path, new RegExp(`^tenants/${ids.tenant}/inspections/swap_[0-9a-f-]+_(previous|next)/`));
    assert.equal(up.size, JPEG.byteLength, 'the real bytes were uploaded');
  }

  const swap = await prisma.rentalAgreementVehicleSwap.findFirst({ where: { rentalAgreementId: agreement.id } });
  assert.ok(swap, 'swap row created');

  for (const [column, suffix] of [['previousInspectionJson', 'previous'], ['nextInspectionJson', 'next']]) {
    const raw = swap[column];

    // 🚨 THE beta.310 GUARD: no base64 anywhere in the JSON column.
    assert.doesNotMatch(raw, /data:image/, `${column} must not contain a data URL`);
    assert.doesNotMatch(raw, /\/9j\/4/, `${column} must not contain base64 JPEG payload`);
    // 8 refs of ~150 bytes each — not 8 × 120 KB of base64.
    assert.ok(raw.length < 4000, `${column} must stay slim (got ${raw.length} bytes)`);

    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.photos, {}, 'inline photos map is emptied');
    assert.equal(parsed.photoBucket, 'inspection-photos');
    assert.equal(parsed.photoStorageRefs.length, 8, 'all 8 refs persisted');
    assert.deepEqual(parsed.photoStorageRefs.map((r) => r.key).sort(), SWAP_PHOTO_SLOTS.slice().sort());
    for (const ref of parsed.photoStorageRefs) {
      assert.match(ref.path, new RegExp(`^tenants/${ids.tenant}/inspections/swap_[0-9a-f-]+_${suffix}/${ref.key}_[0-9a-f-]+\\.jpg$`));
      assert.equal(ref.size, JPEG.byteLength);
      assert.equal(ref.contentType, 'image/jpeg');
      assert.ok(ref.uploadedAt);
      // Nothing that could be bytes.
      assert.equal(ref.dataUrl, undefined);
      assert.equal(ref.body, undefined);
      // And the object it points at really exists in storage.
      assert.ok(objects.has(`inspection-photos:${ref.path}`), `ref ${ref.key} points at a real object`);
    }
    // The pre-existing inspection fields still ride along.
    assert.equal(parsed.exterior, 'GOOD');
    assert.ok(parsed.odometer > 0);
  }

  // The swap itself still did its job.
  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleB.id);
  const agRow = await prisma.rentalAgreement.findUnique({ where: { id: agreement.id }, select: { vehicleId: true } });
  assert.equal(agRow.vehicleId, vehicleB.id);
  // beta.317 status sync must still fire on success.
  assert.equal(await statusOf(vehicleA.id), 'AVAILABLE', 'beta.317: swapped-out car released');
  assert.equal(await statusOf(vehicleB.id), 'ON_RENT', 'beta.317: replacement goes ON_RENT');
});

test('the audit log records refs, never base64', async () => {
  const { vehicleB, reservation } = await seedScenario();
  await reservationsService.swapVehicle(reservation.id, payload(vehicleB.id), scope);

  const log = await prisma.auditLog.findFirst({
    where: { reservationId: reservation.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' }
  });
  assert.ok(log?.metadata);
  assert.doesNotMatch(log.metadata, /data:image/, 'AuditLog.metadata must not carry photo bytes');
  const meta = JSON.parse(log.metadata);
  // `overridden` added 2026-07-17 with the ADMIN photo override: a normal swap
  // is explicitly NOT an override, and the flag says so on every row rather than
  // being inferred from absence.
  assert.deepEqual(meta.swapPhotos, { previous: 8, next: 8, required: 8, overridden: false });
  assert.deepEqual(meta.currentCheckin.photos, {});
  assert.equal(meta.nextCheckout.photoStorageRefs.length, 8);
});

test('an upload that does not land aborts the swap (read-back verify) — no half-swapped state', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario();
  // Simulate a write that silently does not persist.
  swapPhotosTest.setStorageAdapter({
    uploader: async () => ({ path: 'x' }),
    downloader: async () => ({ body: null })
  });
  try {
    await assert.rejects(
      () => reservationsService.swapVehicle(reservation.id, payload(vehicleB.id), scope),
      /could not be stored/
    );
  } finally {
    swapPhotosTest.setStorageAdapter({
      uploader: async ({ bucket, path, body, contentType }) => {
        objects.set(`${bucket}:${path}`, body);
        uploads.push({ bucket, path, contentType, size: body.byteLength });
        return { path };
      },
      downloader: async ({ bucket, path }) => ({ body: objects.get(`${bucket}:${path}`) || null })
    });
  }
  assert.equal(await statusOf(vehicleA.id), 'ON_RENT', 'nothing mutated when evidence could not be stored');
  assert.equal(await statusOf(vehicleB.id), 'AVAILABLE');
});
