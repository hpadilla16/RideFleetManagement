import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const vts = await p.vehicleType.findMany({ select: { id: true, code: true, name: true } });
const locs = await p.location.findMany({ select: { id: true, code: true, name: true } });
const rates = await p.rate.findMany({ where: { isActive: true, active: true }, include: { rateItems: true } });
console.log(JSON.stringify({ vts, locs, rates }, null, 2));
await p.$disconnect();
