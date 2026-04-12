import { prisma } from '../../lib/prisma.js';
import { carSharingService } from '../car-sharing/car-sharing.service.js';
import { serializePublicTripFulfillmentPlan } from '../car-sharing/car-sharing-handoff.js';
import { issueCenterService } from '../issue-center/issue-center.service.js';
import { settingsService } from '../settings/settings.service.js';
import { assertTenantVehicleCapacity } from '../../lib/tenant-plan-limits.js';

function listingInclude() {
  return {
    vehicle: { include: { vehicleType: true } },
    location: true,
    pickupSpot: {
      include: {
        anchorLocation: true,
        searchPlace: {
          include: {
            anchorLocation: true
          }
        }
      }
    },
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
    preferredPickupSpot: {
      include: {
        anchorLocation: true
      }
    },
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
        location: true,
        pickupSpot: {
          include: {
            anchorLocation: true,
            searchPlace: {
              include: {
                anchorLocation: true
              }
            }
          }
        }
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
    fulfillmentPlan: {
      include: {
        searchPlace: {
          include: {
            anchorLocation: true
          }
        },
        pickupSpot: {
          include: {
            anchorLocation: true,
            searchPlace: {
              include: {
                anchorLocation: true
              }
            }
          }
        },
        serviceArea: {
          include: {
            searchPlace: {
              include: {
                anchorLocation: true
              }
            }
          }
        }
      }
    },
    timelineEvents: { orderBy: [{ eventAt: 'desc' }], take: 10 }
  };
}

function isAdminViewer(user) {
  return ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(String(user?.role || '').toUpperCase());
}

function enrichHostTripFulfillmentPlan(trip, selfServiceConfig = {}) {
  if (!trip?.fulfillmentPlan) return trip;
  const derived = serializePublicTripFulfillmentPlan(trip.fulfillmentPlan, {
    pickupAt: trip?.reservation?.pickupAt || null,
    selfServiceConfig,
    serializeSearchPlace: (value) => value,
    serializePickupSpot: (value) => value,
    serializeServiceAreaSearchPlace: (value) => value
  });
  return {
    ...trip,
    fulfillmentPlan: {
      ...trip.fulfillmentPlan,
      ...(derived || {})
    }
  };
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

function parseTextList(value) {
  if (Array.isArray(value)) {
    return value
      .map((row) => String(row || '').trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  if (!value) return [];
  return String(value)
    .split(/\r?\n|,/)
    .map((row) => row.trim())
    .filter(Boolean)
    .slice(0, 12);
}

async function syncPickupSpotSearchPlace(spot) {
  if (!spot?.id || !spot?.tenantId || !spot?.hostProfileId) return null;
  const searchable = !!spot.isActive;
  const isApproved = String(spot.approvalStatus || '').toUpperCase() === 'APPROVED';
  const values = {
    tenantId: spot.tenantId,
    hostProfileId: spot.hostProfileId,
    anchorLocationId: spot.anchorLocationId || null,
    placeType: 'HOST_PICKUP_SPOT',
    label: spot.label,
    publicLabel: spot.label,
    city: spot.city || null,
    state: spot.state || null,
    postalCode: spot.postalCode || null,
    country: spot.country || null,
    latitude: spot.latitude ?? null,
    longitude: spot.longitude ?? null,
    searchable,
    isActive: !!spot.isActive,
    approvalStatus: isApproved ? 'APPROVED' : 'PENDING',
    visibilityMode: isApproved ? 'REVEAL_AFTER_BOOKING' : 'APPROXIMATE_ONLY',
    deliveryEligible: false,
    pickupEligible: true
  };

  return prisma.carSharingSearchPlace.upsert({
    where: { hostPickupSpotId: spot.id },
    create: {
      hostPickupSpotId: spot.id,
      ...values
    },
    update: values,
    include: {
      anchorLocation: true,
      hostPickupSpot: {
        include: {
          anchorLocation: true
        }
      }
    }
  });
}

async function syncListingServiceAreas({ listingId, tenantId, hostProfileId }) {
  if (!listingId || !tenantId || !hostProfileId) return [];
  const listing = await prisma.hostVehicleListing.findFirst({
    where: { id: listingId, tenantId, hostProfileId },
    include: {
      location: true,
      pickupSpot: {
        include: {
          anchorLocation: true,
          searchPlace: {
            include: {
              anchorLocation: true
            }
          }
        }
      },
      serviceAreas: true
    }
  });
  if (!listing) throw new Error('Listing not found for discovery sync');

  if (listing.pickupSpot) {
    await syncPickupSpotSearchPlace({
      ...listing.pickupSpot,
      tenantId,
      hostProfileId
    });
  }

  const freshPickupSpot = listing.pickupSpot?.id
    ? await prisma.hostPickupSpot.findUnique({
        where: { id: listing.pickupSpot.id },
        include: {
          anchorLocation: true,
          searchPlace: {
            include: {
              anchorLocation: true
            }
          }
        }
      })
    : null;

  const keepServiceAreaIds = new Set();
  const listingMode = String(listing.fulfillmentMode || 'PICKUP_ONLY').toUpperCase();
  const deliveryLabels = parseTextList(listing.deliveryAreasJson);

  if (listingMode !== 'DELIVERY_ONLY' && freshPickupSpot?.searchPlace?.id) {
    const existingPickupArea = (listing.serviceAreas || []).find((row) =>
      String(row.serviceType || '').toUpperCase() === 'PICKUP' && String(row.searchPlaceId || '') === String(freshPickupSpot.searchPlace.id)
    );
    const pickupArea = existingPickupArea
      ? await prisma.hostServiceArea.update({
          where: { id: existingPickupArea.id },
          data: {
            searchPlaceId: freshPickupSpot.searchPlace.id,
            isActive: true
          }
        })
      : await prisma.hostServiceArea.create({
          data: {
            tenantId,
            hostProfileId,
            listingId: listing.id,
            searchPlaceId: freshPickupSpot.searchPlace.id,
            serviceType: 'PICKUP',
            isActive: true
          }
        });
    if (pickupArea?.id) keepServiceAreaIds.add(pickupArea.id);
  }

  if (listingMode !== 'PICKUP_ONLY') {
    for (const areaLabel of deliveryLabels) {
      let searchPlace = await prisma.carSharingSearchPlace.findFirst({
        where: {
          tenantId,
          hostProfileId,
          placeType: 'DELIVERY_ZONE',
          anchorLocationId: listing.locationId || freshPickupSpot?.anchorLocationId || null,
          OR: [
            { label: { equals: areaLabel, mode: 'insensitive' } },
            { publicLabel: { equals: areaLabel, mode: 'insensitive' } }
          ]
        }
      });

      if (!searchPlace) {
        searchPlace = await prisma.carSharingSearchPlace.create({
          data: {
            tenantId,
            hostProfileId,
            anchorLocationId: listing.locationId || freshPickupSpot?.anchorLocationId || null,
            placeType: 'DELIVERY_ZONE',
            label: areaLabel,
            publicLabel: areaLabel,
            city: listing.location?.city || freshPickupSpot?.city || null,
            state: listing.location?.state || freshPickupSpot?.state || null,
            searchable: true,
            isActive: true,
            approvalStatus: 'PENDING',
            visibilityMode: 'APPROXIMATE_ONLY',
            deliveryEligible: true,
            pickupEligible: false
          }
        });
      }

      const existingArea = (listing.serviceAreas || []).find((row) =>
        String(row.serviceType || '').toUpperCase() === 'DELIVERY'
        && String(row.searchPlaceId || '') === String(searchPlace.id)
      );
      const deliveryArea = existingArea
        ? await prisma.hostServiceArea.update({
            where: { id: existingArea.id },
            data: {
              searchPlaceId: searchPlace.id,
              isActive: true
            }
          })
        : await prisma.hostServiceArea.create({
            data: {
              tenantId,
              hostProfileId,
              listingId: listing.id,
              searchPlaceId: searchPlace.id,
              serviceType: 'DELIVERY',
              isActive: true
            }
          });
      if (deliveryArea?.id) keepServiceAreaIds.add(deliveryArea.id);
    }
  }

  const staleServiceAreaIds = (listing.serviceAreas || [])
    .map((row) => row.id)
    .filter((id) => !keepServiceAreaIds.has(id));
  if (staleServiceAreaIds.length) {
    await prisma.hostServiceArea.updateMany({
      where: { id: { in: staleServiceAreaIds } },
      data: { isActive: false }
    });
  }

  return prisma.hostServiceArea.findMany({
    where: { listingId: listing.id },
    include: {
      searchPlace: {
        include: {
          anchorLocation: true
        }
      },
      listing: {
        select: {
          id: true,
          title: true
        }
      }
    },
    orderBy: [{ serviceType: 'asc' }, { createdAt: 'asc' }]
  });
}

export async function createHostVehicleSubmissionForProfile({ hostProfileId, tenantId, payload = {} }) {
  const scopedTenantId = String(tenantId || '').trim();
  const scopedHostProfileId = String(hostProfileId || '').trim();
  if (!scopedTenantId) throw new Error('Host tenant is required');
  if (!scopedHostProfileId) throw new Error('hostProfileId is required');

  const vehicleTypeId = String(payload?.vehicleTypeId || '').trim();
  const preferredLocationId = payload?.preferredLocationId ? String(payload.preferredLocationId).trim() : null;
  const preferredPickupSpotId = payload?.preferredPickupSpotId ? String(payload.preferredPickupSpotId).trim() : null;
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

  const pickupSpot = preferredPickupSpotId
    ? await prisma.hostPickupSpot.findFirst({
        where: {
          id: preferredPickupSpotId,
          tenantId: scopedTenantId,
          hostProfileId: scopedHostProfileId,
          isActive: true
        }
      })
    : null;
  if (preferredPickupSpotId && !pickupSpot) throw new Error('Preferred host pickup spot not found');

  const photosJson = payload?.photosJson ? String(payload.photosJson).trim() : null;
  const addOnsJson = payload?.addOnsJson ? String(payload.addOnsJson).trim() : null;
  const deliveryAreas = parseTextList(payload?.deliveryAreas || payload?.deliveryAreasJson || payload?.deliveryAreasText);
  const photos = parseJsonList(photosJson).map((row) => String(row || '').trim()).filter(Boolean).slice(0, 6);

  if (!payload?.year || !payload?.make || !payload?.model) {
    throw new Error('year, make, and model are required');
  }
  if (!photos.length) throw new Error('At least one vehicle photo is required');
  if (!payload?.insuranceDocumentUrl) throw new Error('Insurance document is required');
  if (!payload?.registrationDocumentUrl) throw new Error('Registration document is required');
  // Inspection document is optional — hosts can submit it later

  return prisma.hostVehicleSubmission.create({
    data: {
      tenantId: scopedTenantId,
      hostProfileId: scopedHostProfileId,
      vehicleTypeId,
      preferredLocationId,
      preferredPickupSpotId,
      year: payload?.year ? Number(payload.year) : null,
      make: payload?.make ? String(payload.make).trim() : null,
      model: payload?.model ? String(payload.model).trim() : null,
      color: payload?.color ? String(payload.color).trim() : null,
      vin: payload?.vin ? String(payload.vin).trim() : null,
      plate: payload?.plate ? String(payload.plate).trim() : null,
      mileage: payload?.mileage ? Number(payload.mileage) : 0,
      fulfillmentMode: payload?.fulfillmentMode ? String(payload.fulfillmentMode).trim().toUpperCase() : 'PICKUP_ONLY',
      baseDailyRate: payload?.baseDailyRate ? Number(payload.baseDailyRate) : 0,
      cleaningFee: payload?.cleaningFee ? Number(payload.cleaningFee) : 0,
      pickupFee: payload?.pickupFee ? Number(payload.pickupFee) : 0,
      deliveryFee: payload?.deliveryFee ? Number(payload.deliveryFee) : 0,
      deliveryRadiusMiles: payload?.deliveryRadiusMiles ? Number(payload.deliveryRadiusMiles) : null,
      deliveryAreasJson: deliveryAreas.length ? JSON.stringify(deliveryAreas) : null,
      deliveryNotes: payload?.deliveryNotes ? String(payload.deliveryNotes).trim() : null,
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

    const [vehicleTypes, locations, submissions, pickupSpots, searchPlaces, serviceAreas] = await Promise.all([
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
      }),
      prisma.hostPickupSpot.findMany({
        where: hostTenantId
          ? { tenantId: hostTenantId, hostProfileId: context.hostProfile.id }
          : { id: '__never__' },
        include: {
          anchorLocation: true,
          searchPlace: {
            include: {
              anchorLocation: true
            }
          }
        },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
      }),
      prisma.carSharingSearchPlace.findMany({
        where: hostTenantId
          ? { tenantId: hostTenantId, hostProfileId: context.hostProfile.id }
          : { id: '__never__' },
        include: {
          anchorLocation: true,
          hostPickupSpot: {
            include: {
              anchorLocation: true
            }
          }
        },
        orderBy: [{ createdAt: 'desc' }]
      }),
      prisma.hostServiceArea.findMany({
        where: hostTenantId
          ? { tenantId: hostTenantId, hostProfileId: context.hostProfile.id }
          : { id: '__never__' },
        include: {
          listing: {
            select: {
              id: true,
              title: true
            }
          },
          searchPlace: {
            include: {
              anchorLocation: true
            }
          }
        },
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
    const selfServiceConfig = hostTenantId
      ? await settingsService.getSelfServiceConfig({ tenantId: hostTenantId }).catch(() => null)
      : null;
    const enrichedTrips = trips.map((trip) => enrichHostTripFulfillmentPlan(trip, selfServiceConfig || {}));

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
      trips: enrichedTrips,
      recentReviews: recentReviews.map((review) => ({
        id: review.id,
        rating: review.rating == null ? null : Number(review.rating),
        comments: review.comments || '',
        reviewerName: review.reviewerName || '',
        submittedAt: review.submittedAt || null
      })),
      vehicleTypes,
      locations,
      pickupSpots,
      searchPlaces,
      serviceAreas,
      vehicleSubmissions: submissions,
      metrics: {
        ...hostMetrics(listings, enrichedTrips),
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
      pickupFee: Object.prototype.hasOwnProperty.call(payload, 'pickupFee') ? payload.pickupFee : undefined,
      deliveryFee: Object.prototype.hasOwnProperty.call(payload, 'deliveryFee') ? payload.deliveryFee : undefined,
      fulfillmentMode: Object.prototype.hasOwnProperty.call(payload, 'fulfillmentMode') ? payload.fulfillmentMode : undefined,
      deliveryRadiusMiles: Object.prototype.hasOwnProperty.call(payload, 'deliveryRadiusMiles') ? payload.deliveryRadiusMiles : undefined,
      deliveryAreas: Object.prototype.hasOwnProperty.call(payload, 'deliveryAreas') ? payload.deliveryAreas : undefined,
      deliveryAreasJson: Object.prototype.hasOwnProperty.call(payload, 'deliveryAreasJson') ? payload.deliveryAreasJson : undefined,
      deliveryNotes: Object.prototype.hasOwnProperty.call(payload, 'deliveryNotes') ? payload.deliveryNotes : undefined,
      securityDeposit: Object.prototype.hasOwnProperty.call(payload, 'securityDeposit') ? payload.securityDeposit : undefined,
      instantBook: Object.prototype.hasOwnProperty.call(payload, 'instantBook') ? payload.instantBook : undefined,
      minTripDays: Object.prototype.hasOwnProperty.call(payload, 'minTripDays') ? payload.minTripDays : undefined,
      maxTripDays: Object.prototype.hasOwnProperty.call(payload, 'maxTripDays') ? payload.maxTripDays : undefined,
      tripRules: Object.prototype.hasOwnProperty.call(payload, 'tripRules') ? payload.tripRules : undefined,
      photosJson: Object.prototype.hasOwnProperty.call(payload, 'photosJson') ? payload.photosJson : undefined,
      addOnsJson: Object.prototype.hasOwnProperty.call(payload, 'addOnsJson') ? payload.addOnsJson : undefined
    };

    const updated = await carSharingService.updateListing(id, allowedPatch, {
      tenantId: listing.tenantId || undefined
    });
    await syncListingServiceAreas({
      listingId: listing.id,
      tenantId: listing.tenantId || null,
      hostProfileId: listing.hostProfileId
    });
    return updated;
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

  async updateTripFulfillmentPlan(user, id, payload = {}) {
    const requestedHostProfileId = payload?.hostProfileId ? String(payload.hostProfileId).trim() : null;
    const context = await resolveHostContext(user, requestedHostProfileId || null);
    if (!context.hostProfile) throw new Error('No host profile is linked to this login yet');

    const trip = await prisma.trip.findFirst({
      where: {
        id,
        hostProfileId: context.hostProfile.id
      },
      include: {
        fulfillmentPlan: true
      }
    });
    if (!trip) throw new Error('Trip not found for this host');
    if (!trip.fulfillmentPlan) throw new Error('Trip handoff plan not found');

    const exactAddress1 = Object.prototype.hasOwnProperty.call(payload || {}, 'exactAddress1')
      ? (payload?.exactAddress1 ? String(payload.exactAddress1).trim() : null)
      : undefined;
    const exactAddress2 = Object.prototype.hasOwnProperty.call(payload || {}, 'exactAddress2')
      ? (payload?.exactAddress2 ? String(payload.exactAddress2).trim() : null)
      : undefined;
    const city = Object.prototype.hasOwnProperty.call(payload || {}, 'city')
      ? (payload?.city ? String(payload.city).trim() : null)
      : undefined;
    const state = Object.prototype.hasOwnProperty.call(payload || {}, 'state')
      ? (payload?.state ? String(payload.state).trim() : null)
      : undefined;
    const postalCode = Object.prototype.hasOwnProperty.call(payload || {}, 'postalCode')
      ? (payload?.postalCode ? String(payload.postalCode).trim() : null)
      : undefined;
    const country = Object.prototype.hasOwnProperty.call(payload || {}, 'country')
      ? (payload?.country ? String(payload.country).trim() : null)
      : undefined;
    const instructions = Object.prototype.hasOwnProperty.call(payload || {}, 'instructions')
      ? (payload?.instructions ? String(payload.instructions).trim() : null)
      : undefined;
    const handoffMode = Object.prototype.hasOwnProperty.call(payload || {}, 'handoffMode')
      ? String(payload?.handoffMode || trip.fulfillmentPlan.handoffMode).trim().toUpperCase()
      : undefined;
    const confirmExactDetails = !!payload?.confirmExactDetails;
    const clearConfirmation = !!payload?.clearConfirmation;

    if (handoffMode && !['IN_PERSON', 'LOCKBOX', 'REMOTE_UNLOCK', 'SELF_SERVICE'].includes(handoffMode)) {
      throw new Error('Invalid handoff mode');
    }

    const updated = await prisma.tripFulfillmentPlan.update({
      where: { id: trip.fulfillmentPlan.id },
      data: {
        exactAddress1,
        exactAddress2,
        city,
        state,
        postalCode,
        country,
        instructions,
        handoffMode,
        confirmedAt: confirmExactDetails ? new Date() : (clearConfirmation ? null : undefined)
      }
    });

    await prisma.tripTimelineEvent.create({
      data: {
        tripId: trip.id,
        eventType: confirmExactDetails ? 'TRIP_HANDOFF_CONFIRMED' : 'TRIP_HANDOFF_UPDATED',
        actorType: 'TENANT_USER',
        actorRefId: user?.id || user?.sub || null,
        notes: confirmExactDetails
          ? 'Exact handoff details confirmed for guest release'
          : (clearConfirmation ? 'Exact handoff confirmation cleared' : 'Trip handoff details updated'),
        metadata: JSON.stringify({
          fulfillmentPlanId: updated.id,
          handoffMode: updated.handoffMode,
          confirmedAt: updated.confirmedAt,
          pickupRevealMode: updated.pickupRevealMode
        })
      }
    });

    const updatedTrip = await prisma.trip.findUnique({
      where: { id: trip.id },
      include: tripInclude()
    });
    const hostTenantId = await resolveHostTenantId(context.hostProfile);
    const selfServiceConfig = hostTenantId
      ? await settingsService.getSelfServiceConfig({ tenantId: hostTenantId }).catch(() => null)
      : null;
    return enrichHostTripFulfillmentPlan(updatedTrip, selfServiceConfig || {});
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

  async createPickupSpot(user, payload = {}) {
    const requestedHostProfileId = payload?.hostProfileId ? String(payload.hostProfileId).trim() : null;
    const context = await resolveHostContext(user, requestedHostProfileId || null);
    if (!context.hostProfile) throw new Error('No host profile is linked to this login yet');

    const tenantId = await resolveHostTenantId(context.hostProfile);
    if (!tenantId) throw new Error('Host tenant is required');

    const label = String(payload?.label || '').trim();
    if (!label) throw new Error('label is required');

    const anchorLocationId = payload?.anchorLocationId ? String(payload.anchorLocationId).trim() : null;
    if (anchorLocationId) {
      const anchorLocation = await prisma.location.findFirst({
        where: { id: anchorLocationId, tenantId, isActive: true }
      });
      if (!anchorLocation) throw new Error('Anchor location not found');
    }

    if (payload?.isDefault) {
      await prisma.hostPickupSpot.updateMany({
        where: { tenantId, hostProfileId: context.hostProfile.id },
        data: { isDefault: false }
      });
    }

    const created = await prisma.hostPickupSpot.create({
      data: {
        tenantId,
        hostProfileId: context.hostProfile.id,
        anchorLocationId,
        label,
        address1: payload?.address1 ? String(payload.address1).trim() : null,
        address2: payload?.address2 ? String(payload.address2).trim() : null,
        city: payload?.city ? String(payload.city).trim() : null,
        state: payload?.state ? String(payload.state).trim() : null,
        postalCode: payload?.postalCode ? String(payload.postalCode).trim() : null,
        country: payload?.country ? String(payload.country).trim() : null,
        latitude: payload?.latitude ? Number(payload.latitude) : null,
        longitude: payload?.longitude ? Number(payload.longitude) : null,
        instructions: payload?.instructions ? String(payload.instructions).trim() : null,
        isDefault: !!payload?.isDefault,
        isActive: payload?.isActive !== false,
        approvalStatus: payload?.approvalStatus ? String(payload.approvalStatus).trim().toUpperCase() : 'PENDING'
      },
      include: {
        anchorLocation: true
      }
    });
    await syncPickupSpotSearchPlace(created);
    return prisma.hostPickupSpot.findUnique({
      where: { id: created.id },
      include: {
        anchorLocation: true,
        searchPlace: {
          include: {
            anchorLocation: true
          }
        }
      }
    });
  },

  async updatePickupSpot(user, id, payload = {}) {
    const requestedHostProfileId = payload?.hostProfileId ? String(payload.hostProfileId).trim() : null;
    const context = await resolveHostContext(user, requestedHostProfileId || null);
    if (!context.hostProfile) throw new Error('No host profile is linked to this login yet');

    const tenantId = await resolveHostTenantId(context.hostProfile);
    if (!tenantId) throw new Error('Host tenant is required');

    const current = await prisma.hostPickupSpot.findFirst({
      where: {
        id,
        tenantId,
        hostProfileId: context.hostProfile.id
      }
    });
    if (!current) throw new Error('Host pickup spot not found');

    const anchorLocationId = Object.prototype.hasOwnProperty.call(payload || {}, 'anchorLocationId')
      ? (payload?.anchorLocationId ? String(payload.anchorLocationId).trim() : null)
      : undefined;
    if (anchorLocationId) {
      const anchorLocation = await prisma.location.findFirst({
        where: { id: anchorLocationId, tenantId, isActive: true }
      });
      if (!anchorLocation) throw new Error('Anchor location not found');
    }

    if (payload?.isDefault) {
      await prisma.hostPickupSpot.updateMany({
        where: { tenantId, hostProfileId: context.hostProfile.id },
        data: { isDefault: false }
      });
    }

    const updated = await prisma.hostPickupSpot.update({
      where: { id: current.id },
      data: {
        label: Object.prototype.hasOwnProperty.call(payload || {}, 'label') ? String(payload?.label || '').trim() : undefined,
        anchorLocationId,
        address1: Object.prototype.hasOwnProperty.call(payload || {}, 'address1') ? (payload?.address1 ? String(payload.address1).trim() : null) : undefined,
        address2: Object.prototype.hasOwnProperty.call(payload || {}, 'address2') ? (payload?.address2 ? String(payload.address2).trim() : null) : undefined,
        city: Object.prototype.hasOwnProperty.call(payload || {}, 'city') ? (payload?.city ? String(payload.city).trim() : null) : undefined,
        state: Object.prototype.hasOwnProperty.call(payload || {}, 'state') ? (payload?.state ? String(payload.state).trim() : null) : undefined,
        postalCode: Object.prototype.hasOwnProperty.call(payload || {}, 'postalCode') ? (payload?.postalCode ? String(payload.postalCode).trim() : null) : undefined,
        country: Object.prototype.hasOwnProperty.call(payload || {}, 'country') ? (payload?.country ? String(payload.country).trim() : null) : undefined,
        latitude: Object.prototype.hasOwnProperty.call(payload || {}, 'latitude') ? (payload?.latitude ? Number(payload.latitude) : null) : undefined,
        longitude: Object.prototype.hasOwnProperty.call(payload || {}, 'longitude') ? (payload?.longitude ? Number(payload.longitude) : null) : undefined,
        instructions: Object.prototype.hasOwnProperty.call(payload || {}, 'instructions') ? (payload?.instructions ? String(payload.instructions).trim() : null) : undefined,
        isDefault: Object.prototype.hasOwnProperty.call(payload || {}, 'isDefault') ? !!payload?.isDefault : undefined,
        isActive: Object.prototype.hasOwnProperty.call(payload || {}, 'isActive') ? !!payload?.isActive : undefined,
        approvalStatus: Object.prototype.hasOwnProperty.call(payload || {}, 'approvalStatus') ? String(payload?.approvalStatus || 'PENDING').trim().toUpperCase() : undefined
      },
      include: {
        anchorLocation: true
      }
    });
    await syncPickupSpotSearchPlace(updated);
    return prisma.hostPickupSpot.findUnique({
      where: { id: updated.id },
      include: {
        anchorLocation: true,
        searchPlace: {
          include: {
            anchorLocation: true
          }
        }
      }
    });
  },

  async syncListingDiscovery(user, id, payload = {}) {
    const requestedHostProfileId = payload?.hostProfileId ? String(payload.hostProfileId).trim() : null;
    const context = await resolveHostContext(user, requestedHostProfileId || null);
    if (!context.hostProfile) throw new Error('No host profile is linked to this login yet');
    const listing = await prisma.hostVehicleListing.findFirst({
      where: {
        id,
        hostProfileId: context.hostProfile.id
      },
      select: {
        id: true,
        tenantId: true,
        hostProfileId: true
      }
    });
    if (!listing) throw new Error('Listing not found for this host');
    const serviceAreas = await syncListingServiceAreas({
      listingId: listing.id,
      tenantId: listing.tenantId || null,
      hostProfileId: listing.hostProfileId
    });
    return { listingId: listing.id, serviceAreas };
  },

  async updateSearchPlace(user, id, payload = {}) {
    const role = String(user?.role || '').toUpperCase();
    const requestedHostProfileId = payload?.hostProfileId ? String(payload.hostProfileId).trim() : null;
    const context = await resolveHostContext(user, requestedHostProfileId || null);
    if (!context.hostProfile) throw new Error('No host profile is linked to this login yet');
    const tenantFilter = role === 'SUPER_ADMIN' ? {} : context.hostProfile.tenantId ? { tenantId: context.hostProfile.tenantId } : {};
    const current = await prisma.carSharingSearchPlace.findFirst({
      where: {
        id,
        hostProfileId: context.hostProfile.id,
        ...tenantFilter
      }
    });
    if (!current) throw new Error('Search place not found for this host');
    const isAdmin = isAdminViewer(user);
    return prisma.carSharingSearchPlace.update({
      where: { id: current.id },
      data: {
        publicLabel: Object.prototype.hasOwnProperty.call(payload || {}, 'publicLabel') ? (payload?.publicLabel ? String(payload.publicLabel).trim() : null) : undefined,
        searchable: Object.prototype.hasOwnProperty.call(payload || {}, 'searchable') ? !!payload?.searchable : undefined,
        isActive: Object.prototype.hasOwnProperty.call(payload || {}, 'isActive') ? !!payload?.isActive : undefined,
        visibilityMode: Object.prototype.hasOwnProperty.call(payload || {}, 'visibilityMode') ? String(payload?.visibilityMode || current.visibilityMode).trim().toUpperCase() : undefined,
        radiusMiles: Object.prototype.hasOwnProperty.call(payload || {}, 'radiusMiles') ? (payload?.radiusMiles ? Number(payload.radiusMiles) : null) : undefined,
        pickupEligible: Object.prototype.hasOwnProperty.call(payload || {}, 'pickupEligible') ? !!payload?.pickupEligible : undefined,
        deliveryEligible: Object.prototype.hasOwnProperty.call(payload || {}, 'deliveryEligible') ? !!payload?.deliveryEligible : undefined,
        approvalStatus: isAdmin && Object.prototype.hasOwnProperty.call(payload || {}, 'approvalStatus')
          ? String(payload?.approvalStatus || current.approvalStatus).trim().toUpperCase()
          : undefined
      },
      include: {
        anchorLocation: true,
        hostPickupSpot: {
          include: {
            anchorLocation: true
          }
        }
      }
    });
  },

  async updateServiceArea(user, id, payload = {}) {
    const requestedHostProfileId = payload?.hostProfileId ? String(payload.hostProfileId).trim() : null;
    const context = await resolveHostContext(user, requestedHostProfileId || null);
    if (!context.hostProfile) throw new Error('No host profile is linked to this login yet');
    const current = await prisma.hostServiceArea.findFirst({
      where: {
        id,
        hostProfileId: context.hostProfile.id
      }
    });
    if (!current) throw new Error('Service area not found for this host');
    return prisma.hostServiceArea.update({
      where: { id: current.id },
      data: {
        isActive: Object.prototype.hasOwnProperty.call(payload || {}, 'isActive') ? !!payload?.isActive : undefined,
        feeOverride: Object.prototype.hasOwnProperty.call(payload || {}, 'feeOverride') ? (payload?.feeOverride === '' || payload?.feeOverride == null ? null : Number(payload.feeOverride)) : undefined,
        leadTimeMinutes: Object.prototype.hasOwnProperty.call(payload || {}, 'leadTimeMinutes') ? (payload?.leadTimeMinutes === '' || payload?.leadTimeMinutes == null ? null : Number(payload.leadTimeMinutes)) : undefined,
        afterHoursAllowed: Object.prototype.hasOwnProperty.call(payload || {}, 'afterHoursAllowed') ? !!payload?.afterHoursAllowed : undefined
      },
      include: {
        listing: {
          select: {
            id: true,
            title: true
          }
        },
        searchPlace: {
          include: {
            anchorLocation: true
          }
        }
      }
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
    const anchorLocationId = submission.preferredLocationId || submission.preferredPickupSpot?.anchorLocationId || null;

    await assertTenantVehicleCapacity(submission.tenantId || null, { vehicleDelta: 1 });

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
        homeLocationId: anchorLocationId
      }
    });

    const listing = await carSharingService.createListing({
      tenantId: submission.tenantId,
      hostProfileId: submission.hostProfileId,
      vehicleId: vehicle.id,
      locationId: anchorLocationId,
      pickupSpotId: submission.preferredPickupSpotId || null,
      title: `${submission.year || ''} ${submission.make || ''} ${submission.model || ''}`.trim() || `${submission.hostProfile.displayName}'s Vehicle`,
      shortDescription: submission.shortDescription || null,
      description: submission.description || null,
      status: 'PUBLISHED',
      ownershipType: 'HOST_OWNED',
      baseDailyRate: Number(submission.baseDailyRate || 0),
      cleaningFee: Number(submission.cleaningFee || 0),
      pickupFee: Number(submission.pickupFee || 0),
      deliveryFee: Number(submission.deliveryFee || 0),
      fulfillmentMode: submission.fulfillmentMode || 'PICKUP_ONLY',
      deliveryRadiusMiles: submission.deliveryRadiusMiles || null,
      deliveryAreasJson: submission.deliveryAreasJson || null,
      deliveryNotes: submission.deliveryNotes || null,
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
