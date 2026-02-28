const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function ensureTenantPack(tag) {
  const slug = 'beta-' + tag;
  const tenant = await prisma.tenant.upsert({
    where: { slug },
    update: { name: 'Beta ' + tag.toUpperCase() + ' Tenant', status: 'ACTIVE' },
    create: { name: 'Beta ' + tag.toUpperCase() + ' Tenant', slug, status: 'ACTIVE', plan: 'BETA' }
  });

  const email = 'admin+' + tag + '@fleetbeta.local';
  const passwordHash = await bcrypt.hash('TempPass123!', 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { role: 'ADMIN', passwordHash, tenant: { connect: { id: tenant.id } } },
    create: { email, fullName: 'Tenant ' + tag.toUpperCase() + ' Admin', role: 'ADMIN', passwordHash, tenant: { connect: { id: tenant.id } } }
  });

  const locationCode = 'LOC-' + tag.toUpperCase();
  const location = await prisma.location.upsert({
    where: { code: locationCode },
    update: { name: 'Location ' + tag.toUpperCase(), taxRate: 11.5, tenant: { connect: { id: tenant.id } } },
    create: { code: locationCode, name: 'Location ' + tag.toUpperCase(), taxRate: 11.5, tenant: { connect: { id: tenant.id } } }
  });

  const phone = tag === 'a' ? '+1555000101' : '+1555000202';
  let customer = await prisma.customer.findFirst({ where: { phone, tenantId: tenant.id } });
  if (customer) {
    customer = await prisma.customer.update({ where: { id: customer.id }, data: { firstName: 'Cust' + tag.toUpperCase(), lastName: 'Beta', email: 'cust+' + tag + '@fleetbeta.local' } });
  } else {
    customer = await prisma.customer.create({ data: { firstName: 'Cust' + tag.toUpperCase(), lastName: 'Beta', phone, email: 'cust+' + tag + '@fleetbeta.local', tenant: { connect: { id: tenant.id } } } });
  }

  return {
    tenant: { id: tenant.id, slug: tenant.slug },
    user: { id: user.id, email: user.email },
    location: { id: location.id, code: location.code },
    customer: { id: customer.id, phone: customer.phone }
  };
}

(async () => {
  const a = await ensureTenantPack('a');
  const b = await ensureTenantPack('b');
  console.log(JSON.stringify({ step: 'V1', tempPassword: 'TempPass123!', tenantA: a, tenantB: b }, null, 2));
  await prisma.$disconnect();
})();