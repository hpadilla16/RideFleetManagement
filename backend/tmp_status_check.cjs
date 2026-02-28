const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async()=>{
  const rows = await p.vehicle.groupBy({ by:['status'], _count:{ _all:true } });
  console.log(rows);
})().finally(async()=>{ await p.$disconnect(); });
