import { prisma } from '../../lib/prisma.js';
import { hostReviewsService } from '../host-reviews/host-reviews.service.js';
import { computeMarketplaceTripPricing } from './car-sharing-pricing.js';

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function listingInclude() {
  return {
    hostProfile: true,
    vehicle: { include: { vehicleType: true } },
    location: true,
    pickupSpot: {
      include: {
        anchorLocation: true
      }
    },
    tenant: true,
    availabilityWindows: {
      orderBy: [{ startAt: 'asc' }]
    }
  };
}

function tripInclude() {
  return {
    listing: {
      include: {
        vehicle: { include: { vehicleType: true } },
        location: true,
        pickupSpot: {
          include: {
            anchorLocation: true
          }
        }
      }
    },
    hostProfile: true,
    guestCustomer: true,
    reservation: {
      include: {
        pricingSnapshot: true,
        rentalAgreement: true
      }
    },
    hostReview: true,
    pickupLocation: true,
    returnLocation: true,
    timelineEvents: { orderBy: [{ eventAt: 'desc' }], take: 10 }
  };
}

function generateTripCode() {
  return `TRIP-${Date.now().toString().slice(-8)}`;
}

function generateReservationNumber() {
  return `CS-${Date.now().toString().slice(-8)}`;
}

function ceilTripDays(startAt, endAt) {
  return Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / (24 * 60 * 60 * 1000)));
}

function overlapsWindow(windowStart, windowEnd, tripStart, tripEnd) {
  return windowStart < tripEnd && windowEnd > tripStart;
}

function startOfUtcDay(dt) {
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

function addUtcDays(dt, days) {
  const copy = new Date(dt);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function computeTripPricing(listing, windows, startAt, endAt) {
  const tripDays = ceilTripDays(startAt, endAt);
  const dayRates = [];
  const tripStartDay = startOfUtcDay(startAt);
  for (let idx = 0; idx < tripDays; idx += 1) {
    const dayStart = addUtcDays(tripStartDay, idx);
    const dayEnd = addUtcDays(dayStart, 1);
    const overrideWindow = windows.find((window) =>
      window.priceOverride !== null
      && window.priceOverride !== undefined
      && overlapsWindow(new Date(window.startAt), new Date(window.endAt), dayStart, dayEnd)
    );
    dayRates.push(Number(overrideWindow?.priceOverride ?? listing.baseDailyRate ?? 0));
  }
  const pricing = computeMarketplaceTripPricing({
    subtotal: dayRates.reduce((sum, value) => sum + value, 0),
    cleaningFee: Number(listing.cleaningFee ?? 0),
    deliveryFee: Number(listing.deliveryFee ?? 0),
    taxes: 0,
    hostProfile: listing.hostProfile
  });
  return {
    tripDays,
    subtotal: pricing.tripSubtotal,
    fees: pricing.quotedFees,
    taxes: pricing.quotedTaxes,
    total: pricing.quotedTotal,
    hostGrossRevenue: pricing.hostGrossRevenue,
    hostServiceFeeRate: pricing.hostServiceFeeRate,
    hostServiceFee: pricing.hostServiceFee,
    guestTripFee: pricing.guestTripFee,
    platformRevenue: pricing.platformRevenue,
    platformFee: pricing.platformFee,
    hostEarnings: pricing.hostEarnings
  };
}

async function createReservationForTrip({ tenantId, listing, guestCustomerId, pickupAt, returnAt, pickupLocationId, returnLocationId, quote, tripCode, notes }) {
  const reservation = await prisma.reservation.create({
    data: {
      tenantId,
      reservationNumber: generateReservationNumber(),
      sourceRef: `CARSHARE:${tripCode}`,
      status: 'CONFIRMED',
      workflowMode: 'CAR_SHARING',
      customerId: guestCustomerId,
      vehicleId: listing.vehicleId,
      vehicleTypeId: listing.vehicle?.vehicleTypeId || null,
      pickupAt,
      returnAt,
      pickupLocationId,
      returnLocationId,
      dailyRate: Number(listing.baseDailyRate || 0),
      estimatedTotal: quote.total,
      paymentStatus: 'PENDING',
      sendConfirmationEmail: false,
      notes: notes ? `[CAR SHARING TRIP ${tripCode}] ${notes}` : `[CAR SHARING TRIP ${tripCode}]`
    }
  });

  await prisma.reservationPricingSnapshot.create({
    data: {
      reservationId: reservation.id,
      dailyRate: Number(listing.baseDailyRate || 0),
      taxRate: 0,
      securityDepositRequired: Number(listing.securityDeposit || 0) > 0,
      securityDepositAmount: Number(listing.securityDeposit || 0),
      source: 'CAR_SHARING_TRIP'
    }
  });

  const charges = [
    {
      reservationId: reservation.id,
      code: 'TRIP_DAILY',
      name: 'Trip Daily Rate',
      chargeType: 'DAILY',
      quantity: quote.tripDays,
      rate: Number((quote.subtotal / Math.max(1, quote.tripDays)).toFixed(2)),
      total: quote.subtotal,
      taxable: true,
      selected: true,
      sortOrder: 0,
      source: 'CAR_SHARING_TRIP',
      sourceRefId: listing.id
    },
    ...(Number(listing.cleaningFee || 0) > 0 ? [{
      reservationId: reservation.id,
      code: 'CLEANING_FEE',
      name: 'Cleaning Fee',
      chargeType: 'UNIT',
      quantity: 1,
      rate: Number(listing.cleaningFee || 0),
      total: Number(listing.cleaningFee || 0),
      taxable: false,
      selected: true,
      sortOrder: 1,
      source: 'CAR_SHARING_TRIP',
      sourceRefId: listing.id
    }] : []),
    ...(Number(listing.deliveryFee || 0) > 0 ? [{
      reservationId: reservation.id,
      code: 'DELIVERY_FEE',
      name: 'Delivery Fee',
      chargeType: 'UNIT',
      quantity: 1,
      rate: Number(listing.deliveryFee || 0),
      total: Number(listing.deliveryFee || 0),
      taxable: false,
      selected: true,
      sortOrder: 2,
      source: 'CAR_SHARING_TRIP',
      sourceRefId: listing.id
    }] : []),
    ...(Number(listing.securityDeposit || 0) > 0 ? [{
      reservationId: reservation.id,
      code: 'SECURITY_DEPOSIT',
      name: 'Security Deposit',
      chargeType: 'DEPOSIT',
      quantity: 1,
      rate: Number(listing.securityDeposit || 0),
      total: Number(listing.securityDeposit || 0),
      taxable: false,
      selected: true,
      sortOrder: 3,
      source: 'CAR_SHARING_TRIP',
      sourceRefId: listing.id
    }] : [])
  ];

  await prisma.reservationCharge.createMany({ data: charges });
  return reservation;
}

async function ensureReservationForTrip(tripId, scope = {}) {
  const trip = await prisma.trip.findFirst({
    where: { id: tripId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
    include: {
      reservation: true,
      listing: {
        include: {
          vehicle: { select: { vehicleTypeId: true } }
        }
      }
    }
  });
  if (!trip) throw new Error('Trip not found');
  await assertTenantCarSharingEnabled(trip.tenantId);
  if (trip.reservationId && trip.reservation) {
    return prisma.trip.findUnique({
      where: { id: trip.id },
      include: tripInclude()
    });
  }
  if (!trip.listing) throw new Error('Trip listing not found');
  if (!trip.guestCustomerId) throw new Error('Trip is missing guestCustomerId');
  if (!trip.pickupLocationId || !trip.returnLocationId) {
    throw new Error('Trip is missing pickup or return locations');
  }

  const tripDays = ceilTripDays(new Date(trip.scheduledPickupAt), new Date(trip.scheduledReturnAt));
  const quote = {
    tripDays,
    subtotal: Number(trip.quotedSubtotal || 0),
    fees: Number(trip.quotedFees || 0),
    taxes: Number(trip.quotedTaxes || 0),
    total: Number(trip.quotedTotal || 0),
    hostGrossRevenue: Number(trip.hostGrossRevenue || 0),
    hostServiceFeeRate: Number(trip.hostServiceFeeRate || 0),
    hostServiceFee: Number(trip.hostServiceFee || 0),
    guestTripFee: Number(trip.guestTripFee || 0),
    platformRevenue: Number(trip.platformRevenue || trip.platformFee || 0),
    hostEarnings: Number(trip.hostEarnings || 0),
    platformFee: Number(trip.platformFee || 0)
  };

  const reservation = await createReservationForTrip({
    tenantId: trip.tenantId,
    listing: trip.listing,
    guestCustomerId: trip.guestCustomerId,
    pickupAt: new Date(trip.scheduledPickupAt),
    returnAt: new Date(trip.scheduledReturnAt),
    pickupLocationId: trip.pickupLocationId,
    returnLocationId: trip.returnLocationId,
    quote,
    tripCode: trip.tripCode,
    notes: trip.notes ? `${trip.notes}\n[Workflow backfilled from existing trip]` : '[Workflow backfilled from existing trip]'
  });

  await prisma.trip.update({
    where: { id: trip.id },
    data: {
      reservationId: reservation.id,
      timelineEvents: {
        create: [{
          eventType: 'TRIP_WORKFLOW_LINKED',
          actorType: scope?.actorUserId ? 'TENANT_USER' : 'SYSTEM',
          actorRefId: scope?.actorUserId || null,
          notes: 'Operational reservation workflow created for existing trip',
          metadata: JSON.stringify({
            reservationId: reservation.id,
            reservationNumber: reservation.reservationNumber
          })
        }]
      }
    }
  });

  return prisma.trip.findUnique({
    where: { id: trip.id },
    include: tripInclude()
  });
}

const TRIP_STATUS_TRANSITIONS = {
  RESERVED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['READY_FOR_PICKUP', 'CANCELLED'],
  READY_FOR_PICKUP: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'DISPUTED'],
  COMPLETED: [],
  CANCELLED: [],
  DISPUTED: ['COMPLETED']
};

async function assertTenantCarSharingEnabled(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { carSharingEnabled: true }
  });
  if (!tenant?.carSharingEnabled) {
    throw new Error('Car sharing is not enabled for this tenant');
  }
}

export const carSharingService = {
  async listEligibleVehicles({ tenantId, allowUnassigned } = {}) {
    return prisma.vehicle.findMany({
      where: {
        ...(tenantId
          ? allowUnassigned
            ? { OR: [{ tenantId }, { tenantId: null }] }
            : { tenantId }
          : {}),
        fleetMode: { in: ['CAR_SHARING_ONLY', 'BOTH'] }
      },
      include: {
        vehicleType: true,
        homeLocation: true,
        hostListing: { select: { id: true, title: true, status: true } }
      },
      orderBy: [{ createdAt: 'desc' }]
    });
  },

  async listHosts({ tenantId } = {}) {
    return prisma.hostProfile.findMany({
      where: {
        ...(tenantId ? { tenantId } : {})
      },
      include: {
        tenant: true,
        user: true,
        _count: { select: { listings: true, trips: true, payouts: true } }
      },
      orderBy: [{ createdAt: 'desc' }]
    });
  },

  async createHost(data, scope = {}) {
    const tenantId = scope?.tenantId || data?.tenantId || null;
    if (!tenantId) throw new Error('tenantId is required');
    await assertTenantCarSharingEnabled(tenantId);
    const displayName = String(data?.displayName || '').trim();
    if (!displayName) throw new Error('displayName is required');

    return prisma.hostProfile.create({
      data: {
        tenantId,
        userId: data?.userId || null,
        displayName,
        legalName: data?.legalName ? String(data.legalName).trim() : null,
        email: data?.email ? String(data.email).trim().toLowerCase() : null,
        phone: data?.phone ? String(data.phone).trim() : null,
        status: data?.status ? String(data.status).trim().toUpperCase() : 'ACTIVE',
        payoutProvider: data?.payoutProvider ? String(data.payoutProvider).trim() : null,
        payoutAccountRef: data?.payoutAccountRef ? String(data.payoutAccountRef).trim() : null,
        payoutEnabled: !!data?.payoutEnabled,
        notes: data?.notes ? String(data.notes).trim() : null
      },
      include: {
        tenant: true,
        user: true,
        _count: { select: { listings: true, trips: true, payouts: true } }
      }
    });
  },

  async updateHost(id, patch, scope = {}) {
    const current = await prisma.hostProfile.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!current) throw new Error('Host profile not found');

    return prisma.hostProfile.update({
      where: { id },
      data: {
        userId: Object.prototype.hasOwnProperty.call(patch || {}, 'userId') ? (patch?.userId || null) : undefined,
        displayName: Object.prototype.hasOwnProperty.call(patch || {}, 'displayName') ? String(patch?.displayName || '').trim() : undefined,
        legalName: Object.prototype.hasOwnProperty.call(patch || {}, 'legalName') ? (patch?.legalName ? String(patch.legalName).trim() : null) : undefined,
        email: Object.prototype.hasOwnProperty.call(patch || {}, 'email') ? (patch?.email ? String(patch.email).trim().toLowerCase() : null) : undefined,
        phone: Object.prototype.hasOwnProperty.call(patch || {}, 'phone') ? (patch?.phone ? String(patch.phone).trim() : null) : undefined,
        status: Object.prototype.hasOwnProperty.call(patch || {}, 'status') ? String(patch?.status || 'ACTIVE').trim().toUpperCase() : undefined,
        payoutProvider: Object.prototype.hasOwnProperty.call(patch || {}, 'payoutProvider') ? (patch?.payoutProvider ? String(patch.payoutProvider).trim() : null) : undefined,
        payoutAccountRef: Object.prototype.hasOwnProperty.call(patch || {}, 'payoutAccountRef') ? (patch?.payoutAccountRef ? String(patch.payoutAccountRef).trim() : null) : undefined,
        payoutEnabled: Object.prototype.hasOwnProperty.call(patch || {}, 'payoutEnabled') ? !!patch?.payoutEnabled : undefined,
        notes: Object.prototype.hasOwnProperty.call(patch || {}, 'notes') ? (patch?.notes ? String(patch.notes).trim() : null) : undefined
      },
      include: {
        tenant: true,
        user: true,
        _count: { select: { listings: true, trips: true, payouts: true } }
      }
    });
  },

  async listListings({ tenantId, hostProfileId, status } = {}) {
    return prisma.hostVehicleListing.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        ...(hostProfileId ? { hostProfileId } : {}),
        ...(status ? { status } : {})
      },
      include: listingInclude(),
      orderBy: [{ createdAt: 'desc' }]
    });
  },

  async listTrips({ tenantId, listingId, status } = {}) {
    return prisma.trip.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        ...(listingId ? { listingId } : {}),
        ...(status ? { status } : {})
      },
      include: tripInclude(),
      orderBy: [{ createdAt: 'desc' }]
    });
  },

  async listAvailabilityWindows(listingId, scope = {}) {
    const listing = await prisma.hostVehicleListing.findFirst({
      where: { id: listingId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!listing) throw new Error('Listing not found');
    return prisma.listingAvailabilityWindow.findMany({
      where: { listingId },
      orderBy: [{ startAt: 'asc' }]
    });
  },

  async createAvailabilityWindow(listingId, data, scope = {}) {
    const listing = await prisma.hostVehicleListing.findFirst({
      where: { id: listingId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true, tenantId: true }
    });
    if (!listing) throw new Error('Listing not found');
    await assertTenantCarSharingEnabled(listing.tenantId);
    const startAt = data?.startAt ? new Date(data.startAt) : null;
    const endAt = data?.endAt ? new Date(data.endAt) : null;
    if (!startAt || !endAt || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new Error('startAt and endAt are required');
    }
    if (startAt >= endAt) throw new Error('endAt must be after startAt');
    return prisma.listingAvailabilityWindow.create({
      data: {
        listingId,
        startAt,
        endAt,
        isBlocked: !!data?.isBlocked,
        priceOverride: data?.priceOverride === '' || data?.priceOverride === null || data?.priceOverride === undefined ? null : data.priceOverride,
        minTripDaysOverride: data?.minTripDaysOverride ? Number(data.minTripDaysOverride) : null,
        note: data?.note ? String(data.note).trim() : null
      }
    });
  },

  async updateAvailabilityWindow(id, patch, scope = {}) {
    const current = await prisma.listingAvailabilityWindow.findFirst({
      where: {
        id,
        listing: scope?.tenantId ? { tenantId: scope.tenantId } : undefined
      },
      include: { listing: { select: { tenantId: true } } }
    });
    if (!current) throw new Error('Availability window not found');
    await assertTenantCarSharingEnabled(current.listing?.tenantId);
    const nextStartAt = Object.prototype.hasOwnProperty.call(patch || {}, 'startAt') ? new Date(patch.startAt) : current.startAt;
    const nextEndAt = Object.prototype.hasOwnProperty.call(patch || {}, 'endAt') ? new Date(patch.endAt) : current.endAt;
    if (Number.isNaN(nextStartAt.getTime()) || Number.isNaN(nextEndAt.getTime())) {
      throw new Error('startAt and endAt must be valid dates');
    }
    if (nextStartAt >= nextEndAt) throw new Error('endAt must be after startAt');
    return prisma.listingAvailabilityWindow.update({
      where: { id },
      data: {
        startAt: Object.prototype.hasOwnProperty.call(patch || {}, 'startAt') ? nextStartAt : undefined,
        endAt: Object.prototype.hasOwnProperty.call(patch || {}, 'endAt') ? nextEndAt : undefined,
        isBlocked: Object.prototype.hasOwnProperty.call(patch || {}, 'isBlocked') ? !!patch?.isBlocked : undefined,
        priceOverride: Object.prototype.hasOwnProperty.call(patch || {}, 'priceOverride')
          ? (patch?.priceOverride === '' || patch?.priceOverride === null || patch?.priceOverride === undefined ? null : patch.priceOverride)
          : undefined,
        minTripDaysOverride: Object.prototype.hasOwnProperty.call(patch || {}, 'minTripDaysOverride')
          ? (patch?.minTripDaysOverride ? Number(patch.minTripDaysOverride) : null)
          : undefined,
        note: Object.prototype.hasOwnProperty.call(patch || {}, 'note') ? (patch?.note ? String(patch.note).trim() : null) : undefined
      }
    });
  },

  async deleteAvailabilityWindow(id, scope = {}) {
    const current = await prisma.listingAvailabilityWindow.findFirst({
      where: {
        id,
        listing: scope?.tenantId ? { tenantId: scope.tenantId } : undefined
      },
      select: { id: true }
    });
    if (!current) throw new Error('Availability window not found');
    await prisma.listingAvailabilityWindow.delete({ where: { id } });
    return { ok: true };
  },

  async createListing(data, scope = {}) {
    const tenantId = scope?.tenantId || data?.tenantId || null;
    if (!tenantId) throw new Error('tenantId is required');
    await assertTenantCarSharingEnabled(tenantId);
    const hostProfileId = String(data?.hostProfileId || '').trim();
    const vehicleId = String(data?.vehicleId || '').trim();
    const title = String(data?.title || '').trim();
    if (!hostProfileId) throw new Error('hostProfileId is required');
    if (!vehicleId) throw new Error('vehicleId is required');
    if (!title) throw new Error('title is required');

    const vehicle = await prisma.vehicle.findFirst({
      where: {
        id: vehicleId,
        ...(scope?.allowUnassigned ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId })
      },
      select: { id: true, tenantId: true, fleetMode: true }
    });
    if (!vehicle) throw new Error('Vehicle not found for this tenant');
    if (!['CAR_SHARING_ONLY', 'BOTH'].includes(String(vehicle.fleetMode || 'RENTAL_ONLY'))) {
      throw new Error('Vehicle must be marked for car sharing before it can be listed');
    }
    if (!vehicle.tenantId && tenantId) {
      await prisma.vehicle.update({
        where: { id: vehicle.id },
        data: { tenantId }
      });
    }

    const baseSlug = slugify(data?.slug || title);
    const existingCount = await prisma.hostVehicleListing.count({
      where: { slug: { startsWith: baseSlug || 'listing' } }
    });
    const slug = existingCount ? `${baseSlug || 'listing'}-${existingCount + 1}` : (baseSlug || `listing-${Date.now()}`);

    return prisma.hostVehicleListing.create({
      data: {
        tenantId,
        hostProfileId,
        vehicleId,
        locationId: data?.locationId || null,
        pickupSpotId: data?.pickupSpotId || null,
        slug,
        title,
        shortDescription: data?.shortDescription ? String(data.shortDescription).trim() : null,
        description: data?.description ? String(data.description).trim() : null,
        status: data?.status ? String(data.status).trim().toUpperCase() : 'DRAFT',
        ownershipType: data?.ownershipType ? String(data.ownershipType).trim().toUpperCase() : 'HOST_OWNED',
        currency: data?.currency ? String(data.currency).trim().toUpperCase() : 'USD',
        fulfillmentMode: data?.fulfillmentMode ? String(data.fulfillmentMode).trim().toUpperCase() : 'PICKUP_ONLY',
        baseDailyRate: data?.baseDailyRate ?? 0,
        cleaningFee: data?.cleaningFee ?? 0,
        deliveryFee: data?.deliveryFee ?? 0,
        deliveryRadiusMiles: data?.deliveryRadiusMiles ? Number(data.deliveryRadiusMiles) : null,
        deliveryNotes: data?.deliveryNotes ? String(data.deliveryNotes).trim() : null,
        securityDeposit: data?.securityDeposit ?? 0,
        instantBook: !!data?.instantBook,
        minTripDays: Number(data?.minTripDays || 1),
        maxTripDays: data?.maxTripDays ? Number(data.maxTripDays) : null,
        tripRules: data?.tripRules ? String(data.tripRules).trim() : null,
        photosJson: data?.photosJson ? String(data.photosJson).trim() : null,
        addOnsJson: data?.addOnsJson ? String(data.addOnsJson).trim() : null,
        publishedAt: String(data?.status || '').trim().toUpperCase() === 'PUBLISHED' ? new Date() : null
      },
      include: listingInclude()
    });
  },

  async createTrip(data, scope = {}) {
    const tenantId = scope?.tenantId || data?.tenantId || null;
    if (!tenantId) throw new Error('tenantId is required');
    await assertTenantCarSharingEnabled(tenantId);
    const listingId = String(data?.listingId || '').trim();
    if (!listingId) throw new Error('listingId is required');
    const pickupAt = data?.scheduledPickupAt ? new Date(data.scheduledPickupAt) : null;
    const returnAt = data?.scheduledReturnAt ? new Date(data.scheduledReturnAt) : null;
    if (!pickupAt || !returnAt || Number.isNaN(pickupAt.getTime()) || Number.isNaN(returnAt.getTime())) {
      throw new Error('scheduledPickupAt and scheduledReturnAt are required');
    }
    if (pickupAt >= returnAt) throw new Error('scheduledReturnAt must be after scheduledPickupAt');

    if (!data?.guestCustomerId) throw new Error('guestCustomerId is required');

    const listing = await prisma.hostVehicleListing.findFirst({
      where: { id: listingId, tenantId },
      include: {
        hostProfile: true,
        vehicle: { select: { vehicleTypeId: true } },
        availabilityWindows: { orderBy: [{ startAt: 'asc' }] }
      }
    });
    if (!listing) throw new Error('Listing not found for this tenant');
    if (String(listing.status || '').toUpperCase() === 'ARCHIVED') throw new Error('Archived listings cannot accept trips');

    const tripDays = ceilTripDays(pickupAt, returnAt);
    if (tripDays < Number(listing.minTripDays || 1)) {
      throw new Error(`Trip must be at least ${listing.minTripDays} day(s)`);
    }
    if (listing.maxTripDays && tripDays > Number(listing.maxTripDays)) {
      throw new Error(`Trip cannot exceed ${listing.maxTripDays} day(s)`);
    }

    const overlappingWindows = (listing.availabilityWindows || []).filter((window) =>
      overlapsWindow(new Date(window.startAt), new Date(window.endAt), pickupAt, returnAt)
    );
    const blockedWindow = overlappingWindows.find((window) => !!window.isBlocked);
    if (blockedWindow) {
      throw new Error('This listing is blocked for the selected dates');
    }
    const minStayViolation = overlappingWindows.find((window) =>
      window.minTripDaysOverride && tripDays < Number(window.minTripDaysOverride)
    );
    if (minStayViolation) {
      throw new Error(`Selected dates require at least ${minStayViolation.minTripDaysOverride} day(s)`);
    }

    const quote = computeTripPricing(listing, overlappingWindows, pickupAt, returnAt);
    const pickupLocationId = data?.pickupLocationId || listing.locationId || null;
    const returnLocationId = data?.returnLocationId || listing.locationId || null;
    if (!pickupLocationId || !returnLocationId) {
      throw new Error('pickupLocationId and returnLocationId are required for trip operations');
    }
    const tripCode = generateTripCode();
    const reservation = await createReservationForTrip({
      tenantId,
      listing,
      guestCustomerId: data.guestCustomerId,
      pickupAt,
      returnAt,
      pickupLocationId,
      returnLocationId,
      quote,
      tripCode,
      notes: data?.notes ? String(data.notes).trim() : null
    });
    const trip = await prisma.trip.create({
      data: {
        tenantId,
        listingId: listing.id,
        reservationId: reservation.id,
        hostProfileId: listing.hostProfileId,
        guestCustomerId: data?.guestCustomerId || null,
        tripCode,
        status: data?.status ? String(data.status).trim().toUpperCase() : 'RESERVED',
        scheduledPickupAt: pickupAt,
        scheduledReturnAt: returnAt,
        pickupLocationId,
        returnLocationId,
        quotedSubtotal: quote.subtotal,
        quotedTaxes: quote.taxes,
        quotedFees: quote.fees,
        quotedTotal: quote.total,
        hostGrossRevenue: quote.hostGrossRevenue,
        hostServiceFeeRate: quote.hostServiceFeeRate,
        hostServiceFee: quote.hostServiceFee,
        guestTripFee: quote.guestTripFee,
        hostEarnings: quote.hostEarnings,
        platformFee: quote.platformFee,
        platformRevenue: quote.platformRevenue,
        notes: data?.notes ? String(data.notes).trim() : null,
        timelineEvents: {
          create: [{
            eventType: 'TRIP_CREATED',
            actorType: scope?.tenantId ? 'TENANT_USER' : 'SYSTEM',
            actorRefId: data?.actorUserId || null,
            notes: data?.notes ? String(data.notes).trim() : 'Trip created from car sharing console',
            metadata: JSON.stringify({
              listingId: listing.id,
              reservationId: reservation.id,
              guestCustomerId: data?.guestCustomerId || null,
              tripDays: quote.tripDays,
              quotedTotal: quote.total
            })
          }]
        }
      },
      include: tripInclude()
    });
    return trip;
  },

  async updateTripStatus(id, patch, scope = {}) {
    const current = await prisma.trip.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      include: { listing: { select: { tenantId: true } } }
    });
    if (!current) throw new Error('Trip not found');
    await assertTenantCarSharingEnabled(current.tenantId);
    const nextStatus = String(patch?.status || '').trim().toUpperCase();
    if (!nextStatus) throw new Error('status is required');
    const allowed = TRIP_STATUS_TRANSITIONS[String(current.status || '').toUpperCase()] || [];
    if (!allowed.includes(nextStatus)) {
      throw new Error(`Cannot move trip from ${current.status} to ${nextStatus}`);
    }
    const now = new Date();
    const updatedTrip = await prisma.trip.update({
      where: { id },
      data: {
        status: nextStatus,
        actualPickupAt: nextStatus === 'IN_PROGRESS' ? (current.actualPickupAt || now) : undefined,
        actualReturnAt: nextStatus === 'COMPLETED' ? (current.actualReturnAt || now) : undefined,
        timelineEvents: {
          create: [{
            eventType: `TRIP_${nextStatus}`,
            actorType: patch?.actorUserId ? 'TENANT_USER' : 'SYSTEM',
            actorRefId: patch?.actorUserId || null,
            notes: patch?.note ? String(patch.note).trim() : `Trip moved to ${nextStatus}`,
            metadata: JSON.stringify({
              previousStatus: current.status,
              nextStatus
            })
          }]
        }
      },
      include: tripInclude()
    });
    if (nextStatus === 'COMPLETED') {
      try {
        await hostReviewsService.issueGuestReviewRequestForTrip(updatedTrip.id);
      } catch (error) {
        console.error('Unable to issue host review request', error);
      }
    }
    return updatedTrip;
  },

  async ensureTripWorkflow(id, scope = {}) {
    return ensureReservationForTrip(id, scope);
  },

  async updateListing(id, patch, scope = {}) {
    const current = await prisma.hostVehicleListing.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true, status: true, tenantId: true }
    });
    if (!current) throw new Error('Listing not found');
    await assertTenantCarSharingEnabled(current.tenantId);

    const nextStatus = Object.prototype.hasOwnProperty.call(patch || {}, 'status')
      ? String(patch?.status || current.status).trim().toUpperCase()
      : current.status;

    if (Object.prototype.hasOwnProperty.call(patch || {}, 'vehicleId') && patch?.vehicleId) {
      const vehicle = await prisma.vehicle.findFirst({
        where: {
          id: String(patch.vehicleId),
          ...(scope?.allowUnassigned
            ? { OR: [{ tenantId: current.tenantId || undefined }, { tenantId: null }] }
            : { tenantId: current.tenantId || undefined })
        },
        select: { id: true, tenantId: true, fleetMode: true }
      });
      if (!vehicle) throw new Error('Vehicle not found for this tenant');
      if (!['CAR_SHARING_ONLY', 'BOTH'].includes(String(vehicle.fleetMode || 'RENTAL_ONLY'))) {
        throw new Error('Vehicle must be marked for car sharing before it can be listed');
      }
      if (!vehicle.tenantId && current.tenantId) {
        await prisma.vehicle.update({
          where: { id: vehicle.id },
          data: { tenantId: current.tenantId }
        });
      }
    }

    return prisma.hostVehicleListing.update({
      where: { id },
      data: {
        hostProfileId: Object.prototype.hasOwnProperty.call(patch || {}, 'hostProfileId') ? String(patch?.hostProfileId || '') : undefined,
        vehicleId: Object.prototype.hasOwnProperty.call(patch || {}, 'vehicleId') ? String(patch?.vehicleId || '') : undefined,
        locationId: Object.prototype.hasOwnProperty.call(patch || {}, 'locationId') ? (patch?.locationId || null) : undefined,
        pickupSpotId: Object.prototype.hasOwnProperty.call(patch || {}, 'pickupSpotId') ? (patch?.pickupSpotId || null) : undefined,
        title: Object.prototype.hasOwnProperty.call(patch || {}, 'title') ? String(patch?.title || '').trim() : undefined,
        shortDescription: Object.prototype.hasOwnProperty.call(patch || {}, 'shortDescription') ? (patch?.shortDescription ? String(patch.shortDescription).trim() : null) : undefined,
        description: Object.prototype.hasOwnProperty.call(patch || {}, 'description') ? (patch?.description ? String(patch.description).trim() : null) : undefined,
        status: nextStatus,
        ownershipType: Object.prototype.hasOwnProperty.call(patch || {}, 'ownershipType') ? String(patch?.ownershipType || 'HOST_OWNED').trim().toUpperCase() : undefined,
        currency: Object.prototype.hasOwnProperty.call(patch || {}, 'currency') ? String(patch?.currency || 'USD').trim().toUpperCase() : undefined,
        fulfillmentMode: Object.prototype.hasOwnProperty.call(patch || {}, 'fulfillmentMode') ? String(patch?.fulfillmentMode || 'PICKUP_ONLY').trim().toUpperCase() : undefined,
        baseDailyRate: Object.prototype.hasOwnProperty.call(patch || {}, 'baseDailyRate') ? patch?.baseDailyRate ?? 0 : undefined,
        cleaningFee: Object.prototype.hasOwnProperty.call(patch || {}, 'cleaningFee') ? patch?.cleaningFee ?? 0 : undefined,
        deliveryFee: Object.prototype.hasOwnProperty.call(patch || {}, 'deliveryFee') ? patch?.deliveryFee ?? 0 : undefined,
        deliveryRadiusMiles: Object.prototype.hasOwnProperty.call(patch || {}, 'deliveryRadiusMiles') ? (patch?.deliveryRadiusMiles ? Number(patch.deliveryRadiusMiles) : null) : undefined,
        deliveryNotes: Object.prototype.hasOwnProperty.call(patch || {}, 'deliveryNotes') ? (patch?.deliveryNotes ? String(patch.deliveryNotes).trim() : null) : undefined,
        securityDeposit: Object.prototype.hasOwnProperty.call(patch || {}, 'securityDeposit') ? patch?.securityDeposit ?? 0 : undefined,
        instantBook: Object.prototype.hasOwnProperty.call(patch || {}, 'instantBook') ? !!patch?.instantBook : undefined,
        minTripDays: Object.prototype.hasOwnProperty.call(patch || {}, 'minTripDays') ? Number(patch?.minTripDays || 1) : undefined,
        maxTripDays: Object.prototype.hasOwnProperty.call(patch || {}, 'maxTripDays') ? (patch?.maxTripDays ? Number(patch.maxTripDays) : null) : undefined,
        tripRules: Object.prototype.hasOwnProperty.call(patch || {}, 'tripRules') ? (patch?.tripRules ? String(patch.tripRules).trim() : null) : undefined,
        photosJson: Object.prototype.hasOwnProperty.call(patch || {}, 'photosJson') ? (patch?.photosJson ? String(patch.photosJson).trim() : null) : undefined,
        addOnsJson: Object.prototype.hasOwnProperty.call(patch || {}, 'addOnsJson') ? (patch?.addOnsJson ? String(patch.addOnsJson).trim() : null) : undefined,
        publishedAt: nextStatus === 'PUBLISHED'
          ? new Date()
          : nextStatus === 'DRAFT' || nextStatus === 'ARCHIVED'
            ? null
            : undefined,
        pausedAt: nextStatus === 'PAUSED'
          ? new Date()
          : nextStatus === 'PUBLISHED'
            ? null
            : undefined
      },
      include: listingInclude()
    });
  }
};
