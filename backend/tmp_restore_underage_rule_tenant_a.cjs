const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'beta-a' } });
  if (!tenant) throw new Error('tenant beta-a not found');

  let fee = await prisma.fee.findFirst({ where: { tenantId: tenant.id, isUnderageFee: true } });
  if (!fee) {
    fee = await prisma.fee.create({
      data: {
        tenantId: tenant.id,
        code: 'UNDERAGE_FEE',
        name: 'Underage FEE',
        description: 'Automatic underage fee',
        mode: 'PER_DAY',
        amount: 24.99,
        taxable: true,
        isActive: true,
        isUnderageFee: true,
        isAdditionalDriverFee: false
      }
    });
  }

  const loc = await prisma.location.findFirst({ where: { tenantId: tenant.id } });
  if (loc) {
    let cfg = {};
    try { cfg = loc.locationConfig ? JSON.parse(String(loc.locationConfig)) : {}; } catch { cfg = {}; }
    cfg.underageAlertEnabled = true;
    cfg.underageAlertAge = Number(cfg.underageAlertAge || 25);
    await prisma.location.update({ where: { id: loc.id }, data: { locationConfig: JSON.stringify(cfg) } });

    const link = await prisma.locationFee.findFirst({ where: { locationId: loc.id, feeId: fee.id } });
    if (!link) await prisma.locationFee.create({ data: { locationId: loc.id, feeId: fee.id } });
  }

  console.log(JSON.stringify({ ok: true, tenantId: tenant.id, feeId: fee.id }, null, 2));
  await prisma.$disconnect();
})();