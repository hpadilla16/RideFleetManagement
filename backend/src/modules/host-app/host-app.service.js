import { prisma } from '../../lib/prisma.js';
import { carSharingService } from '../car-sharing/car-sharing.service.js';
import { issueCenterService } from '../issue-center/issue-center.service.js';

function listingInclude() {
  return {
    vehicle: { include: { vehicleType: true } },
    location: true,
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
        location: true
      }
    },
    guestCustomer: true,
    reservation: {
      include: {
        pricingSnapshot: true,
        rentalAgreement: true
      }
    },
    incidents: {
      orderBy: [{ createdAt: 'desc' }],
      take: 5
    },
    pickupLocation: true,
    returnLocation: true,
    timelineEvents: { orderBy: [{ eventAt: 'desc' }], take: 10 }
  };
}

function isAdminViewer(user) {
  return ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(String(user?.role || '').toUpperCase());
}

async function resolveHostContext(user, requestedHostProfileId) {
  if (isAdminViewer(user)) {
    const tenantFilter = String(user?.role || '').toUpperCase() === 'SUPER_ADMIN'
      ? {}
      : (user?.tenantId ? { tenantId: user.tenantId } : { id: '__never__' });

    const availableHosts = await prisma.hostProfile.findMany({
      where: tenantFilter,
      orderBy: [{ displayName: 'asc' }],
      select: {
        id: true,
        tenantId: true,
        displayName: true,
        status: true
      }
    });

    if (!requestedHostProfileId) {
      return {
        adminViewer: true,
        hostProfile: null,
        availableHosts
      };
    }

    const hostProfile = await prisma.hostProfile.findFirst({
      where: {
        id: requestedHostProfileId,
        ...tenantFilter
      },
      include: {
        tenant: true,
        user: true
      }
    });
    if (!hostProfile) throw new Error('Host profile not found');
    return {
      adminViewer: true,
      hostProfile,
      availableHosts
    };
  }

  const hostProfile = await prisma.hostProfile.findFirst({
    where: {
      userId: user?.id || user?.sub || null
    },
    include: {
      tenant: true,
      user: true
    }
  });
  if (!hostProfile) throw new Error('No host profile is linked to this login yet');
  return {
    adminViewer: false,
    hostProfile,
    availableHosts: []
  };
}

function hostMetrics(listings, trips) {
  const activeListings = listings.filter((row) => String(row.status || '').toUpperCase() === 'PUBLISHED').length;
  const instantBookListings = listings.filter((row) => !!row.instantBook).length;
  const activeTrips = trips.filter((row) => ['RESERVED', 'CONFIRMED', 'READY_FOR_PICKUP', 'IN_PROGRESS'].includes(String(row.status || '').toUpperCase())).length;
  const projectedEarnings = trips
    .filter((row) => !['CANCELLED', 'DISPUTED'].includes(String(row.status || '').toUpperCase()))
    .reduce((sum, row) => sum + Number(row.hostEarnings || 0), 0);

  return {
    listings: listings.length,
    activeListings,
    instantBookListings,
    trips: trips.length,
    activeTrips,
    projectedEarnings: Number(projectedEarnings.toFixed(2))
  };
}

export const hostAppService = {
  async getAccess(user) {
    try {
      const context = await resolveHostContext(user, null);
      return {
        enabled: true,
        isAdminViewer: !!context.adminViewer,
        hostProfileId: context.hostProfile?.id || null,
        hostDisplayName: context.hostProfile?.displayName || null,
        availableHosts: context.availableHosts || []
      };
    } catch {
      return {
        enabled: isAdminViewer(user),
        isAdminViewer: isAdminViewer(user),
        hostProfileId: null,
        hostDisplayName: null,
        availableHosts: []
      };
    }
  },

  async getDashboard(user, input = {}) {
    const requestedHostProfileId = input?.hostProfileId ? String(input.hostProfileId) : '';
    const context = await resolveHostContext(user, requestedHostProfileId || null);

    if (!context.hostProfile) {
      return {
        isAdminViewer: !!context.adminViewer,
        availableHosts: context.availableHosts,
        hostProfile: null,
        listings: [],
        trips: [],
        metrics: hostMetrics([], [])
      };
    }

    const listings = await prisma.hostVehicleListing.findMany({
      where: { hostProfileId: context.hostProfile.id },
      include: listingInclude(),
      orderBy: [{ createdAt: 'desc' }]
    });

    const trips = await prisma.trip.findMany({
      where: {
        hostProfileId: context.hostProfile.id,
        ...(input?.tripStatus ? { status: String(input.tripStatus).toUpperCase() } : {})
      },
      include: tripInclude(),
      orderBy: [{ createdAt: 'desc' }]
    });

    return {
      isAdminViewer: !!context.adminViewer,
      availableHosts: context.availableHosts,
      hostProfile: {
        id: context.hostProfile.id,
        displayName: context.hostProfile.displayName,
        legalName: context.hostProfile.legalName || '',
        email: context.hostProfile.email || '',
        phone: context.hostProfile.phone || '',
        status: context.hostProfile.status || 'ACTIVE',
        payoutProvider: context.hostProfile.payoutProvider || '',
        payoutAccountRef: context.hostProfile.payoutAccountRef || '',
        payoutEnabled: !!context.hostProfile.payoutEnabled,
        tenant: context.hostProfile.tenant
          ? {
              id: context.hostProfile.tenant.id,
              name: context.hostProfile.tenant.name
            }
          : null
      },
      listings,
      trips,
      metrics: hostMetrics(listings, trips)
    };
  },

  async listAvailability(user, listingId) {
    const context = await resolveHostContext(user, null);
    const listing = await prisma.hostVehicleListing.findFirst({
      where: {
        id: listingId,
        ...(context.hostProfile ? { hostProfileId: context.hostProfile.id } : {})
      },
      select: { id: true, tenantId: true }
    });
    if (!listing) throw new Error('Listing not found for this host');
    return carSharingService.listAvailabilityWindows(listingId, {
      tenantId: listing.tenantId || undefined
    });
  },

  async createAvailability(user, listingId, payload = {}) {
    const context = await resolveHostContext(user, null);
    const listing = await prisma.hostVehicleListing.findFirst({
      where: {
        id: listingId,
        ...(context.hostProfile ? { hostProfileId: context.hostProfile.id } : {})
      },
      select: { id: true, tenantId: true }
    });
    if (!listing) throw new Error('Listing not found for this host');
    return carSharingService.createAvailabilityWindow(listingId, payload, {
      tenantId: listing.tenantId || undefined
    });
  },

  async updateAvailability(user, id, payload = {}) {
    const context = await resolveHostContext(user, null);
    const current = await prisma.listingAvailabilityWindow.findFirst({
      where: {
        id,
        ...(context.hostProfile ? { listing: { hostProfileId: context.hostProfile.id } } : {})
      },
      select: {
        id: true,
        listing: { select: { tenantId: true } }
      }
    });
    if (!current) throw new Error('Availability window not found for this host');
    return carSharingService.updateAvailabilityWindow(id, payload, {
      tenantId: current.listing?.tenantId || undefined
    });
  },

  async deleteAvailability(user, id) {
    const context = await resolveHostContext(user, null);
    const current = await prisma.listingAvailabilityWindow.findFirst({
      where: {
        id,
        ...(context.hostProfile ? { listing: { hostProfileId: context.hostProfile.id } } : {})
      },
      select: {
        id: true,
        listing: { select: { tenantId: true } }
      }
    });
    if (!current) throw new Error('Availability window not found for this host');
    return carSharingService.deleteAvailabilityWindow(id, {
      tenantId: current.listing?.tenantId || undefined
    });
  },

  async updateListing(user, id, payload = {}) {
    const context = await resolveHostContext(user, null);
    const listing = await prisma.hostVehicleListing.findFirst({
      where: {
        id,
        ...(context.hostProfile ? { hostProfileId: context.hostProfile.id } : {})
      },
      select: {
        id: true,
        tenantId: true,
        hostProfileId: true
      }
    });
    if (!listing) throw new Error('Listing not found for this host');

    const allowedPatch = {
      shortDescription: Object.prototype.hasOwnProperty.call(payload, 'shortDescription') ? payload.shortDescription : undefined,
      description: Object.prototype.hasOwnProperty.call(payload, 'description') ? payload.description : undefined,
      status: Object.prototype.hasOwnProperty.call(payload, 'status') ? payload.status : undefined,
      baseDailyRate: Object.prototype.hasOwnProperty.call(payload, 'baseDailyRate') ? payload.baseDailyRate : undefined,
      cleaningFee: Object.prototype.hasOwnProperty.call(payload, 'cleaningFee') ? payload.cleaningFee : undefined,
      deliveryFee: Object.prototype.hasOwnProperty.call(payload, 'deliveryFee') ? payload.deliveryFee : undefined,
      securityDeposit: Object.prototype.hasOwnProperty.call(payload, 'securityDeposit') ? payload.securityDeposit : undefined,
      instantBook: Object.prototype.hasOwnProperty.call(payload, 'instantBook') ? payload.instantBook : undefined,
      minTripDays: Object.prototype.hasOwnProperty.call(payload, 'minTripDays') ? payload.minTripDays : undefined,
      maxTripDays: Object.prototype.hasOwnProperty.call(payload, 'maxTripDays') ? payload.maxTripDays : undefined,
      tripRules: Object.prototype.hasOwnProperty.call(payload, 'tripRules') ? payload.tripRules : undefined
    };

    return carSharingService.updateListing(id, allowedPatch, {
      tenantId: listing.tenantId || undefined
    });
  },

  async updateTripStatus(user, id, payload = {}) {
    const context = await resolveHostContext(user, null);
    const trip = await prisma.trip.findFirst({
      where: {
        id,
        ...(context.hostProfile ? { hostProfileId: context.hostProfile.id } : {})
      },
      select: {
        id: true,
        tenantId: true,
        hostProfileId: true
      }
    });
    if (!trip) throw new Error('Trip not found for this host');

    return carSharingService.updateTripStatus(id, {
      status: payload?.status,
      note: payload?.note || null,
      actorUserId: user?.id || user?.sub || null
    }, {
      tenantId: trip.tenantId || undefined,
      actorUserId: user?.id || user?.sub || null
    });
  },

  async createTripIncident(user, id, payload = {}) {
    return issueCenterService.createIncidentForHost(user, id, payload);
  }
};
