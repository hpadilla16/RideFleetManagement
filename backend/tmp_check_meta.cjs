const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const rows = await p.reservation.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      rentalAgreement: { select: { id: true, agreementNumber: true, status: true, total: true } },
      pickupLocation: { select: { name: true } }
    },
    take: 12
  });

  for (const r of rows) {
    const notes = String(r.notes || '');
    const hasMeta = /\[RES_CHARGES_META\]/.test(notes);
    const m = notes.match(/\[RES_CHARGES_META\](\{[^\n]*\})/);
    let meta = null;
    try { meta = m ? JSON.parse(m[1]) : null; } catch {}
    const ag = r.rentalAgreement;
    console.log(JSON.stringify({
      reservation: r.reservationNumber,
      status: r.status,
      agreement: ag ? { number: ag.agreementNumber, status: ag.status, total: Number(ag.total || 0) } : null,
      hasMeta,
      selectedServices: meta?.selectedServices?.length || 0,
      selectedFees: meta?.selectedFees?.length || 0,
      discounts: meta?.discounts?.length || 0,
      notesLen: notes.length
    }));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(async () => {
  await p.$disconnect();
});
