import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TENANT_ID = 'cmn6d5ax80002s10izy80l4ei';
const PREFIX = 'DEMO';

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function futureDate(daysFromNow, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function pastDate(daysAgo, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d;
}

const tenantConnect = { tenant: { connect: { id: TENANT_ID } } };

async function upsertLocation(codeSuffix, payload) {
  const code = `${PREFIX}-${codeSuffix}`;
  const existing = await prisma.location.findUnique({
    where: { tenantId_code: { tenantId: TENANT_ID, code } }
  });
  if (existing) {
    return prisma.location.update({ where: { id: existing.id }, data: payload });
  }
  return prisma.location.create({ data: { ...tenantConnect, code, ...payload } });
}

async function upsertVehicleType(codeSuffix, payload) {
  const code = `${PREFIX}-${codeSuffix}`;
  const existing = await prisma.vehicleType.findFirst({ where: { tenantId: TENANT_ID, code } });
  if (existing) {
    return prisma.vehicleType.update({ where: { id: existing.id }, data: payload });
  }
  return prisma.vehicleType.create({ data: { ...tenantConnect, code, ...payload } });
}

async function upsertVehicle(internalNumber, payload) {
  const existing = await prisma.vehicle.findUnique({ where: { internalNumber } });
  if (existing) {
    return prisma.vehicle.update({ where: { id: existing.id }, data: payload });
  }
  const { vehicleTypeId, homeLocationId, ...rest } = payload;
  const createData = { ...tenantConnect, internalNumber, ...rest, vehicleType: { connect: { id: vehicleTypeId } } };
  if (homeLocationId) createData.homeLocation = { connect: { id: homeLocationId } };
  return prisma.vehicle.create({ data: createData });
}

async function upsertCustomer(phone, payload) {
  const existing = await prisma.customer.findFirst({ where: { tenantId: TENANT_ID, phone } });
  if (existing) {
    return prisma.customer.update({ where: { id: existing.id }, data: payload });
  }
  return prisma.customer.create({ data: { ...tenantConnect, phone, ...payload } });
}

async function upsertFee(code, payload) {
  const existing = await prisma.fee.findUnique({ where: { tenantId_code: { tenantId: TENANT_ID, code } } });
  if (existing) {
    return prisma.fee.update({ where: { id: existing.id }, data: payload });
  }
  return prisma.fee.create({ data: { ...tenantConnect, code, ...payload } });
}

async function upsertService(code, payload) {
  const existing = await prisma.additionalService.findFirst({ where: { tenantId: TENANT_ID, code } });
  if (existing) {
    return prisma.additionalService.update({ where: { id: existing.id }, data: payload });
  }
  return prisma.additionalService.create({ data: { ...tenantConnect, code, ...payload } });
}

async function upsertReservation(reservationNumber, payload) {
  const existing = await prisma.reservation.findUnique({ where: { reservationNumber } });
  if (existing) {
    return prisma.reservation.update({ where: { id: existing.id }, data: payload });
  }
  const { customerId, vehicleId, vehicleTypeId, pickupLocationId, returnLocationId, ...rest } = payload;
  const createData = {
    ...tenantConnect, reservationNumber, ...rest,
    customer: { connect: { id: customerId } },
    pickupLocation: { connect: { id: pickupLocationId } },
    returnLocation: { connect: { id: returnLocationId } },
  };
  if (vehicleId) createData.vehicle = { connect: { id: vehicleId } };
  if (vehicleTypeId) createData.vehicleType = { connect: { id: vehicleTypeId } };
  return prisma.reservation.create({ data: createData });
}

async function main() {
  console.log('Seeding demo tenant data...');

  // --- Locations ---
  const locMIA = await upsertLocation('MIA', {
    name: 'Miami International Airport',
    address: '2100 NW 42nd Ave',
    city: 'Miami',
    state: 'FL',

    country: 'United States',
    taxRate: money(7),
    isActive: true,
    locationConfig: JSON.stringify({
      requireDeposit: true,
      depositMode: 'FIXED',
      depositAmount: 100,
      requireSecurityDeposit: true,
      securityDepositAmount: 250,
      gracePeriodMin: 30
    })
  });

  const locFLL = await upsertLocation('FLL', {
    name: 'Fort Lauderdale Airport',
    address: '100 Terminal Dr',
    city: 'Fort Lauderdale',
    state: 'FL',

    country: 'United States',
    taxRate: money(7),
    isActive: true,
    locationConfig: JSON.stringify({
      requireDeposit: true,
      depositMode: 'PERCENTAGE',
      depositAmount: 25,
      requireSecurityDeposit: false,
      gracePeriodMin: 30
    })
  });

  const locDTN = await upsertLocation('DTN', {
    name: 'Downtown Miami',
    address: '150 SE 2nd Ave',
    city: 'Miami',
    state: 'FL',

    country: 'United States',
    taxRate: money(7),
    isActive: true,
    locationConfig: JSON.stringify({
      requireDeposit: true,
      depositMode: 'FIXED',
      depositAmount: 75,
      gracePeriodMin: 60
    })
  });

  console.log('  Locations created');

  // --- Vehicle Types ---
  const vtEcon = await upsertVehicleType('ECON', { name: 'Economy', description: 'Compact and fuel-efficient sedans' });
  const vtStd = await upsertVehicleType('STD', { name: 'Standard', description: 'Mid-size sedans with extra comfort' });
  const vtSUV = await upsertVehicleType('SUV', { name: 'SUV', description: 'Sport utility vehicles for families and groups' });
  const vtLux = await upsertVehicleType('LUX', { name: 'Luxury', description: 'Premium vehicles for a first-class experience' });
  const vtVan = await upsertVehicleType('VAN', { name: 'Minivan', description: 'Spacious minivans for large groups' });

  console.log('  Vehicle types created');

  // --- Vehicles ---
  const vehicles = await Promise.all([
    // Economy fleet
    upsertVehicle('DEMO-001', { vin: 'DEMO00000000000001', plate: 'DMO-001', make: 'Toyota', model: 'Corolla', year: 2025, color: 'White', mileage: 8200, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtEcon.id, homeLocationId: locMIA.id }),
    upsertVehicle('DEMO-002', { vin: 'DEMO00000000000002', plate: 'DMO-002', make: 'Honda', model: 'Civic', year: 2025, color: 'Silver', mileage: 12400, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtEcon.id, homeLocationId: locMIA.id }),
    upsertVehicle('DEMO-003', { vin: 'DEMO00000000000003', plate: 'DMO-003', make: 'Nissan', model: 'Versa', year: 2024, color: 'Blue', mileage: 18500, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtEcon.id, homeLocationId: locFLL.id }),
    // Standard fleet
    upsertVehicle('DEMO-004', { vin: 'DEMO00000000000004', plate: 'DMO-004', make: 'Toyota', model: 'Camry', year: 2025, color: 'Black', mileage: 5600, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtStd.id, homeLocationId: locMIA.id }),
    upsertVehicle('DEMO-005', { vin: 'DEMO00000000000005', plate: 'DMO-005', make: 'Honda', model: 'Accord', year: 2025, color: 'Gray', mileage: 9800, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtStd.id, homeLocationId: locFLL.id }),
    upsertVehicle('DEMO-006', { vin: 'DEMO00000000000006', plate: 'DMO-006', make: 'Hyundai', model: 'Sonata', year: 2024, color: 'White', mileage: 22100, status: 'MAINTENANCE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtStd.id, homeLocationId: locDTN.id }),
    // SUV fleet
    upsertVehicle('DEMO-007', { vin: 'DEMO00000000000007', plate: 'DMO-007', make: 'Toyota', model: 'RAV4', year: 2025, color: 'Red', mileage: 7300, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtSUV.id, homeLocationId: locMIA.id }),
    upsertVehicle('DEMO-008', { vin: 'DEMO00000000000008', plate: 'DMO-008', make: 'Ford', model: 'Explorer', year: 2025, color: 'Blue', mileage: 11200, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtSUV.id, homeLocationId: locFLL.id }),
    upsertVehicle('DEMO-009', { vin: 'DEMO00000000000009', plate: 'DMO-009', make: 'Chevrolet', model: 'Equinox', year: 2024, color: 'Silver', mileage: 19400, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtSUV.id, homeLocationId: locDTN.id }),
    // Luxury fleet
    upsertVehicle('DEMO-010', { vin: 'DEMO00000000000010', plate: 'DMO-010', make: 'BMW', model: '5 Series', year: 2025, color: 'Black', mileage: 3200, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtLux.id, homeLocationId: locMIA.id }),
    upsertVehicle('DEMO-011', { vin: 'DEMO00000000000011', plate: 'DMO-011', make: 'Mercedes-Benz', model: 'E-Class', year: 2025, color: 'White', mileage: 4800, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtLux.id, homeLocationId: locFLL.id }),
    // Minivan fleet
    upsertVehicle('DEMO-012', { vin: 'DEMO00000000000012', plate: 'DMO-012', make: 'Chrysler', model: 'Pacifica', year: 2025, color: 'Gray', mileage: 6700, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtVan.id, homeLocationId: locMIA.id }),
    // Rented out vehicles
    upsertVehicle('DEMO-013', { vin: 'DEMO00000000000013', plate: 'DMO-013', make: 'Kia', model: 'Forte', year: 2025, color: 'Red', mileage: 14200, status: 'RENTED', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtEcon.id, homeLocationId: locMIA.id }),
    upsertVehicle('DEMO-014', { vin: 'DEMO00000000000014', plate: 'DMO-014', make: 'Hyundai', model: 'Tucson', year: 2025, color: 'Black', mileage: 8900, status: 'RENTED', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtSUV.id, homeLocationId: locFLL.id }),
    upsertVehicle('DEMO-015', { vin: 'DEMO00000000000015', plate: 'DMO-015', make: 'Toyota', model: 'Highlander', year: 2024, color: 'White', mileage: 25600, status: 'AVAILABLE', fleetMode: 'RENTAL_ONLY', vehicleTypeId: vtSUV.id, homeLocationId: locMIA.id }),
  ]);

  console.log(`  ${vehicles.length} vehicles created`);

  // --- Customers ---
  const customers = await Promise.all([
    upsertCustomer('+13055550101', { firstName: 'Maria', lastName: 'Rodriguez', email: 'maria.rodriguez@example.com', licenseNumber: 'R123-456-78', licenseState: 'FL', city: 'Miami', state: 'FL' }),
    upsertCustomer('+13055550102', { firstName: 'James', lastName: 'Thompson', email: 'james.thompson@example.com', licenseNumber: 'T234-567-89', licenseState: 'FL', city: 'Fort Lauderdale', state: 'FL' }),
    upsertCustomer('+13055550103', { firstName: 'Sophia', lastName: 'Chen', email: 'sophia.chen@example.com', licenseNumber: 'C345-678-90', licenseState: 'NY', city: 'New York', state: 'NY' }),
    upsertCustomer('+13055550104', { firstName: 'David', lastName: 'Martinez', email: 'david.martinez@example.com', licenseNumber: 'M456-789-01', licenseState: 'TX', city: 'Houston', state: 'TX' }),
    upsertCustomer('+13055550105', { firstName: 'Emily', lastName: 'Johnson', email: 'emily.johnson@example.com', licenseNumber: 'J567-890-12', licenseState: 'CA', city: 'Los Angeles', state: 'CA' }),
    upsertCustomer('+13055550106', { firstName: 'Carlos', lastName: 'Reyes', email: 'carlos.reyes@example.com', licenseNumber: 'R678-901-23', licenseState: 'FL', city: 'Miami Beach', state: 'FL' }),
    upsertCustomer('+13055550107', { firstName: 'Sarah', lastName: 'Williams', email: 'sarah.williams@example.com', licenseNumber: 'W789-012-34', licenseState: 'IL', city: 'Chicago', state: 'IL' }),
    upsertCustomer('+13055550108', { firstName: 'Michael', lastName: 'Brown', email: 'michael.brown@example.com', licenseNumber: 'B890-123-45', licenseState: 'FL', city: 'Orlando', state: 'FL' }),
    upsertCustomer('+13055550109', { firstName: 'Ana', lastName: 'Garcia', email: 'ana.garcia@example.com', licenseNumber: 'G901-234-56', licenseState: 'PR', city: 'San Juan', state: 'PR' }),
    upsertCustomer('+13055550110', { firstName: 'Robert', lastName: 'Davis', email: 'robert.davis@example.com', licenseNumber: 'D012-345-67', licenseState: 'GA', city: 'Atlanta', state: 'GA' }),
  ]);

  console.log(`  ${customers.length} customers created`);

  // --- Rate ---
  const rateCode = `${PREFIX}-STANDARD`;
  let rate = await prisma.rate.findUnique({ where: { tenantId_rateCode: { tenantId: TENANT_ID, rateCode } }, include: { rateItems: true } });
  if (rate) {
    await prisma.rateItem.deleteMany({ where: { rateId: rate.id } });
    rate = await prisma.rate.update({
      where: { id: rate.id },
      data: {
        name: 'Standard Daily Rates',
        rateType: 'MULTIPLE_CLASSES',
        calculationBy: '24_HOUR_TIME',
        averageBy: 'DATE_RANGE',
        displayOnline: true,
        active: true,
        isActive: true,
        monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true
      }
    });
  } else {
    rate = await prisma.rate.create({
      data: {
        ...tenantConnect,
        rateCode,
        name: 'Standard Daily Rates',
        rateType: 'MULTIPLE_CLASSES',
        calculationBy: '24_HOUR_TIME',
        averageBy: 'DATE_RANGE',
        displayOnline: true,
        active: true,
        isActive: true,
        monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true
      }
    });
  }

  await prisma.rateItem.createMany({
    data: [
      { rateId: rate.id, vehicleTypeId: vtEcon.id, daily: money(39), weekly: money(234), monthly: money(890), extraDaily: money(39), minDaily: 1, minWeekly: 7, minMonthly: 30, sortOrder: 0 },
      { rateId: rate.id, vehicleTypeId: vtStd.id, daily: money(49), weekly: money(294), monthly: money(1100), extraDaily: money(49), minDaily: 1, minWeekly: 7, minMonthly: 30, sortOrder: 1 },
      { rateId: rate.id, vehicleTypeId: vtSUV.id, daily: money(65), weekly: money(390), monthly: money(1450), extraDaily: money(65), minDaily: 1, minWeekly: 7, minMonthly: 30, sortOrder: 2 },
      { rateId: rate.id, vehicleTypeId: vtLux.id, daily: money(120), weekly: money(720), monthly: money(2800), extraDaily: money(120), minDaily: 1, minWeekly: 7, minMonthly: 30, sortOrder: 3 },
      { rateId: rate.id, vehicleTypeId: vtVan.id, daily: money(75), weekly: money(450), monthly: money(1700), extraDaily: money(75), minDaily: 1, minWeekly: 7, minMonthly: 30, sortOrder: 4 },
    ]
  });

  console.log('  Rates created');

  // --- Fees ---
  const feeAirport = await upsertFee('DEMO-AIRPORT', { name: 'Airport Surcharge', description: 'Airport facility charge', mode: 'FIXED', amount: money(15), taxable: true, isActive: true, mandatory: true });
  const feeYoung = await upsertFee('DEMO-YOUNG', { name: 'Young Driver Fee', description: 'Fee for drivers under 25', mode: 'PER_DAY', amount: money(12), taxable: true, isActive: true, mandatory: false, isUnderageFee: true });
  const feeAdditional = await upsertFee('DEMO-ADDL-DRIVER', { name: 'Additional Driver Fee', description: 'Fee per additional authorized driver', mode: 'PER_DAY', amount: money(10), taxable: true, isActive: true, mandatory: false, isAdditionalDriverFee: true });

  // Link airport fee to MIA and FLL locations
  for (const loc of [locMIA, locFLL]) {
    await prisma.locationFee.upsert({
      where: { locationId_feeId: { locationId: loc.id, feeId: feeAirport.id } },
      update: {},
      create: { locationId: loc.id, feeId: feeAirport.id }
    });
  }

  console.log('  Fees created');

  // --- Additional Services ---
  await upsertService('DEMO-GPS', { name: 'GPS Navigation', description: 'Portable GPS unit', chargeType: 'UNIT', rate: money(8), unitLabel: 'Unit', displayOnline: true, taxable: true, sortOrder: 0 });
  await upsertService('DEMO-CHILDSEAT', { name: 'Child Safety Seat', description: 'Infant or toddler car seat', chargeType: 'UNIT', rate: money(10), unitLabel: 'Seat', displayOnline: true, taxable: true, sortOrder: 1 });
  await upsertService('DEMO-WIFI', { name: 'Mobile Wi-Fi Hotspot', description: 'Portable Wi-Fi device for your trip', chargeType: 'UNIT', rate: money(12), unitLabel: 'Unit', displayOnline: true, taxable: true, sortOrder: 2 });
  await upsertService('DEMO-PREPAY-FUEL', { name: 'Prepaid Fuel', description: 'Return the car at any fuel level', chargeType: 'UNIT', rate: money(45), unitLabel: 'Tank', displayOnline: true, taxable: false, sortOrder: 3 });

  console.log('  Services created');

  // --- Reservations ---
  // Mix of statuses: active rentals, upcoming, completed, cancelled
  const reservations = [
    // Active rentals (checked out, currently rented)
    { number: 'DEMO-10001', status: 'CHECKED_OUT', customerId: customers[0].id, vehicleId: vehicles[12].id, vehicleTypeId: vtEcon.id, pickupLocationId: locMIA.id, returnLocationId: locMIA.id, pickupAt: pastDate(3, 9), returnAt: futureDate(4, 17), dailyRate: money(39), estimatedTotal: money(273) },
    { number: 'DEMO-10002', status: 'CHECKED_OUT', customerId: customers[1].id, vehicleId: vehicles[13].id, vehicleTypeId: vtSUV.id, pickupLocationId: locFLL.id, returnLocationId: locFLL.id, pickupAt: pastDate(2, 10), returnAt: futureDate(5, 10), dailyRate: money(65), estimatedTotal: money(455) },

    // Upcoming reservations (confirmed, not yet picked up)
    { number: 'DEMO-10003', status: 'CONFIRMED', customerId: customers[2].id, vehicleTypeId: vtStd.id, pickupLocationId: locMIA.id, returnLocationId: locMIA.id, pickupAt: futureDate(1, 14), returnAt: futureDate(6, 10), dailyRate: money(49), estimatedTotal: money(245) },
    { number: 'DEMO-10004', status: 'CONFIRMED', customerId: customers[3].id, vehicleTypeId: vtLux.id, pickupLocationId: locMIA.id, returnLocationId: locFLL.id, pickupAt: futureDate(2, 11), returnAt: futureDate(5, 11), dailyRate: money(120), estimatedTotal: money(360) },
    { number: 'DEMO-10005', status: 'CONFIRMED', customerId: customers[4].id, vehicleTypeId: vtSUV.id, pickupLocationId: locFLL.id, returnLocationId: locFLL.id, pickupAt: futureDate(3, 9), returnAt: futureDate(10, 9), dailyRate: money(65), estimatedTotal: money(455) },
    { number: 'DEMO-10006', status: 'NEW', customerId: customers[5].id, vehicleTypeId: vtVan.id, pickupLocationId: locMIA.id, returnLocationId: locMIA.id, pickupAt: futureDate(5, 10), returnAt: futureDate(8, 10), dailyRate: money(75), estimatedTotal: money(225) },

    // Completed rentals (returned in the past)
    { number: 'DEMO-10007', status: 'COMPLETED', customerId: customers[6].id, vehicleTypeId: vtEcon.id, pickupLocationId: locMIA.id, returnLocationId: locMIA.id, pickupAt: pastDate(14, 10), returnAt: pastDate(10, 10), dailyRate: money(39), estimatedTotal: money(156) },
    { number: 'DEMO-10008', status: 'COMPLETED', customerId: customers[7].id, vehicleTypeId: vtSUV.id, pickupLocationId: locFLL.id, returnLocationId: locMIA.id, pickupAt: pastDate(21, 9), returnAt: pastDate(14, 15), dailyRate: money(65), estimatedTotal: money(455) },
    { number: 'DEMO-10009', status: 'COMPLETED', customerId: customers[8].id, vehicleTypeId: vtStd.id, pickupLocationId: locDTN.id, returnLocationId: locDTN.id, pickupAt: pastDate(30, 10), returnAt: pastDate(25, 10), dailyRate: money(49), estimatedTotal: money(245) },
    { number: 'DEMO-10010', status: 'COMPLETED', customerId: customers[0].id, vehicleTypeId: vtLux.id, pickupLocationId: locMIA.id, returnLocationId: locMIA.id, pickupAt: pastDate(45, 11), returnAt: pastDate(42, 11), dailyRate: money(120), estimatedTotal: money(360) },

    // Cancelled
    { number: 'DEMO-10011', status: 'CANCELLED', customerId: customers[9].id, vehicleTypeId: vtEcon.id, pickupLocationId: locMIA.id, returnLocationId: locMIA.id, pickupAt: futureDate(7, 10), returnAt: futureDate(10, 10), dailyRate: money(39), estimatedTotal: money(117) },
  ];

  for (const r of reservations) {
    await upsertReservation(r.number, {
      status: r.status,
      customerId: r.customerId,
      vehicleId: r.vehicleId || null,
      vehicleTypeId: r.vehicleTypeId,
      pickupLocationId: r.pickupLocationId,
      returnLocationId: r.returnLocationId,
      pickupAt: r.pickupAt,
      returnAt: r.returnAt,
      dailyRate: r.dailyRate,
      estimatedTotal: r.estimatedTotal,
    });
  }

  console.log(`  ${reservations.length} reservations created`);

  console.log('\nDemo tenant seed complete!');
  console.log(JSON.stringify({
    ok: true,
    tenantId: TENANT_ID,
    locations: 3,
    vehicleTypes: 5,
    vehicles: vehicles.length,
    customers: customers.length,
    reservations: reservations.length,
    rates: 1,
    fees: 3,
    services: 4
  }, null, 2));
}

main()
  .catch(async (error) => {
    console.error('Seed failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
