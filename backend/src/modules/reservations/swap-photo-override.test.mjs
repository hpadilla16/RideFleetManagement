/**
 * DB-backed tests for the TWO additions Hector decided on 2026-07-17:
 *
 *  1. The DEALERSHIP-LOANER swap path is gated too. QA found the "hard block" was
 *     not authoritative: `POST /api/dealership-loaner/reservations/:id/swap-vehicle`
 *     is a second, live, UI-driven mid-rental swap that took `{vehicleId, note}`
 *     and moved a customer onto another car with ZERO photos. A gate on one of
 *     two live paths is not a gate.
 *
 *  2. ADMIN override with a MANDATORY reason + AuditLog(ADMIN_OVERRIDE). QA's
 *     point, which Hector accepted: with no way out, a failed iPad capture at 9pm
 *     means nobody can swap a car at all. The override bypasses the PHOTO
 *     requirement and NOTHING else — planner `force` semantics (beta.311): force
 *     bypasses rules, never occupancy.
 *
 * The `missingSlots` recorded on the override row is the field that makes the log
 * worth having: it is how Hector learns whether capture is failing systematically
 * or people are just skipping.
 *
 * Storage is stubbed via swap-photos' `__test.setStorageAdapter` (the repo's
 * established seam) so the suite needs no Supabase credentials.
 *
 * 🚨 DEV DB: `backend/.env` points DATABASE_URL at localhost:5433, which is NOT
 * running — run this against localhost:5432/fleet_management.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationsService } from './reservations.service.js';
import { dealershipLoanerService } from '../dealership-loaner/dealership-loaner.service.js';
import { SWAP_PHOTO_SLOTS, __test as swapPhotosTest } from './swap-photos.js';

const prisma = new PrismaClient();
const TAG = `SWP-OV-${Date.now()}`;

// `actorUserId` is a real FK (AuditLog_actorUserId_fkey) — the override row is
// only meaningful if it names a REAL user, so the suite seeds real ones rather
// than passing null.
const ids = { tenant: null, location: null, vehicleType: null, customer: null, admin: null, agent: null, vehicles: [], reservations: [], agreements: [] };
let scope = null;
let seq = 0;

const objects = new Map();
const previousStorageFlag = process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;

test.before(() => {
  process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'true';
  swapPhotosTest.setStorageAdapter({
    uploader: async ({ bucket, path, body }) => {
      objects.set(`${bucket}:${path}`, body);
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
  for (const userId of [ids.admin, ids.agent]) {
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  }
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where: { id: ids.vehicleType } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64 * 1024, 7)]);
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

/** `workflowMode` is what makes it a LOANER reservation to getLoanerReservationOrThrow. */
async function seedScenario({ workflowMode = 'RENTAL' } = {}) {
  const n = ++seq;
  const vehicleA = await createVehicle(`OA${n}`, 'ON_RENT');
  const vehicleB = await createVehicle(`OB${n}`, 'AVAILABLE');
  const pickupAt = new Date(Date.now() - 2 * 86400e3);
  const returnAt = new Date(Date.now() + 2 * 86400e3);

  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `RO${n}-${TAG}`,
      tenantId: ids.tenant,
      customerId: ids.customer,
      vehicleId: vehicleA.id,
      vehicleTypeId: ids.vehicleType,
      pickupLocationId: ids.location,
      returnLocationId: ids.location,
      pickupAt,
      returnAt,
      workflowMode,
      status: 'CHECKED_OUT'
    }
  });
  ids.reservations.push(reservation.id);

  const agreement = await prisma.rentalAgreement.create({
    data: {
      agreementNumber: `RAO${n}-${TAG}`,
      reservationId: reservation.id,
      tenantId: ids.tenant,
      vehicleId: vehicleA.id,
      pickupAt,
      returnAt,
      pickupLocationId: ids.location,
      returnLocationId: ids.location,
      customerFirstName: 'Swap',
      customerLastName: 'Override',
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

const payload = (vehicleId, { previousPhotos = fullPhotoSet(), nextPhotos = fullPhotoSet(), ...rest } = {}) => ({
  vehicleId,
  currentCheckin: { odometer: 41250, fuelLevel: '0.5', cleanliness: 4, photos: previousPhotos },
  nextCheckout: { odometer: 22000, fuelLevel: '1', cleanliness: 5, photos: nextPhotos },
  ...rest
});

const statusOf = async (vehicleId) =>
  (await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { status: true } }))?.status;

const overrideRowFor = async (reservationId) =>
  prisma.auditLog.findFirst({ where: { reservationId, action: 'ADMIN_OVERRIDE' }, orderBy: { createdAt: 'desc' } });

const adminUser = () => ({ sub: ids.admin, role: 'ADMIN', tenantId: ids.tenant });
const agentUser = () => ({ sub: ids.agent, role: 'AGENT', tenantId: ids.tenant });

test('setup', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;
  scope = { tenantId: tenant.id };
  ids.location = (await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: tenant.id } })).id;
  ids.vehicleType = (await prisma.vehicleType.create({ data: { tenantId: tenant.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact SUV' } })).id;
  ids.customer = (await prisma.customer.create({
    data: { firstName: 'Swap', lastName: 'Override', phone: '7875550166', email: `co-${TAG}@x.com`, tenantId: tenant.id }
  })).id;
  ids.admin = (await prisma.user.create({
    data: { tenantId: tenant.id, email: `admin-${TAG}@x.com`, passwordHash: 'x', fullName: 'Ada Admin', role: 'ADMIN' }
  })).id;
  ids.agent = (await prisma.user.create({
    data: { tenantId: tenant.id, email: `agent-${TAG}@x.com`, passwordHash: 'x', fullName: 'Gil Agent', role: 'AGENT' }
  })).id;
  assert.ok(scope.tenantId);
});

// ── CHANGE 1: the dealership-loaner path is gated too ────────────────────────

test('LOANER swap without photos is REJECTED — and nothing is mutated', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario({ workflowMode: 'DEALERSHIP_LOANER' });

  await assert.rejects(
    () => dealershipLoanerService.swapVehicle(agentUser(), reservation.id, { vehicleId: vehicleB.id, note: 'no photos' }),
    /Vehicle swap blocked: all 8 photos are required/
  );

  // The exact hole QA found: this used to succeed and move the customer's car.
  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleA.id, 'loaner reservation must not move to the replacement');
  assert.equal(await statusOf(vehicleA.id), 'ON_RENT');
  assert.equal(await statusOf(vehicleB.id), 'AVAILABLE');
});

test('LOANER swap with all 16 photos PASSES — refs (not base64) in the audit metadata', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario({ workflowMode: 'DEALERSHIP_LOANER' });

  await dealershipLoanerService.swapVehicle(agentUser(), reservation.id, payload(vehicleB.id, { note: 'tire noise' }));

  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleB.id, 'loaner reservation moves to the replacement');

  const log = await prisma.auditLog.findFirst({
    where: { reservationId: reservation.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' }
  });
  assert.doesNotMatch(log.metadata, /data:image/, 'AuditLog.metadata must not carry photo bytes (beta.310)');
  const meta = JSON.parse(log.metadata);
  assert.equal(meta.dealershipLoanerVehicleSwapped, true);
  assert.deepEqual(meta.swapPhotos, { previous: 8, next: 8, required: 8, overridden: false });
  assert.deepEqual(meta.currentCheckin.photos, {}, 'bytes stripped — refs only');
  assert.equal(meta.nextCheckout.photoStorageRefs.length, 8);
  // No photos were missing, so no override row exists.
  assert.equal(await overrideRowFor(reservation.id), null);
  // The gate did not cost the status sync.
  assert.equal(await statusOf(vehicleA.id), 'AVAILABLE');
  assert.equal(await statusOf(vehicleB.id), 'ON_RENT');
});

// ── CHANGE 2: ADMIN override, mandatory reason, AuditLog ─────────────────────

test('override WITHOUT a reason is REJECTED at the backend (empty and whitespace-only)', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario();

  for (const reason of [undefined, '', '   ', '\n\t ']) {
    await assert.rejects(
      () =>
        reservationsService.swapVehicle(
          reservation.id,
          payload(vehicleB.id, { previousPhotos: {}, nextPhotos: {}, photoOverride: { reason } }),
          scope,
          ids.agent,
          null,
          { isAdmin: true }
        ),
      (err) => {
        assert.match(err.message, /a reason is required to override/);
        assert.equal(err.status, 400);
        return true;
      },
      `reason ${JSON.stringify(reason)} must not pass`
    );
  }
  assert.equal(await statusOf(vehicleA.id), 'ON_RENT', 'nothing swapped');
});

test('a NON-ADMIN cannot override — they get the hard block, unchanged', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario();

  await assert.rejects(
    () =>
      reservationsService.swapVehicle(
        reservation.id,
        payload(vehicleB.id, { previousPhotos: {}, nextPhotos: {}, photoOverride: { reason: 'iPad camera died' } }),
        scope,
        ids.agent,
        null,
        { isAdmin: false }
      ),
    (err) => {
      assert.match(err.message, /only an ADMIN can override/);
      assert.equal(err.status, 403);
      return true;
    }
  );

  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleA.id);
  assert.equal(await overrideRowFor(reservation.id), null, 'a refused override writes no audit row');
});

test('the isAdmin flag comes from the SERVER, not the payload — a forged one is ignored', async () => {
  const { vehicleB, reservation } = await seedScenario();

  // A client posting isAdmin/role inside the body must not become an admin.
  await assert.rejects(
    () =>
      reservationsService.swapVehicle(
        reservation.id,
        payload(vehicleB.id, {
          previousPhotos: {},
          nextPhotos: {},
          photoOverride: { reason: 'trust me' },
          isAdmin: true,
          role: 'ADMIN',
          user: { role: 'SUPER_ADMIN' }
        }),
        scope,
        ids.agent,
        null,
        {} // the SERVER says: not an admin
      ),
    /only an ADMIN can override/
  );
});

test('override WITH a reason SUCCEEDS and writes ADMIN_OVERRIDE with the missing slots', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario();

  // Realistic partial failure: the incoming car got 6 of 8, the replacement none.
  const previousPhotos = fullPhotoSet();
  delete previousPhotos.trunk;
  delete previousPhotos.dashboard;

  await reservationsService.swapVehicle(
    reservation.id,
    payload(vehicleB.id, { previousPhotos, nextPhotos: {}, photoOverride: { reason: 'iPad camera dead, 9pm, customer waiting' } }),
    scope,
    ids.admin,
    '10.0.0.9',
    { isAdmin: true }
  );

  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleB.id, 'the swap goes through');

  const row = await overrideRowFor(reservation.id);
  assert.ok(row, 'an ADMIN_OVERRIDE row must exist');
  assert.equal(row.action, 'ADMIN_OVERRIDE');
  assert.equal(row.actorUserId, ids.admin, 'WHO');
  assert.equal(row.reservationId, reservation.id, 'WHICH reservation');
  assert.equal(row.reason, 'iPad camera dead, 9pm, customer waiting', 'the mandatory reason, verbatim');

  const meta = JSON.parse(row.metadata);
  assert.equal(meta.kind, 'swap_photo_override');
  assert.equal(meta.path, 'reservation_swap');
  assert.equal(meta.previousVehicleId, vehicleA.id, 'BOTH vehicle ids');
  assert.equal(meta.nextVehicleId, vehicleB.id);
  assert.equal(meta.actorIp, '10.0.0.9');
  // THE field that makes the log worth having.
  assert.deepEqual(meta.missingSlots.previous, ['trunk', 'dashboard'].sort(), 'exactly which slots were missing');
  assert.deepEqual(meta.missingSlots.next, [...SWAP_PHOTO_SLOTS], 'the replacement captured nothing');
  assert.equal(meta.missingCount, 10);
  assert.equal(meta.capturedCount, 6);
  assert.equal(meta.requiredCount, 16);
  assert.doesNotMatch(row.metadata, /data:image/, 'the override row carries no bytes either');
});

test('an override still STORES the photos that WERE captured — as refs, never inline', async () => {
  const { vehicleB, reservation } = await seedScenario();
  const previousPhotos = fullPhotoSet();
  delete previousPhotos.trunk;

  await reservationsService.swapVehicle(
    reservation.id,
    payload(vehicleB.id, { previousPhotos, nextPhotos: {}, photoOverride: { reason: 'camera failed on the replacement' } }),
    scope,
    ids.admin,
    null,
    { isAdmin: true }
  );

  const swap = await prisma.rentalAgreementVehicleSwap.findFirst({
    where: { nextVehicleId: vehicleB.id },
    orderBy: { createdAt: 'desc' }
  });
  const previousStored = JSON.parse(swap.previousInspectionJson);
  const nextStored = JSON.parse(swap.nextInspectionJson);

  assert.equal(previousStored.photoStorageRefs.length, 7, 'the 7 that were captured are stored');
  assert.equal(nextStored.photoStorageRefs.length, 0, 'the car with no photos stores none');
  assert.deepEqual(previousStored.photos, {}, 'refs only — no inline bytes on the override path');
  assert.deepEqual(nextStored.photos, {});
  assert.doesNotMatch(swap.previousInspectionJson, /data:image/, 'beta.310 guard holds on the override path');
  assert.doesNotMatch(swap.nextInspectionJson, /data:image/);
});

test('the override does NOT bypass the status sync', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario();

  await reservationsService.swapVehicle(
    reservation.id,
    payload(vehicleB.id, { previousPhotos: {}, nextPhotos: {}, photoOverride: { reason: 'total capture failure' } }),
    scope,
    ids.admin,
    null,
    { isAdmin: true }
  );

  // force bypasses RULES, never occupancy (planner beta.311 semantics).
  assert.equal(await statusOf(vehicleA.id), 'AVAILABLE', 'the swapped-out car is released');
  assert.equal(await statusOf(vehicleB.id), 'ON_RENT', 'the replacement goes ON_RENT');
});

test('the override does NOT bypass the swap business rules (occupancy is still enforced)', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario();

  // vehicleB is already out on another overlapping rental.
  const other = await prisma.reservation.create({
    data: {
      reservationNumber: `RX-${TAG}-${++seq}`,
      tenantId: ids.tenant,
      customerId: ids.customer,
      vehicleId: vehicleB.id,
      vehicleTypeId: ids.vehicleType,
      pickupLocationId: ids.location,
      returnLocationId: ids.location,
      pickupAt: new Date(Date.now() - 86400e3),
      returnAt: new Date(Date.now() + 86400e3),
      status: 'CHECKED_OUT'
    }
  });
  ids.reservations.push(other.id);

  await assert.rejects(
    () =>
      reservationsService.swapVehicle(
        reservation.id,
        payload(vehicleB.id, { previousPhotos: {}, nextPhotos: {}, photoOverride: { reason: 'give me that car anyway' } }),
        scope,
        ids.admin,
        null,
        { isAdmin: true }
      ),
    // NOT a photo error — the occupancy rule, which the override must never touch.
    (err) => {
      assert.doesNotMatch(err.message, /photos are required/);
      return true;
    }
  );

  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleA.id, 'the reservation kept its car');
});

test('an override on a COMPLETE 16-photo set is a no-op — no ADMIN_OVERRIDE row', async () => {
  const { vehicleB, reservation } = await seedScenario();

  await reservationsService.swapVehicle(
    reservation.id,
    payload(vehicleB.id, { photoOverride: { reason: 'opened the panel then shot them anyway' } }),
    scope,
    ids.admin,
    null,
    { isAdmin: true }
  );

  // Otherwise the "is capture failing systematically?" signal would be polluted
  // by overrides that bypassed nothing.
  assert.equal(await overrideRowFor(reservation.id), null);
});

// ── the override reaches the LOANER path too (a gap in one is the same bug) ──

test('LOANER override: ADMIN with a reason succeeds and writes ADMIN_OVERRIDE tagged to that path', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario({ workflowMode: 'DEALERSHIP_LOANER' });
  const previousPhotos = fullPhotoSet();
  delete previousPhotos.front;

  await dealershipLoanerService.swapVehicle(
    adminUser(),
    reservation.id,
    payload(vehicleB.id, { previousPhotos, nextPhotos: {}, photoOverride: { reason: 'loaner lot has no signal' } })
  );

  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleB.id);

  const row = await overrideRowFor(reservation.id);
  assert.ok(row, 'the loaner path writes the override row too');
  assert.equal(row.reason, 'loaner lot has no signal');
  const meta = JSON.parse(row.metadata);
  assert.equal(meta.kind, 'swap_photo_override');
  assert.equal(meta.path, 'dealership_loaner_swap', 'the path is identifiable in the log');
  assert.equal(meta.previousVehicleId, vehicleA.id);
  assert.equal(meta.nextVehicleId, vehicleB.id);
  assert.deepEqual(meta.missingSlots.previous, ['front']);
  assert.equal(meta.missingCount, 9);

  // Still synced — the override bought photos, not a free pass.
  assert.equal(await statusOf(vehicleA.id), 'AVAILABLE');
  assert.equal(await statusOf(vehicleB.id), 'ON_RENT');
});

test('LOANER override: a NON-ADMIN is refused with 403 and swaps nothing', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario({ workflowMode: 'DEALERSHIP_LOANER' });

  await assert.rejects(
    () =>
      dealershipLoanerService.swapVehicle(
        agentUser(),
        reservation.id,
        payload(vehicleB.id, { previousPhotos: {}, nextPhotos: {}, photoOverride: { reason: 'let me through' } })
      ),
    (err) => {
      assert.match(err.message, /only an ADMIN can override/);
      assert.equal(err.status, 403);
      return true;
    }
  );

  const resRow = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { vehicleId: true } });
  assert.equal(resRow.vehicleId, vehicleA.id);
  assert.equal(await statusOf(vehicleA.id), 'ON_RENT');
});

test('LOANER override without a reason is REJECTED (400) even for an ADMIN', async () => {
  const { vehicleA, vehicleB, reservation } = await seedScenario({ workflowMode: 'DEALERSHIP_LOANER' });

  await assert.rejects(
    () =>
      dealershipLoanerService.swapVehicle(
        adminUser(),
        reservation.id,
        payload(vehicleB.id, { previousPhotos: {}, nextPhotos: {}, photoOverride: { reason: '   ' } })
      ),
    (err) => {
      assert.match(err.message, /a reason is required to override/);
      assert.equal(err.status, 400);
      return true;
    }
  );
  assert.equal(await statusOf(vehicleA.id), 'ON_RENT');
});
