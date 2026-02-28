import {PrismaClient} from '@prisma/client';
const p=new PrismaClient();
const r=await p.reservation.findFirst({where:{reservationNumber:'RES-208365'},select:{paymentRequestToken:true}});
console.log(r?.paymentRequestToken||'');
await p.$disconnect();
