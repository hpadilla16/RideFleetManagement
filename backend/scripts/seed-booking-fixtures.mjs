import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TENANT_SLUG = process.env.BOOKING_TEST_TENANT_SLUG || 'beta-b-tenant';
const TENANT_NAME = process.env.BOOKING_TEST_TENANT_NAME || 'Beta B Tenant';
const PREFIX = String(process.env.BOOKING_TEST_PREFIX || 'BBT').trim().toUpperCase();

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

async function upsertTenant() {
  const existing = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (existing) {
    return prisma.tenant.update({
      where: { id: existing.id },
      data: {
        name: TENANT_NAME,
        status: 'ACTIVE',
        plan: existing.plan || 'BETA',
        carSharingEnabled: true
      }
    });
  }
  return prisma.tenant.create({
    data: {
      name: TENANT_NAME,
      slug: TENANT_SLUG,
      status: 'ACTIVE',
      plan: 'BETA',
      carSharingEnabled: true
    }
  });
}

async function upsertLocation(tenantId, codeSuffix, payload) {
  const code = `${PREFIX}-${codeSuffix}`;
  const existing = await prisma.location.findUnique({
    where: {
      tenantId_code: {
        tenantId,
        code
      }
    }
  });
  if (existing) {
    return prisma.location.update({
      where: { id: existing.id },
      data: {
        tenantId,
        ...payload
      }
    });
  }
  return prisma.location.create({
    data: {
      tenantId,
      code,
      ...payload
    }
  });
}

async function upsertVehicleType(tenantId, codeSuffix, payload) {
  const code = `${PREFIX}-${codeSuffix}`;
  const existing = await prisma.vehicleType.findFirst({ where: { tenantId, code } });
  if (existing) {
    return prisma.vehicleType.update({
      where: { id: existing.id },
      data: payload
    });
  }
  return prisma.vehicleType.create({
    data: {
      tenantId,
      code,
      ...payload
    }
  });
}

async function upsertVehicle(tenantId, internalNumber, payload) {
  const existing = await prisma.vehicle.findUnique({ where: { internalNumber } });
  if (existing) {
    return prisma.vehicle.update({
      where: { id: existing.id },
      data: {
        tenantId,
        ...payload
      }
    });
  }
  return prisma.vehicle.create({
    data: {
      tenantId,
      internalNumber,
      ...payload
    }
  });
}

async function upsertRate(tenantId, locationId, economyTypeId, suvTypeId) {
  const rateCode = `${PREFIX}-PUBLIC-ONLINE`;
  const existing = await prisma.rate.findUnique({
    where: {
      tenantId_rateCode: {
        tenantId,
        rateCode
      }
    },
    include: { rateItems: true }
  });

  let rate;
  if (existing) {
    rate = await prisma.rate.update({
      where: { id: existing.id },
      data: {
        tenantId,
        locationId,
        name: `${TENANT_NAME} Public Web Rates`,
        rateType: 'MULTIPLE_CLASSES',
        calculationBy: '24_HOUR_TIME',
        averageBy: 'DATE_RANGE',
        displayOnline: true,
        active: true,
        isActive: true,
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
        sunday: true
      }
    });
    await prisma.rateItem.deleteMany({ where: { rateId: existing.id } });
  } else {
    rate = await prisma.rate.create({
      data: {
        tenantId,
        rateCode,
        name: `${TENANT_NAME} Public Web Rates`,
        locationId,
        rateType: 'MULTIPLE_CLASSES',
        calculationBy: '24_HOUR_TIME',
        averageBy: 'DATE_RANGE',
        displayOnline: true,
        active: true,
        isActive: true,
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
        sunday: true
      }
    });
  }

  await prisma.rateItem.createMany({
    data: [
      {
        rateId: rate.id,
        vehicleTypeId: economyTypeId,
        daily: money(42),
        weekly: money(252),
        monthly: money(950),
        hourly: money(0),
        extraDaily: money(42),
        minHourly: 0,
        minDaily: 1,
        minWeekly: 7,
        minMonthly: 30,
        extraMileCharge: money(0),
        sortOrder: 0
      },
      {
        rateId: rate.id,
        vehicleTypeId: suvTypeId,
        daily: money(67),
        weekly: money(402),
        monthly: money(1490),
        hourly: money(0),
        extraDaily: money(67),
        minHourly: 0,
        minDaily: 1,
        minWeekly: 7,
        minMonthly: 30,
        extraMileCharge: money(0),
        sortOrder: 1
      }
    ]
  });

  return rate;
}

async function upsertHostProfile(tenantId) {
  const email = `host.${TENANT_SLUG}@ridefleetmanager.com`;
  const existing = await prisma.hostProfile.findFirst({
    where: { tenantId, email }
  });
  if (existing) {
    return prisma.hostProfile.update({
      where: { id: existing.id },
      data: {
        displayName: `${TENANT_NAME} Host`,
        legalName: `${TENANT_NAME} Host LLC`,
        status: 'ACTIVE',
        payoutProvider: 'manual',
        payoutEnabled: false
      }
    });
  }
  return prisma.hostProfile.create({
    data: {
      tenantId,
      displayName: `${TENANT_NAME} Host`,
      legalName: `${TENANT_NAME} Host LLC`,
      email,
      phone: '7875550000',
      status: 'ACTIVE',
      payoutProvider: 'manual',
      payoutEnabled: false
    }
  });
}

async function upsertListing({ tenantId, hostProfileId, vehicleId, locationId, slugSuffix, title, baseDailyRate, instantBook }) {
  const slug = `${TENANT_SLUG}-${slugSuffix}`;
  const existing = await prisma.hostVehicleListing.findUnique({ where: { slug } });
  const payload = {
    tenantId,
    hostProfileId,
    vehicleId,
    locationId,
    title,
    shortDescription: 'Booking engine fixture listing',
    description: 'Fixture listing used to validate public booking, availability, and trip creation.',
    status: 'PUBLISHED',
    ownershipType: 'HOST_OWNED',
    currency: 'USD',
    baseDailyRate: money(baseDailyRate),
    cleaningFee: money(12),
    deliveryFee: money(8),
    securityDeposit: money(150),
    instantBook: !!instantBook,
    minTripDays: 1,
    maxTripDays: 14,
    tripRules: 'Fixture listing for Sprint 6 public booking tests.',
    publishedAt: new Date(),
    pausedAt: null
  };
  if (existing) {
    return prisma.hostVehicleListing.update({
      where: { id: existing.id },
      data: payload
    });
  }
  return prisma.hostVehicleListing.create({
    data: {
      slug,
      ...payload
    }
  });
}

async function main() {
  const tenant = await upsertTenant();
  const locationA = await upsertLocation(tenant.id, 'LOC-A', {
    name: `${TENANT_NAME} Location A`,
    city: 'San Juan',
    state: 'PR',
    country: 'Puerto Rico',
    taxRate: money(11.5),
    isActive: true,
    locationConfig: JSON.stringify({
      requireDeposit: true,
      depositMode: 'FIXED',
      depositAmount: 75,
      requireSecurityDeposit: true,
      securityDepositAmount: 200
    })
  });
  const locationB = await upsertLocation(tenant.id, 'LOC-B', {
    name: `${TENANT_NAME} Location B`,
    city: 'Carolina',
    state: 'PR',
    country: 'Puerto Rico',
    taxRate: money(11.5),
    isActive: true
  });

  const economy = await upsertVehicleType(tenant.id, 'ECON', {
    name: 'Economy',
    description: 'Economy booking fixture'
  });
  const suv = await upsertVehicleType(tenant.id, 'SUV', {
    name: 'SUV',
    description: 'SUV booking fixture'
  });

  const vehicles = await Promise.all([
    upsertVehicle(tenant.id, `${PREFIX}-R1`, {
      vin: `${PREFIX}R10000000000001`,
      plate: `${PREFIX}R1`,
      make: 'Toyota',
      model: 'Yaris',
      year: 2025,
      color: 'White',
      mileage: 1200,
      status: 'AVAILABLE',
      fleetMode: 'RENTAL_ONLY',
      vehicleTypeId: economy.id,
      homeLocationId: locationA.id
    }),
    upsertVehicle(tenant.id, `${PREFIX}-R2`, {
      vin: `${PREFIX}R20000000000002`,
      plate: `${PREFIX}R2`,
      make: 'Nissan',
      model: 'Versa',
      year: 2025,
      color: 'Silver',
      mileage: 1400,
      status: 'AVAILABLE',
      fleetMode: 'RENTAL_ONLY',
      vehicleTypeId: economy.id,
      homeLocationId: locationA.id
    }),
    upsertVehicle(tenant.id, `${PREFIX}-CS1`, {
      vin: `${PREFIX}C10000000000003`,
      plate: `${PREFIX}C1`,
      make: 'Ford',
      model: 'Escape',
      year: 2026,
      color: 'Blue',
      mileage: 800,
      status: 'AVAILABLE',
      fleetMode: 'CAR_SHARING_ONLY',
      vehicleTypeId: suv.id,
      homeLocationId: locationB.id
    }),
    upsertVehicle(tenant.id, `${PREFIX}-CS2`, {
      vin: `${PREFIX}C20000000000004`,
      plate: `${PREFIX}C2`,
      make: 'Hyundai',
      model: 'Kona',
      year: 2026,
      color: 'Black',
      mileage: 900,
      status: 'AVAILABLE',
      fleetMode: 'CAR_SHARING_ONLY',
      vehicleTypeId: economy.id,
      homeLocationId: locationB.id
    }),
    upsertVehicle(tenant.id, `${PREFIX}-B1`, {
      vin: `${PREFIX}B10000000000005`,
      plate: `${PREFIX}B1`,
      make: 'Honda',
      model: 'Civic',
      year: 2025,
      color: 'Red',
      mileage: 1000,
      status: 'AVAILABLE',
      fleetMode: 'BOTH',
      vehicleTypeId: economy.id,
      homeLocationId: locationA.id
    }),
    upsertVehicle(tenant.id, `${PREFIX}-B2`, {
      vin: `${PREFIX}B20000000000006`,
      plate: `${PREFIX}B2`,
      make: 'Toyota',
      model: 'RAV4',
      year: 2025,
      color: 'Gray',
      mileage: 1100,
      status: 'AVAILABLE',
      fleetMode: 'BOTH',
      vehicleTypeId: suv.id,
      homeLocationId: locationB.id
    })
  ]);

  const rate = await upsertRate(tenant.id, locationA.id, economy.id, suv.id);
  const hostProfile = await upsertHostProfile(tenant.id);
  const listingA = await upsertListing({
    tenantId: tenant.id,
    hostProfileId: hostProfile.id,
    vehicleId: vehicles[2].id,
    locationId: locationB.id,
    slugSuffix: 'escape',
    title: `${TENANT_NAME} Ford Escape`,
    baseDailyRate: 54,
    instantBook: true
  });
  const listingB = await upsertListing({
    tenantId: tenant.id,
    hostProfileId: hostProfile.id,
    vehicleId: vehicles[5].id,
    locationId: locationB.id,
    slugSuffix: 'rav4',
    title: `${TENANT_NAME} Toyota RAV4`,
    baseDailyRate: 63,
    instantBook: false
  });

  console.log(JSON.stringify({
    ok: true,
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, carSharingEnabled: tenant.carSharingEnabled },
    locations: [
      { id: locationA.id, code: locationA.code, name: locationA.name },
      { id: locationB.id, code: locationB.code, name: locationB.name }
    ],
    vehicleTypes: [
      { id: economy.id, code: economy.code, name: economy.name },
      { id: suv.id, code: suv.code, name: suv.name }
    ],
    fleet: {
      rentalOnly: vehicles.filter((vehicle) => vehicle.fleetMode === 'RENTAL_ONLY').map((vehicle) => vehicle.internalNumber),
      carSharingOnly: vehicles.filter((vehicle) => vehicle.fleetMode === 'CAR_SHARING_ONLY').map((vehicle) => vehicle.internalNumber),
      both: vehicles.filter((vehicle) => vehicle.fleetMode === 'BOTH').map((vehicle) => vehicle.internalNumber)
    },
    rate: { id: rate.id, rateCode: rate.rateCode, displayOnline: rate.displayOnline },
    listings: [
      { id: listingA.id, slug: listingA.slug, title: listingA.title, vehicleId: listingA.vehicleId },
      { id: listingB.id, slug: listingB.slug, title: listingB.title, vehicleId: listingB.vehicleId }
    ]
  }, null, 2));
}

main()
  .catch(async (error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
