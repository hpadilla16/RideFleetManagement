import {PrismaClient} from '@prisma/client';
const p=new PrismaClient();
const r=await p.reservation.findFirst({where:{reservationNumber:'RES-208365'},include:{customer:true,pickupLocation:true}});
console.log('dob',r?.customer?.dateOfBirth);
console.log('pickup',r?.pickupAt);
console.log('loccfg',r?.pickupLocation?.locationConfig);
await p.$disconnect();
