const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const ta = await p.tenant.findUnique({ where: { slug: 'beta-a' } });
  const fees = await p.fee.findMany({
    where: { tenantId: ta?.id || null },
    select: { id: true, name: true, isUnderageFee: true, isAdditionalDriverFee: true, mode: true, amount: true, isActive: true }
  });
  const locs = await p.location.findMany({
    where: { tenantId: ta?.id || null },
    select: { id: true, code: true, name: true, locationConfig: true }
  });
  console.log(JSON.stringify({ tenantId: ta?.id, fees, locs }, null, 2));
  await p.$disconnect();
})();