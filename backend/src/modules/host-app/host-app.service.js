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

function submissionInclude() {
  return {
    vehicleType: true,
    preferredLocation: true,
    vehicle: { include: { vehicleType: true, homeLocation: true } },
    listing: { include: listingInclude() },
    communications: { orderBy: [{ createdAt: 'desc' }] }
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
    hostReview: true,
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

async function resolveHostTenantId(hostProfile) {
  const directTenantId = hostProfile?.tenantId || hostProfile?.tenant?.id || hostProfile?.user?.tenantId || null;
  if (directTenantId) return directTenantId;

  const [listing, submission] = await Promise.all([
    prisma.hostVehicleListing.findFirst({
      where: { hostProfileId: hostProfile?.id || '__never__' },
      select: { tenantId: true },
      orderBy: [{ createdAt: 'desc' }]
    }),
    prisma.hostVehicleSubmission.findFirst({
      where: { hostProfileId: hostProfile?.id || '__never__' },
      select: { tenantId: true },
      orderBy: [{ createdAt: 'desc' }]
    })
  ]);

  return listing?.tenantId || submission?.tenantId || null;
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
    projectedEarnings: Number(projectedEarnings.toFixed(2)),
    pendingVehicleApprovals: 0
  };
}

function generateHostVehicleNumber() {
  return `HOST-${Date.now().toString().slice(-8)}`;
}

function parseJsonList(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function createHostVehicleSubmissionForProfile({ hostProfileId, tenantId, payload = {} }) {
  const scopedTenantId = String(tenantId || '').trim();
  const scopedHostProfileId = String(hostProfileId || '').trim();
  if (!scopedTenantId) throw new Error('Host tenant is required');
  if (!scopedHostProfileId) throw new Error('hostProfileId is required');

  const vehicleTypeId = String(payload?.vehicleTypeId || '').trim();
  const preferredLocationId = payload?.preferredLocationId ? String(payload.preferredLocationId).trim() : null;
  if (!vehicleTypeId) throw new Error('vehicleTypeId is required');

  const vehicleType = await prisma.vehicleType.findFirst({
    where: { id: vehicleTypeId, tenantId: scopedTenantId }
  });
  if (!vehicleType) throw new Error('Vehicle type not found');

  const location = preferredLocationId
    ? await prisma.location.findFirst({
        where: { id: preferredLocationId, tenantId: scopedTenantId, isActive: true }
      })
    : null;
  if (preferredLocationId && !location) throw new Error('Preferred location not found');

  const photosJson = payload?.photosJson ? String(payload.photosJson).trim() : null;
  const addOnsJson = payload?.addOnsJson ? String(payload.addOnsJson).trim() : null;
  const photos = parseJsonList(photosJson).map((row) => String(row || '').trim()).filter(Boolean).slice(0, 6);

  if (!payload?.year || !payload?.make || !payload?.model) {
    throw new Error('year, make, and model are required');
  }
  if (!photos.length) throw new Error('At least one vehicle photo is required');
  if (!payload?.insuranceDocumentUrl) throw new Error('Insurance document is required');
  if (!payload?.registrationDocumentUrl) throw new Error('Registration document is required');
  if (!payload?.initialInspectionDocumentUrl) throw new Error('Initial inspection document is required');

  return prisma.hostVehicleSubmission.create({
    data: {
      tenantId: scopedTenantId,
      hostProfileId: scopedHostProfileId,
      vehicleTypeId,
      preferredLocationId,
      year: payload?.year ? Number(payload.year) : null,
      make: payload?.make ? String(payload.make).trim() : null,
      model: payload?.model ? String(payload.model).trim() : null,
      color: payload?.color ? String(payload.color).trim() : null,
      vin: payload?.vin ? String(payload.vin).trim() : null,
      plate: payload?.plate ? String(payload.plate).trim() : null,
      mileage: payload?.mileage ? Number(payload.mileage) : 0,
      baseDailyRate: payload?.baseDailyRate ? Number(payload.baseDailyRate) : 0,
      cleaningFee: payload?.cleaningFee ? Number(payload.cleaningFee) : 0,
      deliveryFee: payload?.deliveryFee ? Number(payload.deliveryFee) : 0,
      securityDeposit: payload?.securityDeposit ? Number(payload.securityDeposit) : 0,
      minTripDays: payload?.minTripDays ? Number(payload.minTripDays) : 1,
      maxTripDays: payload?.maxTripDays ? Number(payload.maxTripDays) : null,
      shortDescription: payload?.shortDescription ? String(payload.shortDescription).trim() : null,
      description: payload?.description ? String(payload.description).trim() : null,
      tripRules: payload?.tripRules ? String(payload.tripRules).trim() : null,
      photosJson: JSON.stringify(photos),
      insuranceDocumentUrl: payload?.insuranceDocumentUrl ? String(payload.insuranceDocumentUrl).trim() : null,
      registrationDocumentUrl: payload?.registrationDocumentUrl ? String(payload.registrationDocumentUrl).trim() : null,
      initialInspectionDocumentUrl: payload?.initialInspectionDocumentUrl ? String(payload.initialInspectionDocumentUrl).trim() : null,
      initialInspectionNotes: payload?.initialInspectionNotes ? String(payload.initialInspectionNotes).trim() : null,
      addOnsJson,
      status: 'PENDING_REVIEW'
    },
    include: submissionInclude()
  });
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

    const hostTenantId = await resolveHostTenantId(context.hostProfile);

    const [vehicleTypes, locations, submissions] = await Promise.all([
      prisma.vehicleType.findMany({
        where: hostTenantId ? { tenantId: hostTenantId } : { id: '__never__' },
        orderBy: [{ name: 'asc' }]
      }),
      prisma.location.findMany({
        where: hostTenantId ? { tenantId: hostTenantId, isActive: true } : { id: '__never__' },
        orderBy: [{ name: 'asc' }]
      }),
      prisma.hostVehicleSubmission.findMany({
        where: { hostProfileId: context.hostProfile.id },
        include: submissionInclude(),
        orderBy: [{ createdAt: 'desc' }]
      })
    ]);

    const recentReviews = await prisma.hostReview.findMany({
      where: {
        hostProfileId: context.hostProfile.id,
        status: 'SUBMITTED'
      },
      orderBy: [{ submittedAt: 'desc' }],
      take: 6
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
        averageRating: Number(context.hostProfile.averageRating || 0),
        reviewCount: Number(context.hostProfile.reviewCount || 0),
        latestReviewAt: context.hostProfile.latestReviewAt || null,
        resolvedTenantId: hostTenantId,
        tenant: context.hostProfile.tenant
          ? {
              id: context.hostProfile.tenant.id,
              name: context.hostProfile.tenant.name
            }
          : null
      },
      listings,
      trips,
      recentReviews: recentReviews.map((review) => ({
        id: review.id,
        rating: review.rating == null ? null : Number(review.rating),
        comments: review.comments || '',
        reviewerName: review.reviewerName || '',
        submittedAt: review.submittedAt || null
      })),
      vehicleTypes,
      locations,
      vehicleSubmissions: submissions,
      metrics: {
        ...hostMetrics(listings, trips),
        pendingVehicleApprovals: submissions.filter((row) => ['PENDING_REVIEW', 'PENDING_INFO'].includes(String(row.status || '').toUpperCase())).length
      }
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
      tripRules: Object.prototype.hasOwnProperty.call(payload, 'tripRules') ? payload.tripRules : undefined,
      photosJson: Object.prototype.hasOwnProperty.call(payload, 'photosJson') ? payload.photosJson : undefined,
      addOnsJson: Object.prototype.hasOwnProperty.call(payload, 'addOnsJson') ? payload.addOnsJson : undefined
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
  },

  async createVehicleSubmission(user, payload = {}) {
    const requestedHostProfileId = payload?.hostProfileId ? String(payload.hostProfileId).trim() : null;
    const context = await resolveHostContext(user, requestedHostProfileId || null);
    if (!context.hostProfile) throw new Error('No host profile is linked to this login yet');

    const tenantId = await resolveHostTenantId(context.hostProfile);
    if (!tenantId) throw new Error('Host tenant is required');

    return createHostVehicleSubmissionForProfile({
      hostProfileId: context.hostProfile.id,
      tenantId,
      payload
    });
  },

  async approveVehicleSubmission(user, id, payload = {}) {
    const role = String(user?.role || '').toUpperCase();
    if (!['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role)) throw new Error('Not allowed');

    const tenantFilter = role === 'SUPER_ADMIN' ? {} : { tenantId: user?.tenantId || '__never__' };
    const submission = await prisma.hostVehicleSubmission.findFirst({
      where: { id, ...tenantFilter },
      include: submissionInclude()
    });
    if (!submission) throw new Error('Vehicle submission not found');
    if (submission.vehicleId && submission.listingId) return submission;

    const internalNumber = generateHostVehicleNumber();
    const vehicle = await prisma.vehicle.create({
      data: {
        tenantId: submission.tenantId,
        internalNumber,
        vin: submission.vin || null,
        plate: submission.plate || null,
        make: submission.make || null,
        model: submission.model || null,
        year: submission.year || null,
        color: submission.color || null,
        mileage: submission.mileage || 0,
        status: 'AVAILABLE',
        fleetMode: 'CAR_SHARING_ONLY',
        vehicleTypeId: submission.vehicleTypeId,
        homeLocationId: submission.preferredLocationId || null
      }
    });

    const listing = await carSharingService.createListing({
      tenantId: submission.tenantId,
      hostProfileId: submission.hostProfileId,
      vehicleId: vehicle.id,
      locationId: submission.preferredLocationId || null,
      title: `${submission.year || ''} ${submission.make || ''} ${submission.model || ''}`.trim() || `${submission.hostProfile.displayName}'s Vehicle`,
      shortDescription: submission.shortDescription || null,
      description: submission.description || null,
      status: 'PUBLISHED',
      ownershipType: 'HOST_OWNED',
      baseDailyRate: Number(submission.baseDailyRate || 0),
      cleaningFee: Number(submission.cleaningFee || 0),
      deliveryFee: Number(submission.deliveryFee || 0),
      securityDeposit: Number(submission.securityDeposit || 0),
      instantBook: false,
      minTripDays: Number(submission.minTripDays || 1),
      maxTripDays: submission.maxTripDays || null,
      tripRules: submission.tripRules || null,
      photosJson: submission.photosJson || null,
      addOnsJson: submission.addOnsJson || null
    }, {
      tenantId: submission.tenantId || undefined
    });

    const updated = await prisma.hostVehicleSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'APPROVED',
        reviewNotes: payload?.reviewNotes ? String(payload.reviewNotes).trim() : submission.reviewNotes,
        approvedAt: new Date(),
        approvedByUserId: user?.id || user?.sub || null,
        vehicleId: vehicle.id,
        listingId: listing.id
      },
      include: submissionInclude()
    });

    await issueCenterService.notifyHostVehicleSubmissionApproved(updated);
    return updated;
  }
};
