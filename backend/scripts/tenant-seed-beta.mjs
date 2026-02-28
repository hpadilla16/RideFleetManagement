import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function ensureTenantPack(tag) {
  const slug = `beta-${tag}`;
  const tenant = await prisma.tenant.upsert({
    where: { slug },
    update: { name: `Beta ${tag.toUpperCase()} Tenant`, status: 'ACTIVE' },
    create: { name: `Beta ${tag.toUpperCase()} Tenant`, slug, status: 'ACTIVE', plan: 'BETA' }
  });

  const email = `admin+${tag}@fleetbeta.local`;
  const passwordHash = await bcrypt.hash('TempPass123!', 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { role: 'ADMIN', tenantId: tenant.id, passwordHash },
    create: { email, fullName: `Tenant ${tag.toUpperCase()} Admin`, role: 'ADMIN', tenantId: tenant.id, passwordHash }
  });

  const locationCode = `LOC-${tag.toUpperCase()}`;
  const location = await prisma.location.upsert({
    where: { code: locationCode },
    update: { tenantId: tenant.id, name: `Location ${tag.toUpperCase()}`, taxRate: 11.5 },
    create: { tenantId: tenant.id, code: locationCode, name: `Location ${tag.toUpperCase()}`, taxRate: 11.5, isActive: true }
  });

  const phone = tag === 'a' ? '+1555000101' : '+1555000202';
  const existingCustomer = await prisma.customer.findFirst({ where: { phone } });
  const customer = existingCustomer
    ? await prisma.customer.update({ where: { id: existingCustomer.id }, data: { tenantId: tenant.id, firstName: `Cust${tag.toUpperCase()}`, lastName: 'Beta' } })
    : await prisma.customer.create({ data: { tenantId: tenant.id, firstName: `Cust${tag.toUpperCase()}`, lastName: 'Beta', phone, email: `cust+${tag}@fleetbeta.local` } });

  return { tenantId: tenant.id, userId: user.id, locationId: location.id, customerId: customer.id };
}

const out = {
  step: 'seed',
  tenantA: await ensureTenantPack('a'),
  tenantB: await ensureTenantPack('b')
};

console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();