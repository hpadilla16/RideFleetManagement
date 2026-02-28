import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const email = 'superadmin@fleetbeta.local';
const passwordHash = await bcrypt.hash('TempPass123!', 10);

const user = await prisma.user.upsert({
  where: { email },
  update: { role: 'SUPER_ADMIN', tenantId: null, passwordHash, isActive: true },
  create: { email, fullName: 'Super Admin', role: 'SUPER_ADMIN', tenantId: null, passwordHash, isActive: true }
});

console.log(JSON.stringify({ step: 'superadmin-seed', ok: true, email: user.email }, null, 2));
await prisma.$disconnect();