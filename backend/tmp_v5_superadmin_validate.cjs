const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

(async () => {
  const email = 'superadmin@fleetbeta.local';
  const passwordHash = await bcrypt.hash('TempPass123!', 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { role: 'SUPER_ADMIN', passwordHash, tenantId: null },
    create: { email, fullName: 'Super Admin', role: 'SUPER_ADMIN', passwordHash, tenantId: null }
  });
  console.log(JSON.stringify({ ok: true, step: 'V5-seed', email: user.email }, null, 2));
  await prisma.$disconnect();
})();