import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const fees = await p.fee.findMany({ select: { id:true, code:true, name:true, isActive:true, amount:true, mode:true } });
console.log(JSON.stringify(fees,null,2));
await p.$disconnect();
