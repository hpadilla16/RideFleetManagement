import { prisma } from '../../lib/prisma.js';
import { reservationsService } from '../reservations/reservations.service.js';

function tenantScope(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return {};
  return user?.tenantId ? { tenantId: user.tenantId } : { id: '__never__' };
}

function includeReservation() {
  return {
    customer: true,
    vehicle: { include: { vehicleType: true } },
    vehicleType: true,
    pickupLocation: true,
    returnLocation: true,
    rentalAgreement: true
  };
}

function matchesQuery(query) {
  if (!query) return undefined;
  return {
    OR: [
      { reservationNumber: { contains: query, mode: 'insensitive' } },
      { repairOrderNumber: { contains: query, mode: 'insensitive' } },
      { claimNumber: { contains: query, mode: 'insensitive' } },
      { serviceAdvisorName: { contains: query, mode: 'insensitive' } },
      { customer: { firstName: { contains: query, mode: 'insensitive' } } },
      { customer: { lastName: { contains: query, mode: 'insensitive' } } },
      { customer: { email: { contains: query, mode: 'insensitive' } } },
      { serviceVehiclePlate: { contains: query, mode: 'insensitive' } },
      { serviceVehicleVin: { contains: query, mode: 'insensitive' } }
    ]
  };
}

function reservationCard(row) {
  return {
    id: row.id,
    reservationNumber: row.reservationNumber,
    workflowMode: row.workflowMode,
    status: row.status,
    paymentStatus: row.paymentStatus,
    pickupAt: row.pickupAt,
    returnAt: row.returnAt,
    estimatedTotal: row.estimatedTotal,
    readyForPickupAt: row.readyForPickupAt,
    repairOrderNumber: row.repairOrderNumber,
    claimNumber: row.claimNumber,
    loanerBillingMode: row.loanerBillingMode,
    serviceAdvisorName: row.serviceAdvisorName,
    estimatedServiceCompletionAt: row.estimatedServiceCompletionAt,
    serviceVehicle: {
      year: row.serviceVehicleYear,
      make: row.serviceVehicleMake,
      model: row.serviceVehicleModel,
      plate: row.serviceVehiclePlate,
      vin: row.serviceVehicleVin
    },
    customer: row.customer
      ? {
          id: row.customer.id,
          firstName: row.customer.firstName,
          lastName: row.customer.lastName,
          email: row.customer.email,
          phone: row.customer.phone
        }
      : null,
    vehicle: row.vehicle
      ? {
          id: row.vehicle.id,
          make: row.vehicle.make,
          model: row.vehicle.model,
          year: row.vehicle.year,
          internalNumber: row.vehicle.internalNumber
        }
      : null,
    vehicleType: row.vehicleType ? { id: row.vehicleType.id, name: row.vehicleType.name } : null,
    pickupLocation: row.pickupLocation ? { id: row.pickupLocation.id, name: row.pickupLocation.name } : null,
    returnLocation: row.returnLocation ? { id: row.returnLocation.id, name: row.returnLocation.name } : null,
    rentalAgreement: row.rentalAgreement
      ? {
          id: row.rentalAgreement.id,
          status: row.rentalAgreement.status,
          balance: row.rentalAgreement.balance,
          total: row.rentalAgreement.total
        }
      : null
  };
}

async function ensureTenantFeature(scope = {}, tenantId = null) {
  const resolvedTenantId = tenantId || scope?.tenantId || null;
  if (!resolvedTenantId) return true;
  const tenant = await prisma.tenant.findUnique({
    where: { id: resolvedTenantId },
    select: { dealershipLoanerEnabled: true }
  });
  return !!tenant?.dealershipLoanerEnabled;
}

async function resolveCustomer(payload = {}, scope = {}) {
  if (payload.customerId) {
    const existing = await prisma.customer.findFirst({
      where: {
        id: String(payload.customerId),
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      }
    });
    if (!existing) throw new Error('Selected customer not found');
    return existing;
  }

  const firstName = String(payload.firstName || '').trim();
  const lastName = String(payload.lastName || '').trim();
  const phone = String(payload.phone || '').trim();
  const email = String(payload.email || '').trim().toLowerCase() || null;
  if (!firstName || !lastName || !phone) {
    throw new Error('Customer first name, last name, and phone are required');
  }

  if (email) {
    const existingByEmail = await prisma.customer.findFirst({
      where: {
        email,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      }
    });
    if (existingByEmail) return existingByEmail;
  }

  return prisma.customer.create({
    data: {
      tenantId: scope?.tenantId || null,
      firstName,
      lastName,
      phone,
      email
    }
  });
}

function makeReservationNumber() {
  return `DL-${Date.now().toString().slice(-8)}`;
}

export const dealershipLoanerService = {
  async getConfig(user, tenantId = null) {
    const role = String(user?.role || '').toUpperCase();
    if (role === 'SUPER_ADMIN') {
      if (!tenantId) return { enabled: true, tenantId: null, tenantName: null };
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, dealershipLoanerEnabled: true }
      });
      return {
        enabled: !!tenant?.dealershipLoanerEnabled || true,
        tenantId: tenant?.id || tenantId,
        tenantName: tenant?.name || null
      };
    }

    if (!user?.tenantId) return { enabled: false, tenantId: null, tenantName: null };
    const tenant = await prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { id: true, name: true, dealershipLoanerEnabled: true }
    });
    return {
      enabled: !!tenant?.dealershipLoanerEnabled,
      tenantId: tenant?.id || user.tenantId,
      tenantName: tenant?.name || null
    };
  },

  async getDashboard(user, input = {}) {
    const scope = tenantScope(user);
    const query = String(input?.query || '').trim();
    const now = new Date();
    const next72h = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);
    const loanerWhere = { ...scope, workflowMode: 'DEALERSHIP_LOANER' };

    const [intakeRaw, activeRaw, returnsRaw, searchRaw, counts] = await Promise.all([
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: { in: ['NEW', 'CONFIRMED'] },
          pickupAt: { gte: startOfToday, lte: next72h }
        },
        include: includeReservation(),
        orderBy: [{ pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: 'CHECKED_OUT'
        },
        include: includeReservation(),
        orderBy: [{ returnAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: { in: ['CONFIRMED', 'CHECKED_OUT'] },
          returnAt: { gte: startOfToday, lte: next72h }
        },
        include: includeReservation(),
        orderBy: [{ returnAt: 'asc' }],
        take: 8
      }),
      query
        ? prisma.reservation.findMany({
            where: {
              ...loanerWhere,
              ...(matchesQuery(query) || {})
            },
            include: includeReservation(),
            orderBy: [{ pickupAt: 'desc' }],
            take: 12
          })
        : Promise.resolve([]),
      Promise.all([
        prisma.reservation.count({ where: { ...loanerWhere, status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] } } }),
        prisma.reservation.count({ where: { ...loanerWhere, status: 'CHECKED_OUT' } }),
        prisma.reservation.count({ where: { ...loanerWhere, status: { in: ['NEW', 'CONFIRMED'] }, pickupAt: { gte: startOfToday, lt: endOfToday } } }),
        prisma.reservation.count({ where: { ...loanerWhere, status: { in: ['CONFIRMED', 'CHECKED_OUT'] }, returnAt: { gte: startOfToday, lt: endOfToday } } }),
        prisma.reservation.count({ where: { ...loanerWhere, readyForPickupAt: { not: null }, status: { in: ['NEW', 'CONFIRMED'] } } })
      ])
    ]);

    return {
      query,
      metrics: {
        openLoaners: counts[0],
        activeLoaners: counts[1],
        pickupsToday: counts[2],
        dueBackToday: counts[3],
        readyForDelivery: counts[4]
      },
      queues: {
        intake: intakeRaw.map(reservationCard),
        active: activeRaw.map(reservationCard),
        returns: returnsRaw.map(reservationCard)
      },
      searchResults: searchRaw.map(reservationCard)
    };
  },

  async getIntakeOptions(user) {
    const scope = tenantScope(user);
    const [customers, locations, vehicleTypes, vehicles] = await Promise.all([
      prisma.customer.findMany({
        where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: { id: true, firstName: true, lastName: true, email: true, phone: true }
      }),
      prisma.location.findMany({
        where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
        orderBy: { name: 'asc' },
        select: { id: true, name: true }
      }),
      prisma.vehicleType.findMany({
        where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
        orderBy: { name: 'asc' },
        select: { id: true, name: true }
      }),
      prisma.vehicle.findMany({
        where: {
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
          status: { notIn: ['IN_MAINTENANCE', 'OUT_OF_SERVICE'] }
        },
        orderBy: [{ make: 'asc' }, { model: 'asc' }, { internalNumber: 'asc' }],
        select: {
          id: true,
          year: true,
          make: true,
          model: true,
          internalNumber: true,
          status: true
        }
      })
    ]);

    return { customers, locations, vehicleTypes, vehicles };
  },

  async intake(user, payload = {}) {
    const scope = tenantScope(user);
    const role = String(user?.role || '').toUpperCase();
    if (role !== 'SUPER_ADMIN') {
      const enabled = await ensureTenantFeature(scope);
      if (!enabled) throw new Error('Dealership loaner is not enabled for this tenant');
    }

    const customer = await resolveCustomer(payload, scope);
    if (!payload.vehicleTypeId) throw new Error('vehicleTypeId is required');
    if (!payload.pickupLocationId || !payload.returnLocationId) throw new Error('pickupLocationId and returnLocationId are required');
    if (!payload.pickupAt || !payload.returnAt) throw new Error('pickupAt and returnAt are required');
    if (!payload.loanerLiabilityAccepted) throw new Error('Customer liability acknowledgement is required');

    const billingMode = String(payload.loanerBillingMode || 'COURTESY').toUpperCase();
    const reservation = await reservationsService.create({
      reservationNumber: String(payload.reservationNumber || '').trim() || makeReservationNumber(),
      sourceRef: String(payload.sourceRef || '').trim() || `LOANER:${String(payload.repairOrderNumber || 'NA')}:${Date.now()}`,
      customerId: customer.id,
      vehicleId: payload.vehicleId ? String(payload.vehicleId) : null,
      vehicleTypeId: String(payload.vehicleTypeId),
      pickupAt: payload.pickupAt,
      returnAt: payload.returnAt,
      pickupLocationId: String(payload.pickupLocationId),
      returnLocationId: String(payload.returnLocationId),
      dailyRate: billingMode === 'COURTESY' || billingMode === 'WARRANTY' || billingMode === 'INTERNAL' ? 0 : Number(payload.dailyRate || 0),
      estimatedTotal: billingMode === 'COURTESY' || billingMode === 'WARRANTY' || billingMode === 'INTERNAL' ? 0 : Number(payload.estimatedTotal || 0),
      paymentStatus: 'PENDING',
      status: 'CONFIRMED',
      sendConfirmationEmail: false,
      notes: payload.notes || null,
      workflowMode: 'DEALERSHIP_LOANER',
      loanerBillingMode: billingMode,
      repairOrderNumber: payload.repairOrderNumber || null,
      claimNumber: payload.claimNumber || null,
      serviceAdvisorName: payload.serviceAdvisorName || null,
      serviceAdvisorEmail: payload.serviceAdvisorEmail || null,
      serviceAdvisorPhone: payload.serviceAdvisorPhone || null,
      serviceStartAt: payload.serviceStartAt || payload.pickupAt,
      estimatedServiceCompletionAt: payload.estimatedServiceCompletionAt || payload.returnAt,
      serviceVehicleYear: payload.serviceVehicleYear ? Number(payload.serviceVehicleYear) : null,
      serviceVehicleMake: payload.serviceVehicleMake || null,
      serviceVehicleModel: payload.serviceVehicleModel || null,
      serviceVehiclePlate: payload.serviceVehiclePlate || null,
      serviceVehicleVin: payload.serviceVehicleVin || null,
      loanerLiabilityAccepted: true,
      loanerProgramNotes: payload.loanerProgramNotes || null
    }, scope);

    return reservationsService.getById(reservation.id, scope);
  }
};
