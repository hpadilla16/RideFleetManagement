/**
 * Local smoke test for round 25 — runs the counter checkin orchestrator
 * end-to-end against the local dev DB with SPIN_MOCK=true.
 *
 * What it does:
 *   1. Creates minimal test data: Customer, Vehicle, RentalAgreement,
 *      Reservation, ReservationCharge.
 *   2. Calls runCounterCheckinFlow() directly (bypasses the route handler).
 *   3. Reports the result + the DB rows that were written.
 *
 * Usage (from inside the backend container):
 *   docker compose exec backend node scripts/local-smoke-counter-checkin.mjs
 */

import { PrismaClient } from '@prisma/client';
import { runCounterCheckinFlow } from '../src/modules/payment-gateway/counter-orchestrator.service.js';

const prisma = new PrismaClient();

const TENANT_ID = 'cmnoom8fc0000v9tkexfqa5q6';      // local-dev tenant
const TERMINAL_ID = 'cmlocaldevterminal0001';        // local mock terminal
const LOCATION_ID = 'cmnoom8fh0002v9tkyd1tykvi';     // SJU (from seed-bootstrap)

const TEST_RES_ID = 'cmsmoketestreservation01';
const TEST_VEHICLE_ID = 'cmsmoketestvehicle01';
const TEST_CUSTOMER_ID = 'cmsmoketestcustomer01';

async function main() {
  console.log('=== Round 25 local smoke test ===\n');

  // 0. Sanity: confirm flags and terminal are configured.
  const tenant = await prisma.tenant.findUnique({
    where: { id: TENANT_ID },
    select: { id: true, name: true, settingsJson: true },
  });
  if (!tenant) throw new Error(`local-dev tenant ${TENANT_ID} not found — seed it first`);
  const flags = tenant.settingsJson?.featureFlags || {};
  console.log('Tenant flags:', flags);
  if (flags.interactiveTC !== 'LIVE' || flags.dejavooCounter !== 'LIVE') {
    throw new Error('Feature flags not LIVE — re-run the local-smoke-setup.sh psql block');
  }

  const terminal = await prisma.dejavooTerminal.findUnique({ where: { id: TERMINAL_ID } });
  if (!terminal) throw new Error(`local terminal ${TERMINAL_ID} not found`);
  console.log('Terminal:', terminal.name, '(TPN', terminal.tpn + ')');

  if (process.env.SPIN_MOCK !== 'true') {
    throw new Error('SPIN_MOCK=true must be set — check backend/.env and restart the container');
  }
  console.log('SPIN_MOCK=true ✓\n');

  // 1. Create / upsert test entities. Idempotent so we can re-run.
  console.log('--- Seeding test data ---');

  // Vehicle — needs a vehicleType. Pick the first one from local-dev.
  const vtypes = await prisma.vehicleType.findMany({ where: { tenantId: TENANT_ID }, take: 1 });
  if (vtypes.length === 0) throw new Error('No VehicleType rows found — re-run seed-bootstrap');
  const vtypeId = vtypes[0].id;

  await prisma.vehicle.upsert({
    where: { id: TEST_VEHICLE_ID },
    update: {},
    create: {
      id: TEST_VEHICLE_ID,
      tenantId: TENANT_ID,
      homeLocationId: LOCATION_ID,
      vehicleTypeId: vtypeId,
      internalNumber: 'SMOKE-001',
      plate: 'SMOKE001',
      make: 'Toyota',
      model: 'Corolla',
      year: 2024,
      status: 'AVAILABLE',
      mileage: 1234,
    },
  });
  console.log('Vehicle:', TEST_VEHICLE_ID);

  // Customer — needs minimum fields for orchestrator.
  await prisma.customer.upsert({
    where: { id: TEST_CUSTOMER_ID },
    update: {},
    create: {
      id: TEST_CUSTOMER_ID,
      tenantId: TENANT_ID,
      firstName: 'Smoke',
      lastName: 'Test',
      email: 'smoke@test.local',
      phone: '555-0100',
      licenseNumber: 'PR-SMOKE-1',
    },
  });
  console.log('Customer:', TEST_CUSTOMER_ID);

  // Reservation — minimum for orchestrator to read.
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600_000);
  const inThreeDays = new Date(now.getTime() + 3 * 24 * 3600_000);

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
      reservationNumber: 'SMOKE-001',
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

  // Charge — selected, totals to $225 (rental fee)
  await prisma.reservationCharge.deleteMany({ where: { reservationId: TEST_RES_ID } });
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
  console.log('Charge: Base rate $225 (3 days @ $75)\n');

  // Wipe any prior signing state so we test from a clean slate.
  await prisma.reservationSigningField.deleteMany({
    where: { signing: { reservationId: TEST_RES_ID } },
  });
  await prisma.reservationSigning.deleteMany({ where: { reservationId: TEST_RES_ID } });
  await prisma.dejavooTransaction.deleteMany({ where: { reservationId: TEST_RES_ID } });

  // 2. Call the orchestrator.
  //
  // Stub storage (uploadSignatureBlob) since local dev has no Supabase
  // configured. We just return a fake storage path — the orchestrator
  // doesn't read it back, just persists the path on ReservationSigningField.
  const stubStorage = {
    uploadSignatureBlob: async (args) => ({
      storagePath: `local-mock/${args.tenantId}/${args.reservationId}/${args.kind}-${args.fieldKey}.png`,
      contentType: 'image/png',
      sizeBytes: args.body?.length || 100,
    }),
  };
  console.log('--- Running runCounterCheckinFlow ---');
  const user = { sub: 'cmnoom8iy000fv9tk4v5lntmc', role: 'SUPER_ADMIN', tenantId: TENANT_ID };
  let result;
  try {
    result = await runCounterCheckinFlow({
      reservationId: TEST_RES_ID,
      terminalId: TERMINAL_ID,
      user,
      deps: { storage: stubStorage },
    });
  } catch (err) {
    console.error('Orchestrator threw:', err.message);
    console.error(err);
    process.exit(1);
  }
  console.log('Result:', JSON.stringify(result, null, 2));

  // 3. Verify DB state.
  console.log('\n--- DB state after run ---');
  const signing = await prisma.reservationSigning.findUnique({
    where: { reservationId: TEST_RES_ID },
  });
  console.log('ReservationSigning:', {
    id: signing?.id,
    completedAt: signing?.completedAt,
    customerCardLast4: signing?.customerCardLast4,
    surfaceUsed: signing?.surfaceUsed,
  });

  const fields = await prisma.reservationSigningField.findMany({
    where: { signingId: signing?.id },
    include: { templateField: { select: { kind: true, markerKey: true } } },
  });
  console.log(`ReservationSigningField rows: ${fields.length}`);
  for (const f of fields) {
    console.log('  ', f.templateField?.kind, f.templateField?.markerKey,
      '→ sig:', !!f.signatureSvgOrPath, 'val:', f.value);
  }

  const txs = await prisma.dejavooTransaction.findMany({
    where: { reservationId: TEST_RES_ID },
    orderBy: { startedAt: 'asc' },
  });
  console.log(`DejavooTransaction rows: ${txs.length}`);
  for (const t of txs) {
    console.log('  ', t.type, '→ approved:', t.approved, 'statusCode:', t.statusCode);
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id: TEST_RES_ID },
    select: {
      signingCompletedAt: true,
      rentalFeeCollectedAt: true,
      rentalFeeCollectedCents: true,
    },
  });
  console.log('Reservation:', reservation);

  const customer = await prisma.customer.findUnique({
    where: { id: TEST_CUSTOMER_ID },
    select: {
      dejavooIposToken: true,
      dejavooCardLast4: true,
      dejavooCardBrand: true,
    },
  });
  console.log('Customer card-on-file:', customer);

  console.log('\n=== Done ===');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  await prisma.$disconnect();
  process.exit(1);
});
