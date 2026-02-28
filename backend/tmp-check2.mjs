import {PrismaClient} from '@prisma/client';
const p=new PrismaClient();
const r=await p.reservation.findFirst({where:{reservationNumber:'RES-208365'},select:{id:true,estimatedTotal:true,dailyRate:true,notes:true,pickupAt:true,returnAt:true,customer:{select:{dateOfBirth:true}},pickupLocation:{select:{locationConfig:true}}}});
console.log('estimated',r?.estimatedTotal,'daily',r?.dailyRate);
console.log('notes\n',r?.notes);
await p.$disconnect();
