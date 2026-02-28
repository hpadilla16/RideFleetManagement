import {PrismaClient} from '@prisma/client';
const p=new PrismaClient();
const r=await p.reservation.findFirst({where:{reservationNumber:'RES-208365'},select:{id:true,estimatedTotal:true,dailyRate:true,notes:true,pickupAt:true,returnAt:true,paymentRequestToken:true,paymentRequestTokenExpiresAt:true}});
console.log('estimatedTotal',r?.estimatedTotal,'dailyRate',r?.dailyRate);
console.log('has meta',/\[RES_CHARGES_META\]/.test(String(r?.notes||'')));
console.log('notes tail',String(r?.notes||'').slice(-500));
console.log('token',r?.paymentRequestToken);
await p.$disconnect();
