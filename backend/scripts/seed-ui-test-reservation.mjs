/**
 * Seed a test reservation in CONFIRMED state for UI smoke testing.
 * Does NOT run the orchestrator — leaves the reservation ready for an agent
 * to walk through the checkout wizard manually in the browser.
 *
 * Companion to local-smoke-counter-checkin.mjs (which DOES run the orchestrator).
 *
 * Usage:
 *   docker compose exec backend node scripts/seed-ui-test-reservation.mjs
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TENANT_ID = 'cmnoom8fc0000v9tkexfqa5q6';  // local-dev tenant (from seed-bootstrap)
const LOCATION_ID = 'cmnoom8fh0002v9tkyd1tykvi'; // SJU

const TEST_RES_ID = 'cmuitestreservation0001';
const TEST_VEHICLE_ID = 'cmuitestvehicle0001';
const TEST_CUSTOMER_ID = 'cmuitestcustomer0001';

async function main() {
  console.log('=== Seeding UI test reservation ===\n');

  const tenant = await prisma.tenant.findUnique({
    where: { id: TENANT_ID },
    select: { id: true, name: true, settingsJson: true },
  });
  if (!tenant) throw new Error(`local-dev tenant ${TENANT_ID} not found — run seed-bootstrap first`);

  const vtypes = await prisma.vehicleType.findMany({ where: { tenantId: TENANT_ID }, take: 1 });
  if (vtypes.length === 0) throw new Error('No VehicleType rows — re-run seed-bootstrap');
  const vtypeId = vtypes[0].id;

  await prisma.vehicle.upsert({
    where: { id: TEST_VEHICLE_ID },
    update: {},
    create: {
      id: TEST_VEHICLE_ID,
      tenantId: TENANT_ID,
      homeLocationId: LOCATION_ID,
      vehicleTypeId: vtypeId,
      internalNumber: 'UI-TEST-001',
      plate: 'UITEST001',
      make: 'Toyota',
      model: 'Corolla',
      year: 2024,
      status: 'AVAILABLE',
      mileage: 1234,
    },
  });
  console.log('Vehicle:', TEST_VEHICLE_ID);

  await prisma.customer.upsert({
    where: { id: TEST_CUSTOMER_ID },
    update: {},
    create: {
      id: TEST_CUSTOMER_ID,
      tenantId: TENANT_ID,
      firstName: 'UI',
      lastName: 'Tester',
      email: 'ui-tester@local.dev',
      phone: '555-0200',
      licenseNumber: 'PR-UI-TEST-1',
    },
  });
  console.log('Customer:', TEST_CUSTOMER_ID);

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600_000);
  const inThreeDays = new Date(now.getTime() + 3 * 24 * 3600_000);

  // Wipe any prior state on this reservation so the wizard starts fresh.
  await prisma.reservationSigningField.deleteMany({
    where: { signing: { reservationId: TEST_RES_ID } },
  });
  await prisma.reservationSigning.deleteMany({ where: { reservationId: TEST_RES_ID } });
  await prisma.dejavooTransaction.deleteMany({ where: { reservationId: TEST_RES_ID } });
  await prisma.reservationCharge.deleteMany({ where: { reservationId: TEST_RES_ID } });

  await prisma.reservation.upsert({
    where: { id: TEST_RES_ID },
    update: {
      status: 'CONFIRMED',
      signingCompletedAt: null,
      rentalFeeCollectedAt: null,
      rentalFeeCollectedCents: null,
    },
    create: {
      id: TEST_RES_ID,
      tenantId: TENANT_ID,
      reservationNumber: 'UI-TEST-001',
      customerId: TEST_CUSTOMER_ID,
      vehicleId: TEST_VEHICLE_ID,
      pickupLocationId: LOCATION_ID,
      returnLocationId: LOCATION_ID,
      pickupAt: tomorrow,
      returnAt: inThreeDays,
      estimatedTotal: 225,
      status: 'CONFIRMED',
    },
  });
  console.log('Reservation:', TEST_RES_ID);

  await prisma.reservationCharge.create({
    data: {
      reservationId: TEST_RES_ID,
      name: 'Base rate',
      quantity: 3,
      rate: 75,
      total: 225,
      selected: true,
    },
  });
  console.log('Charge: Base rate $225\n');

  console.log('=== READY ===');
  console.log('Open: http://localhost:3000');
  console.log('Login: admin@ridefleet.com / Ride1234!');
  console.log('Navigate to: Reservations → click on "UI-TEST-001" or use the reservation id directly');
  console.log(`Wizard URL: http://localhost:3000/reservations/${TEST_RES_ID}/checkout-wizard`);
  console.log('');
  console.log('Expected behavior on step 1 (Signature):');
  console.log('  - Shows the NEW Dejavoo terminal UI (not the legacy SignaturePad)');
  console.log('  - Click "Start signing on terminal"');
  console.log('  - Mocked SPIn responses: SALE + AUTH both approve');
  console.log('  - Progress UI shows completion');
  console.log('  - Wizard moves to step 2 (photos)');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  await prisma.$disconnect();
  process.exit(1);
});
