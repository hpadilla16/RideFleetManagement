import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@ridefleet.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Ride1234!';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Hector Admin';

const locations = [
  { code: 'SJU', name: 'San Juan Airport - SJU', city: 'San Juan', state: 'PR', country: 'Puerto Rico' },
  { code: 'SJD', name: 'San Juan Downtown', city: 'San Juan', state: 'PR', country: 'Puerto Rico' },
  { code: 'FLL', name: 'Fort Lauderdale', city: 'Fort Lauderdale', state: 'FL', country: 'USA' }
];

const vehicleTypes = [
  { code: 'CCAR', name: 'Economy', description: 'Economy class vehicles' },
  { code: 'SCAR', name: 'Standard', description: 'Standard class vehicles' },
  { code: 'CFAR', name: 'Compact SUV', description: 'Compact SUV class vehicles' },
  { code: 'FVAR', name: 'Passenger Van', description: 'Passenger van class vehicles' }
];

async function upsertLocation(item) {
  return prisma.location.upsert({
    where: { code: item.code },
    update: {
      name: item.name,
      city: item.city,
      state: item.state,
      country: item.country
    },
    create: item
  });
}

async function upsertVehicleType(item) {
  return prisma.vehicleType.upsert({
    where: { code: item.code },
    update: {
      name: item.name,
      description: item.description
    },
    create: item
  });
}

async function upsertAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {
      fullName: ADMIN_NAME,
      role: 'ADMIN',
      isActive: true,
      passwordHash
    },
    create: {
      email: ADMIN_EMAIL,
      fullName: ADMIN_NAME,
      role: 'ADMIN',
      isActive: true,
      passwordHash
    }
  });
}

(async () => {
  try {
    const seededLocations = [];
    for (const l of locations) seededLocations.push(await upsertLocation(l));

    const seededTypes = [];
    for (const t of vehicleTypes) seededTypes.push(await upsertVehicleType(t));

    const admin = await upsertAdmin();

    console.log(JSON.stringify({
      ok: true,
      locations: seededLocations.map(x => ({ id: x.id, code: x.code, name: x.name })),
      vehicleTypes: seededTypes.map(x => ({ id: x.id, code: x.code, name: x.name })),
      admin: { id: admin.id, email: admin.email, fullName: admin.fullName, role: admin.role }
    }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
