import { prisma } from '../../lib/prisma.js';

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
    pricingSnapshot: true,
    rentalAgreement: true
  };
}

function matchesQuery(query) {
  if (!query) return undefined;
  return {
    OR: [
      { reservationNumber: { contains: query, mode: 'insensitive' } },
      { customer: { firstName: { contains: query, mode: 'insensitive' } } },
      { customer: { lastName: { contains: query, mode: 'insensitive' } } },
      { customer: { email: { contains: query, mode: 'insensitive' } } },
      { vehicle: { make: { contains: query, mode: 'insensitive' } } },
      { vehicle: { model: { contains: query, mode: 'insensitive' } } },
      { vehicle: { internalNumber: { contains: query, mode: 'insensitive' } } }
    ]
  };
}

function reservationCard(row) {
  return {
    id: row.id,
    reservationNumber: row.reservationNumber,
    status: row.status,
    workflowMode: row.workflowMode || 'RENTAL',
    paymentStatus: row.paymentStatus,
    pickupAt: row.pickupAt,
    returnAt: row.returnAt,
    estimatedTotal: row.estimatedTotal,
    readyForPickupAt: row.readyForPickupAt,
    customerInfoCompletedAt: row.customerInfoCompletedAt,
    customerInfoReviewedAt: row.customerInfoReviewedAt,
    estimatedServiceCompletionAt: row.estimatedServiceCompletionAt,
    repairOrderNumber: row.repairOrderNumber || '',
    claimNumber: row.claimNumber || '',
    serviceAdvisorName: row.serviceAdvisorName || '',
    loanerBillingMode: row.loanerBillingMode || '',
    loanerBillingStatus: row.loanerBillingStatus || '',
    loanerBorrowerPacketCompletedAt: row.loanerBorrowerPacketCompletedAt,
    loanerReturnExceptionFlag: !!row.loanerReturnExceptionFlag,
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
          internalNumber: row.vehicle.internalNumber,
          plate: row.vehicle.plate || row.vehicle.licensePlate || ''
        }
      : null,
    vehicleType: row.vehicleType
      ? {
          id: row.vehicleType.id,
          name: row.vehicleType.name
        }
      : null,
    pickupLocation: row.pickupLocation ? { id: row.pickupLocation.id, name: row.pickupLocation.name } : null,
    returnLocation: row.returnLocation ? { id: row.returnLocation.id, name: row.returnLocation.name } : null,
    rentalAgreement: row.rentalAgreement
      ? {
          id: row.rentalAgreement.id,
          balance: row.rentalAgreement.balance,
          total: row.rentalAgreement.total
        }
      : null
  };
}

export const employeeAppService = {
  async getDashboard(user, input = {}) {
    const scope = tenantScope(user);
    const query = String(input?.query || '').trim();
    const now = new Date();
    const next72h = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);

    const searchWhere = {
      ...scope,
      ...(matchesQuery(query) || {})
    };
    const loanerWhere = {
      ...scope,
      workflowMode: 'DEALERSHIP_LOANER'
    };

    const [
      precheckinQueueRaw,
      checkoutQueueRaw,
      returnQueueRaw,
      activeQueueRaw,
      loanerReadyRaw,
      loanerAdvisorFollowupRaw,
      loanerBillingReviewRaw,
      loanerReturnsRaw,
      searchResultsRaw,
      counts
    ] = await Promise.all([
      prisma.reservation.findMany({
        where: {
          ...scope,
          OR: [
            { customerInfoCompletedAt: { not: null } },
            { customerInfoToken: { not: null } }
          ],
          status: { in: ['NEW', 'CONFIRMED'] }
        },
        include: includeReservation(),
        orderBy: [{ pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...scope,
          status: { in: ['NEW', 'CONFIRMED'] },
          pickupAt: { gte: startOfToday, lte: next72h }
        },
        include: includeReservation(),
        orderBy: [{ pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...scope,
          status: 'CHECKED_OUT',
          returnAt: { gte: startOfToday, lte: next72h }
        },
        include: includeReservation(),
        orderBy: [{ returnAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...scope,
          status: 'CHECKED_OUT'
        },
        include: includeReservation(),
        orderBy: [{ returnAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          readyForPickupAt: { not: null },
          status: { in: ['NEW', 'CONFIRMED'] }
        },
        include: includeReservation(),
        orderBy: [{ readyForPickupAt: 'desc' }, { pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: { in: ['NEW', 'CONFIRMED'] },
          OR: [
            { loanerBorrowerPacketCompletedAt: null },
            { readyForPickupAt: null, estimatedServiceCompletionAt: { lt: now } },
            { loanerBillingStatus: 'DENIED' }
          ]
        },
        include: includeReservation(),
        orderBy: [{ estimatedServiceCompletionAt: 'asc' }, { pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: { not: 'CANCELLED' },
          loanerBillingMode: { in: ['CUSTOMER_PAY', 'WARRANTY', 'INSURANCE'] },
          loanerBillingStatus: { not: 'SETTLED' }
        },
        include: includeReservation(),
        orderBy: [{ loanerBillingSubmittedAt: 'asc' }, { pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: 'CHECKED_OUT',
          returnAt: { lte: next72h }
        },
        include: includeReservation(),
        orderBy: [{ returnAt: 'asc' }],
        take: 8
      }),
      query
        ? prisma.reservation.findMany({
            where: searchWhere,
            include: includeReservation(),
            orderBy: [{ pickupAt: 'desc' }],
            take: 12
          })
        : Promise.resolve([]),
      Promise.all([
        prisma.reservation.count({ where: { ...scope, status: { in: ['NEW', 'CONFIRMED'] } } }),
        prisma.reservation.count({ where: { ...scope, status: 'CHECKED_OUT' } }),
        prisma.reservation.count({
          where: {
            ...scope,
            OR: [
              { customerInfoCompletedAt: { not: null } },
              { customerInfoToken: { not: null } }
            ],
            status: { in: ['NEW', 'CONFIRMED'] }
          }
        }),
        prisma.reservation.count({
          where: {
            ...scope,
            readyForPickupAt: { not: null },
            status: { in: ['NEW', 'CONFIRMED'] }
          }
        }),
        prisma.reservation.count({
          where: {
            ...scope,
            status: 'CHECKED_OUT',
            returnAt: { gte: startOfToday, lt: endOfToday }
          }
        }),
        prisma.reservation.count({ where: { ...loanerWhere, status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] } } }),
        prisma.reservation.count({ where: { ...loanerWhere, readyForPickupAt: { not: null }, status: { in: ['NEW', 'CONFIRMED'] } } }),
        prisma.reservation.count({
          where: {
            ...loanerWhere,
            status: { not: 'CANCELLED' },
            loanerBillingMode: { in: ['CUSTOMER_PAY', 'WARRANTY', 'INSURANCE'] },
            loanerBillingStatus: { not: 'SETTLED' }
          }
        }),
        prisma.reservation.count({ where: { ...loanerWhere, status: 'CHECKED_OUT', returnAt: { lt: now } } })
      ])
    ]);

    return {
      query,
      metrics: {
        openReservations: counts[0],
        activeRentals: counts[1],
        precheckinQueue: counts[2],
        readyForPickup: counts[3],
        dueBackToday: counts[4],
        loanerOpen: counts[5],
        loanerReady: counts[6],
        loanerBillingAttention: counts[7],
        loanerOverdue: counts[8]
      },
      queues: {
        precheckin: precheckinQueueRaw.map(reservationCard),
        checkout: checkoutQueueRaw.map(reservationCard),
        returns: returnQueueRaw.map(reservationCard),
        active: activeQueueRaw.map(reservationCard),
        loanerReady: loanerReadyRaw.map(reservationCard),
        loanerAdvisorFollowup: loanerAdvisorFollowupRaw.map(reservationCard),
        loanerBillingReview: loanerBillingReviewRaw.map(reservationCard),
        loanerReturns: loanerReturnsRaw.map(reservationCard)
      },
      searchResults: searchResultsRaw.map(reservationCard)
    };
  }
};
