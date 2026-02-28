import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const svcs = await p.additionalService.findMany({ where: { isActive: true }, select: { id:true, name:true, locationId:true, allVehicleTypes:true, vehicleTypeIds:true, rate:true,dailyRate:true } });
console.log(JSON.stringify(svcs,null,2));
await p.$disconnect();
