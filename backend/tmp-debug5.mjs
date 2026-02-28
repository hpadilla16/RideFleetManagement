import {PrismaClient} from '@prisma/client';
const p=new PrismaClient();
const fees=await p.fee.findMany({select:{id:true,name:true,amount:true,mode:true,isActive:true,isUnderageFee:true}});
console.log(fees);
await p.$disconnect();
