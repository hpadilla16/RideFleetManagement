import { prisma } from '../../lib/prisma.js';

function scopedReservationWhere(id, scope = {}) {
  return { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) };
}

function parseDriversFromNotes(notes) {
  const m = String(notes || '').match(/\[RES_ADDITIONAL_DRIVERS\](\{[^\n]*\})/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed?.drivers) ? parsed.drivers : [];
  } catch {
    return [];
  }
}

function normalizeDriver(input = {}) {
  const dobRaw = input?.dateOfBirth ? new Date(input.dateOfBirth) : null;
  const dateOfBirth = dobRaw && !Number.isNaN(dobRaw.getTime()) ? dobRaw : null;
  return {
    firstName: String(input?.firstName || '').trim(),
    lastName: String(input?.lastName || '').trim(),
    address: input?.address ? String(input.address).trim() : null,
    dateOfBirth,
    licenseNumber: input?.licenseNumber ? String(input.licenseNumber).trim() : null,
    licenseImageUploaded: !!input?.licenseImageUploaded,
    notes: input?.notes ? String(input.notes) : null
  };
}

async function getReservationOrThrow(id, scope = {}) {
  const reservation = await prisma.reservation.findFirst({
    where: scopedReservationWhere(id, scope),
    include: {
      additionalDrivers: { orderBy: { createdAt: 'asc' } },
      rentalAgreement: { select: { id: true } }
    }
  });
  if (!reservation) throw new Error('Reservation not found');
  return reservation;
}

export const reservationAdditionalDriversService = {
  async list(reservationId, scope = {}) {
    const reservation = await getReservationOrThrow(reservationId, scope);
    if (Array.isArray(reservation.additionalDrivers) && reservation.additionalDrivers.length) {
      return reservation.additionalDrivers;
    }
    return parseDriversFromNotes(reservation.notes).map((driver, idx) => ({
      id: `legacy-${idx}`,
      firstName: String(driver?.firstName || ''),
      lastName: String(driver?.lastName || ''),
      address: driver?.address ? String(driver.address) : null,
      dateOfBirth: driver?.dateOfBirth || null,
      licenseNumber: driver?.licenseNumber ? String(driver.licenseNumber) : null,
      licenseImageUploaded: !!driver?.licenseImageUploaded,
      notes: null,
      source: 'legacy-note'
    }));
  },

  async replace(reservationId, drivers = [], scope = {}) {
    const reservation = await getReservationOrThrow(reservationId, scope);
    const normalized = (Array.isArray(drivers) ? drivers : [])
      .map((driver) => normalizeDriver(driver))
      .filter((driver) => driver.firstName && driver.lastName);
    const currentNotes = String(reservation.notes || '');
    const cleanedNotes = currentNotes
      .replace(/\n?\[RES_ADDITIONAL_DRIVERS\]\{[^\n]*\}/g, '')
      .trim();
    const shouldCleanLegacyNotes = cleanedNotes !== currentNotes.trim();

    await prisma.$transaction(async (tx) => {
      await tx.reservationAdditionalDriver.deleteMany({ where: { reservationId } });
      if (normalized.length) {
        await tx.reservationAdditionalDriver.createMany({
          data: normalized.map((driver) => ({
            reservationId,
            ...driver
          }))
        });
      }
      if (shouldCleanLegacyNotes) {
        await tx.reservation.update({
          where: { id: reservationId },
          data: { notes: cleanedNotes || null }
        });
      }
    });

    return prisma.reservationAdditionalDriver.findMany({
      where: { reservationId },
      orderBy: { createdAt: 'asc' }
    });
  }
};
