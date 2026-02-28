import {PrismaClient} from '@prisma/client';
const p=new PrismaClient();
const r=await p.reservation.findFirst({where:{reservationNumber:'RES-208365'},select:{id:true,reservationNumber:true,dailyRate:true,estimatedTotal:true,notes:true,pickupAt:true,returnAt:true}});
console.log(JSON.stringify(r,null,2));
await p.$disconnect();
