// H6 integration pass — datos mínimos para que el dashboard de RideOps tenga
// una cola de SALIDAS real: 1 vehículo + 1 reserva CONFIRMED con pickup hoy.
// Untracked: solo para el pase local en emulador.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const tenant = await prisma.tenant.findUnique({ where: { slug: 'beta-a' } });
const location = await prisma.location.findFirst({ where: { tenantId: tenant.id } });
const vehicleType = await prisma.vehicleType.findFirst({ where: { tenantId: tenant.id } });
const customer = await prisma.customer.findFirst({ where: { tenantId: tenant.id } });

let vehicle = await prisma.vehicle.findFirst({
  where: { tenantId: tenant.id, internalNumber: 'H6-001' }
});
if (!vehicle) {
  vehicle = await prisma.vehicle.create({
    data: {
      tenantId: tenant.id,
      internalNumber: 'H6-001',
      plate: 'H6TEST1',
      make: 'Toyota',
      model: 'Corolla',
      year: 2023,
      mileage: 41250,
      vehicleTypeId: vehicleType.id,
      homeLocationId: location.id,
      status: 'AVAILABLE'
    }
  });
}

const now = new Date();
const pickupAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // hoy +2 h
const returnAt = new Date(now.getTime() + 26 * 60 * 60 * 1000);

let reservation = await prisma.reservation.findUnique({
  where: { reservationNumber: 'H6-RES-0001' }
});
if (!reservation) {
  reservation = await prisma.reservation.create({
    data: {
      tenantId: tenant.id,
      reservationNumber: 'H6-RES-0001',
      status: 'CONFIRMED',
      customerId: customer.id,
      vehicleId: vehicle.id,
      vehicleTypeId: vehicleType.id,
      pickupLocationId: location.id,
      returnLocationId: location.id,
      pickupAt,
      returnAt,
      // Pre-checkin "hecho": la card sale limpia y el gate del checkout
      // (si la sede lo activara) no bloquea.
      customerInfoCompletedAt: now
    }
  });
} else {
  reservation = await prisma.reservation.update({
    where: { id: reservation.id },
    data: { status: 'CONFIRMED', pickupAt, returnAt, vehicleId: vehicle.id }
  });
}

// Segunda reserva: para el escenario reboot-con-bandeja-pendiente (el drenado
// en BACKGROUND tras el reinicio, sin abrir la app). Vehículo PROPIO — el
// checkout-session guard rechaza solapamiento de vehículo entre reservas.
let vehicle2 = await prisma.vehicle.findFirst({
  where: { tenantId: tenant.id, internalNumber: 'H6-002' }
});
if (!vehicle2) {
  vehicle2 = await prisma.vehicle.create({
    data: {
      tenantId: tenant.id,
      internalNumber: 'H6-002',
      plate: 'H6TEST2',
      make: 'Honda',
      model: 'Civic',
      year: 2024,
      mileage: 18400,
      vehicleTypeId: vehicleType.id,
      homeLocationId: location.id,
      status: 'AVAILABLE'
    }
  });
}
let reservation2 = await prisma.reservation.findUnique({
  where: { reservationNumber: 'H6-RES-0002' }
});
if (reservation2) {
  reservation2 = await prisma.reservation.update({
    where: { id: reservation2.id },
    data: { vehicleId: vehicle2.id }
  });
}
if (!reservation2) {
  reservation2 = await prisma.reservation.create({
    data: {
      tenantId: tenant.id,
      reservationNumber: 'H6-RES-0002',
      status: 'CONFIRMED',
      customerId: customer.id,
      vehicleId: vehicle2.id,
      vehicleTypeId: vehicleType.id,
      pickupLocationId: location.id,
      returnLocationId: location.id,
      pickupAt: new Date(pickupAt.getTime() + 60 * 60 * 1000),
      returnAt: new Date(returnAt.getTime() + 60 * 60 * 1000),
      customerInfoCompletedAt: now
    }
  });
}

console.log(JSON.stringify({
  step: 'h6-seed-extra',
  vehicleId: vehicle.id,
  reservationId: reservation.id,
  reservationNumber: reservation.reservationNumber,
  reservation2Id: reservation2.id,
  pickupAt
}, null, 2));
await prisma.$disconnect();
