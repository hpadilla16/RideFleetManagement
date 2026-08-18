// H6: simular ">15 min de espera offline" — expira TODOS los handoff tokens
// vivos de la reserva H6-RES-0001 en el SERVIDOR (el TTL vive allá; adelantar
// el reloj del emulador no lo movería). El drenador debe re-emitir al drenar.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const resv = await prisma.reservation.findUnique({
  where: { reservationNumber: 'H6-RES-0001' }
});
const out = await prisma.handoffToken.updateMany({
  where: { reservationId: resv.id, kind: 'MOBILE_INSPECTION' },
  data: { expiresAt: new Date(Date.now() - 60 * 60 * 1000) }
});
console.log(JSON.stringify({ step: 'h6-expire-token', expired: out.count }));
await prisma.$disconnect();
