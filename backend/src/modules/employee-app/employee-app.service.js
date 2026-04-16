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
    pickupLocation: true,
    returnLocation: true,
    pricingSnapshot: true,
    rentalAgreement: true
  };
}

function includeReservationLight() {
  return {
    customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
    vehicle: { select: { id: true, internalNumber: true, make: true, model: true, year: true, plate: true, vehicleTypeId: true } },
    pickupLocation: { select: { id: true, name: true, code: true } },
    returnLocation: { select: { id: true, name: true, code: true } }
  };
}

function includeIncident() {
  return {
    trip: {
      include: {
        listing: {
          include: {
            vehicle: true,
            location: true
          }
        },
        hostProfile: true,
        guestCustomer: true,
        reservation: {
          include: includeReservation()
        }
      }
    }
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

function incidentCard(row) {
  const reservation = row.trip?.reservation || null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    title: row.title,
    description: row.description || '',
    amountClaimed: row.amountClaimed,
    amountResolved: row.amountResolved,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    trip: row.trip
      ? {
          id: row.trip.id,
          tripCode: row.trip.tripCode,
          status: row.trip.status,
          scheduledPickupAt: row.trip.scheduledPickupAt,
          scheduledReturnAt: row.trip.scheduledReturnAt,
          listing: row.trip.listing
            ? {
                id: row.trip.listing.id,
                title: row.trip.listing.title,
                vehicle: row.trip.listing.vehicle
                  ? {
                      year: row.trip.listing.vehicle.year,
                      make: row.trip.listing.vehicle.make,
                      model: row.trip.listing.vehicle.model
                    }
                  : null
              }
            : null,
          hostProfile: row.trip.hostProfile
            ? {
                id: row.trip.hostProfile.id,
                displayName: row.trip.hostProfile.displayName
              }
            : null,
          guestCustomer: row.trip.guestCustomer
            ? {
                id: row.trip.guestCustomer.id,
                firstName: row.trip.guestCustomer.firstName,
                lastName: row.trip.guestCustomer.lastName,
                email: row.trip.guestCustomer.email
              }
            : null,
          reservation: reservation ? reservationCard(reservation) : null
        }
      : null
  };
}

function monthKey(value = new Date()) {
  const d = new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
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
    const incidentTenantWhere = {
      trip: {
        ...scope
      }
    };

    const selfMonthKey = monthKey(now);

    const [
      precheckinQueueRaw,
      checkoutQueueRaw,
      returnQueueRaw,
      activeQueueRaw,
      loanerReadyRaw,
      loanerAdvisorFollowupRaw,
      loanerBillingReviewRaw,
      loanerReturnsRaw,
      incidentEscalationsRaw,
      searchResultsRaw,
      counts,
      selfUser,
      selfCommissionRows
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
        include: includeReservationLight(),
        orderBy: [{ pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...scope,
          status: { in: ['NEW', 'CONFIRMED'] },
          pickupAt: { gte: startOfToday, lte: next72h }
        },
        include: includeReservationLight(),
        orderBy: [{ pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...scope,
          status: 'CHECKED_OUT',
          returnAt: { gte: startOfToday, lte: next72h }
        },
        include: includeReservationLight(),
        orderBy: [{ returnAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...scope,
          status: 'CHECKED_OUT'
        },
        include: includeReservationLight(),
        orderBy: [{ returnAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          readyForPickupAt: { not: null },
          status: { in: ['NEW', 'CONFIRMED'] }
        },
        include: includeReservationLight(),
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
        include: includeReservationLight(),
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
        include: includeReservationLight(),
        orderBy: [{ loanerBillingSubmittedAt: 'asc' }, { pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: 'CHECKED_OUT',
          returnAt: { lte: next72h }
        },
        include: includeReservationLight(),
        orderBy: [{ returnAt: 'asc' }],
        take: 8
      }),
      prisma.tripIncident.findMany({
        where: {
          ...incidentTenantWhere,
          status: { in: ['OPEN', 'UNDER_REVIEW'] }
        },
        include: includeIncident(),
        orderBy: [
          { status: 'asc' },
          { createdAt: 'asc' }
        ],
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
        prisma.reservation.count({ where: { ...loanerWhere, status: 'CHECKED_OUT', returnAt: { lt: now } } }),
        prisma.tripIncident.count({
          where: {
            ...incidentTenantWhere,
            status: 'OPEN'
          }
        }),
        prisma.tripIncident.count({
          where: {
            ...incidentTenantWhere,
            status: 'UNDER_REVIEW'
          }
        })
      ]),
      prisma.user.findFirst({
        where: {
          id: user?.sub || '__never__',
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          isActive: true,
          tenantId: true,
          commissionPlan: {
            select: { id: true, name: true, isActive: true }
          }
        }
      }),
      prisma.agreementCommission.findMany({
        where: {
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
          employeeUserId: user?.sub || '__never__',
          monthKey: selfMonthKey
        },
        select: {
          id: true,
          status: true,
          commissionAmount: true,
          calculatedAt: true,
          rentalAgreement: {
            select: {
              id: true,
              agreementNumber: true,
              reservationId: true
            }
          }
        },
        orderBy: [{ calculatedAt: 'desc' }],
        take: 12
      })
    ]);

    const selfCommissionSummary = {
      monthKey: selfMonthKey,
      commissionAmount: Number((selfCommissionRows || []).reduce((sum, row) => sum + Number(row?.commissionAmount || 0), 0).toFixed(2)),
      agreements: (selfCommissionRows || []).length,
      pending: (selfCommissionRows || []).filter((row) => String(row?.status || '').toUpperCase() === 'PENDING').length,
      approved: (selfCommissionRows || []).filter((row) => String(row?.status || '').toUpperCase() === 'APPROVED').length,
      paid: (selfCommissionRows || []).filter((row) => String(row?.status || '').toUpperCase() === 'PAID').length,
      recent: (selfCommissionRows || []).map((row) => ({
        id: row.id,
        status: row.status,
        commissionAmount: Number(row?.commissionAmount || 0),
        calculatedAt: row.calculatedAt,
        agreementNumber: row?.rentalAgreement?.agreementNumber || null,
        reservationId: row?.rentalAgreement?.reservationId || null
      }))
    };

    return {
      query,
      self: {
        profile: selfUser
          ? {
              id: selfUser.id,
              fullName: selfUser.fullName,
              email: selfUser.email,
              role: selfUser.role,
              isActive: !!selfUser.isActive,
              commissionPlan: selfUser.commissionPlan
                ? {
                    id: selfUser.commissionPlan.id,
                    name: selfUser.commissionPlan.name,
                    isActive: !!selfUser.commissionPlan.isActive
                  }
                : null
            }
          : null,
        commissions: selfCommissionSummary
      },
      metrics: {
        openReservations: counts[0],
        activeRentals: counts[1],
        precheckinQueue: counts[2],
        readyForPickup: counts[3],
        dueBackToday: counts[4],
        loanerOpen: counts[5],
        loanerReady: counts[6],
        loanerBillingAttention: counts[7],
        loanerOverdue: counts[8],
        issueOpen: counts[9],
        issueUnderReview: counts[10]
      },
      queues: {
        precheckin: precheckinQueueRaw.map(reservationCard),
        checkout: checkoutQueueRaw.map(reservationCard),
        returns: returnQueueRaw.map(reservationCard),
        active: activeQueueRaw.map(reservationCard),
        loanerReady: loanerReadyRaw.map(reservationCard),
        loanerAdvisorFollowup: loanerAdvisorFollowupRaw.map(reservationCard),
        loanerBillingReview: loanerBillingReviewRaw.map(reservationCard),
        loanerReturns: loanerReturnsRaw.map(reservationCard),
        issueEscalations: incidentEscalationsRaw.map(incidentCard)
      },
      searchResults: searchResultsRaw.map(reservationCard)
    };
  }
};
