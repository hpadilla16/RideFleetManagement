const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function parseMeta(notes){
  const m=String(notes||'').match(/\[RES_CHARGES_META\](\{[\s\S]*\})/);
  if(!m) return null;
  try{return JSON.parse(m[1]);}catch{return null;}
}
function days(a,b){const ms=new Date(b)-new Date(a); return Math.max(1, Math.ceil(ms/(24*60*60*1000)));}

(async()=>{
  const reservationNumber='RES-511855';
  const res=await prisma.reservation.findUnique({where:{reservationNumber}, include:{pickupLocation:true,rentalAgreement:true}});
  if(!res) throw new Error('reservation not found');
  if(!res.rentalAgreement) throw new Error('agreement not found');
  const ag=res.rentalAgreement;
  const meta=parseMeta(res.notes)||{};
  const serviceIds=Array.isArray(meta.selectedServices)?meta.selectedServices:[];
  const feeIds=Array.isArray(meta.selectedFees)?meta.selectedFees:[];
  const discounts=Array.isArray(meta.discounts)?meta.discounts:[];
  const services=serviceIds.length?await prisma.additionalService.findMany({where:{id:{in:serviceIds}}}):[];
  const fees=feeIds.length?await prisma.fee.findMany({where:{id:{in:feeIds}}}):[];

  const d=days(res.pickupAt,res.returnAt);
  const daily=Number(res.dailyRate||0);
  const base=d*daily;
  const rows=[];
  rows.push({rentalAgreementId:ag.id,name:'Daily',chargeType:'DAILY',quantity:d,rate:daily,total:base,taxable:true,selected:true,sortOrder:0});
  let servicesTotal=0;
  for(const s of services){
    const qty=Number(s.defaultQty||1)||1; const perDay=Number(s.dailyRate||0); const rate=perDay>0?perDay:Number(s.rate||0);
    const line=perDay>0?perDay*d*qty:Number(s.rate||0)*qty; servicesTotal+=line;
    rows.push({rentalAgreementId:ag.id,name:s.name,chargeType:'UNIT',quantity:qty,rate,total:line,taxable:!!s.taxable,selected:true,sortOrder:rows.length});
  }
  let feesTotal=0;
  for(const f of fees){
    const amt=Number(f.amount||0); const mode=String(f.mode||'FIXED').toUpperCase();
    const line=mode==='PERCENTAGE'?((base+servicesTotal)*(amt/100)):mode==='PER_DAY'?(amt*d):amt; feesTotal+=line;
    rows.push({rentalAgreementId:ag.id,name:f.name,chargeType:'UNIT',quantity:1,rate:mode==='PERCENTAGE'?amt:line,total:line,taxable:!!f.taxable,selected:true,sortOrder:rows.length});
  }
  const discountTotal=discounts.reduce((s,x)=>{const m=String(x?.mode||'FIXED').toUpperCase(); const v=Number(x?.value||0); if(!v||v<=0) return s; return s + (m==='PERCENTAGE'?((base+servicesTotal+feesTotal)*(v/100)):v);},0);
  if(discountTotal>0) rows.push({rentalAgreementId:ag.id,name:'Discount',chargeType:'UNIT',quantity:1,rate:-discountTotal,total:-discountTotal,taxable:false,selected:true,sortOrder:rows.length});
  const subtotal=Math.max(0, base+servicesTotal+feesTotal-discountTotal);
  const taxRate=Number(res.pickupLocation?.taxRate||0); const taxes=subtotal*(taxRate/100); const total=subtotal+taxes;
  rows.push({rentalAgreementId:ag.id,name:`Tax (${taxRate.toFixed(2)}%)`,chargeType:'TAX',quantity:1,rate:taxes,total:taxes,taxable:false,selected:true,sortOrder:rows.length});

  await prisma.rentalAgreementCharge.deleteMany({where:{rentalAgreementId:ag.id}});
  if(rows.length) await prisma.rentalAgreementCharge.createMany({data:rows});
  const paid=Number(ag.paidAmount||0);
  await prisma.rentalAgreement.update({where:{id:ag.id},data:{subtotal,taxes,total,balance:Math.max(0,Number((total-paid).toFixed(2)))}});
  console.log('synced',reservationNumber,'agreement',ag.id,'total',total.toFixed(2));
})().catch(e=>{console.error(e);process.exit(1)}).finally(async()=>{await prisma.$disconnect();});
