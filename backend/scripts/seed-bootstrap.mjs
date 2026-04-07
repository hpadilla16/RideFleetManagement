import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@ridefleet.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Ride1234!';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Hector Admin';
const TENANT_SLUG = process.env.SEED_TENANT_SLUG || 'local-dev';
const TENANT_NAME = process.env.SEED_TENANT_NAME || 'Local Dev Tenant';

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
    where: {
      tenantId_code: {
        tenantId: item.tenantId,
        code: item.code
      }
    },
    update: {
      name: item.name,
      tenantId: item.tenantId,
      city: item.city,
      state: item.state,
      country: item.country
    },
    create: item
  });
}

async function upsertVehicleType(item) {
  const existing = await prisma.vehicleType.findFirst({
    where: {
      tenantId: item.tenantId,
      code: item.code
    }
  });
  if (existing) {
    return prisma.vehicleType.update({
      where: { id: existing.id },
      data: {
        name: item.name,
        description: item.description
      }
    });
  }
  return prisma.vehicleType.create({ data: item });
}

async function upsertTenant() {
  const existing = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (existing) {
    return prisma.tenant.update({
      where: { id: existing.id },
      data: {
        name: TENANT_NAME,
        status: 'ACTIVE'
      }
    });
  }
  return prisma.tenant.create({
    data: {
      slug: TENANT_SLUG,
      name: TENANT_NAME,
      status: 'ACTIVE'
    }
  });
}

async function upsertAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  return prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {
      fullName: ADMIN_NAME,
      role: 'SUPER_ADMIN',
      isActive: true,
      passwordHash
    },
    create: {
      email: ADMIN_EMAIL,
      fullName: ADMIN_NAME,
      role: 'SUPER_ADMIN',
      isActive: true,
      passwordHash
    }
  });
}

(async () => {
  try {
    const tenant = await upsertTenant();
    const seededLocations = [];
    for (const l of locations) seededLocations.push(await upsertLocation({ ...l, tenantId: tenant.id }));

    const seededTypes = [];
    for (const t of vehicleTypes) seededTypes.push(await upsertVehicleType({ ...t, tenantId: tenant.id }));

    const admin = await upsertAdmin();

    console.log(JSON.stringify({
      ok: true,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
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
