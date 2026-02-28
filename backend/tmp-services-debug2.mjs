import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const svcs = await p.additionalService.findMany({ select: { id:true, code:true, name:true, isActive:true, locationId:true, allVehicleTypes:true, vehicleTypeIds:true, rate:true,dailyRate:true } });
console.log(JSON.stringify(svcs,null,2));
await p.$disconnect();
