import { bookingEngineService } from '../booking-engine/booking-engine.service.js';
import { issueCenterService } from '../issue-center/issue-center.service.js';
import { hostReviewsService } from '../host-reviews/host-reviews.service.js';
import { authService } from '../auth/auth.service.js';
import { createHostVehicleSubmissionForProfile } from '../host-app/host-app.service.js';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import crypto from 'node:crypto';

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function baseUrl() {
  return (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function guestLink(token) {
  return `${baseUrl()}/guest?token=${encodeURIComponent(token)}`;
}

function publicBookLink(params = {}) {
  const url = new URL(`${baseUrl()}/book`);
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function coerceDate(value, fallback) {
  const parsed = value ? new Date(value) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  return new Date(fallback);
}

function defaultVehicleClassWindow() {
  const pickupAt = new Date();
  pickupAt.setDate(pickupAt.getDate() + 1);
  pickupAt.setHours(10, 0, 0, 0);
  const returnAt = new Date(pickupAt);
  returnAt.setDate(returnAt.getDate() + 3);
  return { pickupAt, returnAt };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function parseJsonArray(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeDeliveryAreas(value) {
  return parseJsonArray(value)
    .map((row) => String(row || '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

async function resolvePublicCarSharingTenant({ tenantSlug, tenantId }) {
  const scopedTenantId = tenantId ? String(tenantId).trim() : '';
  const scopedTenantSlug = tenantSlug ? String(tenantSlug).trim().toLowerCase() : '';
  if (!scopedTenantId && !scopedTenantSlug) throw new Error('tenantSlug or tenantId is required');

  const tenant = await prisma.tenant.findFirst({
    where: {
      status: 'ACTIVE',
      ...(scopedTenantId ? { id: scopedTenantId } : {}),
      ...(scopedTenantSlug ? { slug: scopedTenantSlug } : {})
    },
    select: {
      id: true,
      name: true,
      slug: true,
      carSharingEnabled: true
    }
  });

  if (!tenant) throw new Error('Tenant not found');
  if (!tenant.carSharingEnabled) throw new Error('Car sharing is not enabled for this tenant');
  return tenant;
}

async function createInlinePickupSpot({ tenantId, hostProfileId, input = {} }) {
  const label = String(input?.pickupSpotLabel || '').trim();
  if (!label) return null;

  const anchorLocationId = input?.pickupSpotAnchorLocationId
    ? String(input.pickupSpotAnchorLocationId).trim()
    : (input?.preferredLocationId ? String(input.preferredLocationId).trim() : null);

  if (anchorLocationId) {
    const anchorLocation = await prisma.location.findFirst({
      where: { id: anchorLocationId, tenantId, isActive: true },
      select: { id: true }
    });
    if (!anchorLocation) throw new Error('Pickup spot anchor location not found');
  }

  return prisma.hostPickupSpot.create({
    data: {
      tenantId,
      hostProfileId,
      anchorLocationId,
      label,
      address1: input?.pickupSpotAddress1 ? String(input.pickupSpotAddress1).trim() : null,
      address2: input?.pickupSpotAddress2 ? String(input.pickupSpotAddress2).trim() : null,
      city: input?.pickupSpotCity ? String(input.pickupSpotCity).trim() : null,
      state: input?.pickupSpotState ? String(input.pickupSpotState).trim() : null,
      postalCode: input?.pickupSpotPostalCode ? String(input.pickupSpotPostalCode).trim() : null,
      country: input?.pickupSpotCountry ? String(input.pickupSpotCountry).trim() : null,
      instructions: input?.pickupSpotInstructions ? String(input.pickupSpotInstructions).trim() : null,
      isDefault: true,
      isActive: true,
      approvalStatus: 'PENDING'
    },
    include: {
      anchorLocation: true
    }
  });
}

async function issueGuestAccess({ customers = [], email, customerName, subject = 'Open your guest account', intro = 'Use this secure link to open your guest account and see all of your bookings.' }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('email is required');
  if (!customers.length) throw new Error('No guest account found for that email');

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
  await prisma.customer.updateMany({
    where: {
      email: {
        equals: normalizedEmail,
        mode: 'insensitive'
      }
    },
    data: {
      guestAccessToken: token,
      guestAccessExpiresAt: expiresAt
    }
  });

  const displayName = customerName || customers[0]?.firstName || 'Guest';
  const link = guestLink(token);
  await sendEmail({
    to: normalizedEmail,
    subject,
    text: [
      `Hello ${displayName},`,
      '',
      intro,
      link,
      '',
      `This link expires on ${expiresAt.toLocaleString()}.`
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">
        <div>Hello ${displayName},</div>
        <div style="margin-top:12px">${intro}</div>
        <div style="margin-top:18px"><a href="${link}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#7c3aed;color:#fff;text-decoration:none;font-weight:700">Open Guest Account</a></div>
        <div style="margin-top:12px">${link}</div>
        <div style="margin-top:12px">This link expires on ${expiresAt.toLocaleString()}.</div>
      </div>
    `
  });

  return {
    ok: true,
    email: normalizedEmail,
    expiresAt,
    linkSent: true
  };
}

function bookingSummaryFromReservation(reservation) {
  return {
    type: reservation.workflowMode === 'CAR_SHARING' ? 'CAR_SHARING' : 'RENTAL',
    reference: reservation.workflowMode === 'CAR_SHARING'
      ? (reservation.carSharingTrip?.tripCode || reservation.reservationNumber)
      : reservation.reservationNumber,
    reservationNumber: reservation.reservationNumber,
    tripCode: reservation.carSharingTrip?.tripCode || '',
    status: reservation.workflowMode === 'CAR_SHARING'
      ? (reservation.carSharingTrip?.status || reservation.status)
      : reservation.status,
    pickupAt: reservation.pickupAt,
    returnAt: reservation.returnAt,
    pickupLocationName: reservation.pickupLocation?.name || '',
    vehicleLabel: [
      reservation.carSharingTrip?.listing?.vehicle?.year || reservation.vehicle?.year || '',
      reservation.carSharingTrip?.listing?.vehicle?.make || reservation.vehicle?.make || '',
      reservation.carSharingTrip?.listing?.vehicle?.model || reservation.vehicle?.model || ''
    ].filter(Boolean).join(' ') || reservation.vehicleType?.name || reservation.carSharingTrip?.listing?.title || 'Vehicle',
    estimatedTotal: money(reservation.estimatedTotal || reservation.carSharingTrip?.quotedTotal),
    host: reservation.carSharingTrip?.hostProfile
      ? {
          id: reservation.carSharingTrip.hostProfile.id,
          displayName: reservation.carSharingTrip.hostProfile.displayName,
          averageRating: Number(reservation.carSharingTrip.hostProfile.averageRating || 0),
          reviewCount: Number(reservation.carSharingTrip.hostProfile.reviewCount || 0)
        }
      : null
  };
}

export const publicBookingService = {
  async getBootstrap(input = {}) {
    const payload = await bookingEngineService.getBootstrap(input);
    return {
      tenants: payload.tenants || [],
      selectedTenant: payload.tenant || null,
      locations: payload.locations || [],
      vehicleTypes: payload.vehicleTypes || [],
      featuredCarSharingListings: (payload.featuredListings || []).map((listing) => ({
        id: listing.id,
        slug: listing.slug,
        title: listing.title,
        shortDescription: listing.shortDescription || '',
        baseDailyRate: money(listing.baseDailyRate),
        instantBook: !!listing.instantBook,
        minTripDays: Number(listing.minTripDays || 1),
        maxTripDays: listing.maxTripDays ? Number(listing.maxTripDays) : null,
        fulfillmentMode: listing.fulfillmentMode || 'PICKUP_ONLY',
        deliveryRadiusMiles: listing.deliveryRadiusMiles ? Number(listing.deliveryRadiusMiles) : null,
        deliveryAreas: normalizeDeliveryAreas(listing.deliveryAreas || listing.deliveryAreasJson),
        pickupFee: money(listing.pickupFee),
        deliveryFee: money(listing.deliveryFee),
        deliveryNotes: listing.deliveryNotes || '',
        host: listing.host || null,
        vehicle: listing.vehicle || null,
        location: listing.location || null,
        pickupSpot: listing.pickupSpot || null,
        primaryImageUrl: listing.primaryImageUrl || '',
        imageUrls: listing.imageUrls || []
      }))
    };
  },

  async getVehicleClasses(input = {}) {
    const windowDefaults = defaultVehicleClassWindow();
    const pickupAt = coerceDate(input?.pickupAt, windowDefaults.pickupAt);
    const returnAt = coerceDate(input?.returnAt, windowDefaults.returnAt);
    const bootstrap = await bookingEngineService.getBootstrap({
      tenantSlug: input?.tenantSlug,
      tenantId: input?.tenantId
    });

    const allLocations = Array.isArray(bootstrap?.locations) ? bootstrap.locations : [];
    const scopedLocations = input?.pickupLocationId
      ? allLocations.filter((location) => String(location.id) === String(input.pickupLocationId))
      : allLocations;
    const candidateLocations = scopedLocations.length ? scopedLocations : allLocations;
    const primaryLocationId = candidateLocations[0]?.id || '';

    if (!primaryLocationId) {
      return {
        tenant: bootstrap?.tenant || null,
        pickupAt,
        returnAt,
        locationScope: [],
        classes: []
      };
    }

    const search = await bookingEngineService.searchRental({
      tenantSlug: input?.tenantSlug,
      tenantId: input?.tenantId,
      pickupLocationId: primaryLocationId,
      pickupLocationIds: candidateLocations.map((location) => location.id),
      pickupAt: pickupAt.toISOString(),
      returnAt: returnAt.toISOString()
    });

    const grouped = new Map();
    for (const result of search?.results || []) {
      const vehicleType = result?.vehicleType;
      if (!vehicleType?.id) continue;
      const key = String(vehicleType.id);
      const availabilityCount = Math.max(0, Number(result?.availability?.availableUnits || 0));
      const dailyRate = money(result?.quote?.dailyRate);
      const location = result?.location || null;
      const locationLabel = [location?.name, location?.city, location?.state].filter(Boolean).join(', ');

      if (!grouped.has(key)) {
        grouped.set(key, {
          vehicleType: {
            id: vehicleType.id,
            code: vehicleType.code || '',
            name: vehicleType.name || 'Vehicle Class',
            description: vehicleType.description || '',
            imageUrl: vehicleType.imageUrl || ''
          },
          advertisedDailyRate: dailyRate,
          availableUnits: availabilityCount,
          available: availabilityCount > 0,
          featuredLocation: location
            ? {
                id: location.id,
                name: location.name || '',
                city: location.city || '',
                state: location.state || '',
                label: locationLabel
              }
            : null,
          locations: location ? [{
            id: location.id,
            name: location.name || '',
            city: location.city || '',
            state: location.state || '',
            label: locationLabel
          }] : []
        });
        continue;
      }

      const current = grouped.get(key);
      current.availableUnits += availabilityCount;
      current.available = current.availableUnits > 0;
      if (dailyRate > 0 && (!current.advertisedDailyRate || dailyRate < current.advertisedDailyRate)) {
        current.advertisedDailyRate = dailyRate;
        current.featuredLocation = location
          ? {
              id: location.id,
              name: location.name || '',
              city: location.city || '',
              state: location.state || '',
              label: locationLabel
            }
          : current.featuredLocation;
      }
      if (location && !current.locations.some((row) => row.id === location.id)) {
        current.locations.push({
          id: location.id,
          name: location.name || '',
          city: location.city || '',
          state: location.state || '',
          label: locationLabel
        });
      }
    }

    const limit = Math.max(1, Math.min(24, Number(input?.limit || 12) || 12));
    const classes = [...grouped.values()]
      .sort((left, right) => {
        if (Number(right.availableUnits || 0) !== Number(left.availableUnits || 0)) {
          return Number(right.availableUnits || 0) - Number(left.availableUnits || 0);
        }
        return Number(left.advertisedDailyRate || 0) - Number(right.advertisedDailyRate || 0);
      })
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        rentNowUrl: publicBookLink({
          tenantSlug: bootstrap?.tenant?.slug || input?.tenantSlug || '',
          searchMode: 'RENTAL',
          vehicleTypeId: entry.vehicleType.id,
          pickupAt: pickupAt.toISOString(),
          returnAt: returnAt.toISOString(),
          pickupLocationId: entry.featuredLocation?.id || primaryLocationId,
          returnLocationId: entry.featuredLocation?.id || primaryLocationId
        })
      }));

    return {
      tenant: bootstrap?.tenant || null,
      pickupAt,
      returnAt,
      locationScope: candidateLocations.map((location) => ({
        id: location.id,
        tenantId: location.tenantId || null,
        name: location.name || '',
        city: location.city || '',
        state: location.state || '',
        label: [location.name, location.city, location.state].filter(Boolean).join(', ')
      })),
      classes
    };
  },

  async searchRentalQuotes(input = {}) {
    const payload = await bookingEngineService.searchRental(input);
    return {
      tenant: payload.tenant,
      searchType: 'RENTAL',
      pickupLocation: payload.location,
      returnLocationId: input?.returnLocationId || input?.pickupLocationId || null,
      pickupAt: payload.pickupAt,
      returnAt: payload.returnAt,
      taxRate: Number(payload.location?.taxRate || 0),
      defaultDepositMeta: null,
      results: (payload.results || []).map((result) => ({
        vehicleType: result.vehicleType,
        location: result.location || payload.location,
        primaryImageUrl: result.vehicleType?.imageUrl || '',
        imageUrls: result.vehicleType?.imageUrl ? [result.vehicleType.imageUrl] : [],
        availabilityCount: Number(result.availability?.availableUnits || 0),
        soldOut: !result.availability?.available,
        sampleVehicleLabel: '',
        quote: {
          rateId: null,
          rateCode: null,
          days: Number(result.quote?.days || 0),
          dailyRate: money(result.quote?.dailyRate),
          baseDailyRate: money(result.quote?.baseDailyRate || result.quote?.dailyRate),
          baseTotal: money(result.quote?.subtotal),
          baseSubtotal: money(result.quote?.baseSubtotal || result.quote?.subtotal),
          mandatoryFees: money(result.quote?.fees),
          estimatedTaxes: money(result.quote?.taxes),
          estimatedTripTotal: money(result.quote?.total),
          gracePeriodMin: Number(result.quote?.gracePeriodMin || 0),
          source: result.quote?.source || 'GLOBAL',
          revenuePricingApplied: !!result.quote?.revenuePricingApplied,
          revenueRecommendationMode: result.quote?.revenueRecommendationMode || 'ADVISORY',
          revenueAdjustmentPct: money(result.quote?.revenueAdjustmentPct),
          revenueFactors: Array.isArray(result.quote?.revenueFactors) ? result.quote.revenueFactors : [],
          revenueSummary: result.quote?.revenueSummary || '',
          revenueMetrics: result.quote?.revenueMetrics || null,
          revenueDailyBreakdown: Array.isArray(result.quote?.revenueDailyBreakdown) ? result.quote.revenueDailyBreakdown : [],
          depositRequired: !!result.deposit?.required,
          depositAmountDue: money(result.deposit?.amountDue),
          depositMode: result.deposit?.mode || null,
          depositBasis: [],
          securityDepositRequired: !!result.deposit?.securityDepositRequired,
          securityDepositAmount: money(result.deposit?.securityDepositAmount)
        },
        additionalServices: (result.additionalServices || []).map((service) => ({
          serviceId: service.serviceId,
          code: service.code,
          name: service.name,
          description: service.description || '',
          unitLabel: service.unitLabel || 'Unit',
          pricingMode: service.pricingMode || 'FLAT',
          quantity: Number(service.quantity || 1),
          rate: money(service.rate),
          total: money(service.total),
          taxable: !!service.taxable,
          mandatory: !!service.mandatory,
          linkedFee: service.linkedFee ? {
            feeId: service.linkedFee.feeId,
            code: service.linkedFee.code || null,
            name: service.linkedFee.name,
            description: service.linkedFee.description || '',
            mode: service.linkedFee.mode || 'FIXED',
            amount: money(service.linkedFee.amount),
            taxable: !!service.linkedFee.taxable
          } : null
        })),
        mandatoryFees: (result.mandatoryFees || []).map((fee) => ({
          feeId: fee.feeId,
          code: fee.code,
          name: fee.name,
          description: fee.description || '',
          mode: fee.mode || 'FIXED',
          amount: money(fee.amount),
          total: money(fee.total),
          taxable: !!fee.taxable,
          mandatory: true
        })),
        insurancePlans: (result.insurancePlans || []).map((plan) => ({
          code: plan.code,
          name: plan.name,
          description: plan.description || '',
          chargeBy: plan.chargeBy || 'FIXED',
          amount: money(plan.amount),
          quantity: Number(plan.quantity || 1),
          rate: money(plan.rate),
          total: money(plan.total),
          taxable: !!plan.taxable
        }))
      }))
    };
  },

  async searchCarSharingListings(input = {}) {
    const payload = await bookingEngineService.searchCarSharing(input);
    return {
      tenant: payload.tenant,
      searchType: 'CAR_SHARING',
      pickupAt: payload.pickupAt,
      returnAt: payload.returnAt,
      tripDays: payload.results?.[0]?.quote?.tripDays || null,
      results: (payload.results || []).map((result) => ({
        id: result.listing.id,
        slug: result.listing.slug,
        title: result.listing.title,
        shortDescription: result.listing.shortDescription || '',
        description: result.listing.description || '',
        instantBook: !!result.listing.instantBook,
        ownershipType: result.listing.ownershipType || 'HOST_OWNED',
        minTripDays: Number(result.listing.minTripDays || 1),
        maxTripDays: result.listing.maxTripDays ? Number(result.listing.maxTripDays) : null,
        fulfillmentMode: result.listing.fulfillmentMode || 'PICKUP_ONLY',
        deliveryRadiusMiles: result.listing.deliveryRadiusMiles ? Number(result.listing.deliveryRadiusMiles) : null,
        deliveryAreas: normalizeDeliveryAreas(result.listing.deliveryAreas || result.listing.deliveryAreasJson),
        pickupFee: money(result.listing.pickupFee),
        deliveryFee: money(result.listing.deliveryFee),
        deliveryNotes: result.listing.deliveryNotes || '',
        host: result.listing.host || null,
        vehicle: result.listing.vehicle || null,
        location: result.listing.location || null,
        pickupSpot: result.listing.pickupSpot || null,
        additionalServices: (result.listing.additionalServices || []).map((service) => ({
          serviceId: service.serviceId,
          code: service.code,
          name: service.name,
          description: service.description || '',
          unitLabel: service.unitLabel || 'Unit',
          pricingMode: service.pricingMode || 'FLAT',
          quantity: Number(service.quantity || 1),
          rate: money(service.rate),
          total: money(service.total),
          taxable: !!service.taxable,
          mandatory: !!service.mandatory
        })),
        primaryImageUrl: result.listing.primaryImageUrl || '',
        imageUrls: result.listing.imageUrls || [],
        quote: {
          tripDays: Number(result.quote?.tripDays || 0),
          subtotal: money(result.quote?.subtotal),
          pickupFee: money(result.quote?.pickupFee),
          deliveryFee: money(result.quote?.deliveryFee),
          pickupTotal: money(result.quote?.pickupTotal),
          deliveryTotal: money(result.quote?.deliveryTotal),
          pickupGuestTripFee: money(result.quote?.pickupGuestTripFee),
          deliveryGuestTripFee: money(result.quote?.deliveryGuestTripFee),
          pickupHostChargeFees: money(result.quote?.pickupHostChargeFees),
          deliveryHostChargeFees: money(result.quote?.deliveryHostChargeFees),
          fulfillmentChoice: result.quote?.fulfillmentChoice || 'PICKUP',
          selectedFulfillmentFee: money(result.quote?.selectedFulfillmentFee),
          fees: money(result.quote?.fees),
          taxes: money(result.quote?.taxes),
          total: money(result.quote?.total),
          hostGrossRevenue: money(result.quote?.hostGrossRevenue),
          hostServiceFeeRate: money(result.quote?.hostServiceFeeRate),
          hostServiceFee: money(result.quote?.hostServiceFee),
          guestTripFee: money(result.quote?.guestTripFee),
          hostEarnings: money(result.quote?.hostEarnings),
          platformFee: money(result.quote?.platformFee),
          platformRevenue: money(result.quote?.platformRevenue)
        },
        activeWindowCount: 0
      }))
    };
  },

  async createBooking(input = {}) {
    return bookingEngineService.createPublicBooking(input);
  },

  async lookupBooking(input = {}) {
    return bookingEngineService.lookupPublicBooking(input);
  },

  async requestGuestSignIn(input = {}) {
    const email = normalizeEmail(input?.email);
    if (!email) throw new Error('email is required');

    const matchingCustomers = await prisma.customer.findMany({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      },
      select: {
        id: true,
        firstName: true,
        email: true,
        reservations: { take: 1, select: { id: true } },
        guestTrips: { take: 1, select: { id: true } }
      }
    });

    if (!matchingCustomers.length) throw new Error('No guest account found for that email');

    return issueGuestAccess({
      customers: matchingCustomers,
      email,
      customerName: matchingCustomers[0]?.firstName || 'Guest'
    });
  },

  async createGuestAccount(input = {}) {
    const email = normalizeEmail(input?.email);
    const firstName = String(input?.firstName || '').trim();
    const lastName = String(input?.lastName || '').trim();
    const phone = String(input?.phone || '').trim();

    if (!firstName) throw new Error('firstName is required');
    if (!lastName) throw new Error('lastName is required');
    if (!email) throw new Error('email is required');
    if (!phone) throw new Error('phone is required');

    const matchingCustomers = await prisma.customer.findMany({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      },
      select: {
        id: true,
        firstName: true,
        email: true
      }
    });

    let customers = matchingCustomers;
    if (!customers.length) {
      const created = await prisma.customer.create({
        data: {
          tenantId: null,
          firstName,
          lastName,
          email,
          phone
        },
        select: {
          id: true,
          firstName: true,
          email: true
        }
      });
      customers = [created];
    }

    return issueGuestAccess({
      customers,
      email,
      customerName: firstName || customers[0]?.firstName || 'Guest',
      subject: 'Welcome to Ride Fleet guest access',
      intro: 'Your guest account is ready. Use this secure link to sign in, view your reservations, and make future bookings from the same guest account.'
    });
  },

  async createHostSignup(input = {}) {
    const tenant = await resolvePublicCarSharingTenant({
      tenantSlug: input?.tenantSlug,
      tenantId: input?.tenantId
    });

    const fullName = String(input?.fullName || '').trim();
    const displayName = String(input?.displayName || '').trim() || fullName;
    const legalName = String(input?.legalName || '').trim();
    const email = normalizeEmail(input?.email);
    const phone = String(input?.phone || '').trim();
    const password = String(input?.password || '');

    if (!fullName) throw new Error('fullName is required');
    if (!displayName) throw new Error('displayName is required');
    if (!email) throw new Error('email is required');
    if (!phone) throw new Error('phone is required');
    if (password.length < 8) throw new Error('password must be at least 8 characters');

    const existingHost = await prisma.hostProfile.findFirst({
      where: {
        tenantId: tenant.id,
        OR: [
          { email: { equals: email, mode: 'insensitive' } },
          { user: { email: { equals: email, mode: 'insensitive' } } }
        ]
      },
      select: { id: true }
    });
    if (existingHost) throw new Error('A host account already exists for that email in this tenant');

    const registration = await authService.register({
      email,
      password,
      fullName,
      tenantId: tenant.id
    });

    const userId = registration?.user?.id;
    if (!userId) throw new Error('Could not create host login');

    let hostProfile = null;
    let pickupSpot = null;
    try {
      hostProfile = await prisma.hostProfile.create({
        data: {
          tenantId: tenant.id,
          userId,
          displayName,
          legalName: legalName || null,
          email,
          phone,
          status: 'ACTIVE',
          notes: 'Created through public host signup'
        }
      });

      pickupSpot = await createInlinePickupSpot({
        tenantId: tenant.id,
        hostProfileId: hostProfile.id,
        input
      });

      const submission = await createHostVehicleSubmissionForProfile({
        hostProfileId: hostProfile.id,
        tenantId: tenant.id,
        payload: {
          ...input,
          preferredPickupSpotId: input?.preferredPickupSpotId || pickupSpot?.id || null,
          preferredLocationId: input?.preferredLocationId || pickupSpot?.anchorLocationId || null
        }
      });

      const sessionUser = await authService.getSessionUser(userId);
      return {
        ok: true,
        token: registration.token,
        user: sessionUser || registration.user,
        tenant,
        hostProfile: {
          id: hostProfile.id,
          displayName: hostProfile.displayName,
          email: hostProfile.email || '',
          phone: hostProfile.phone || ''
        },
        submission: {
          id: submission.id,
          status: submission.status,
          vehicleType: submission.vehicleType,
          preferredLocation: submission.preferredLocation,
          preferredPickupSpot: submission.preferredPickupSpot,
          createdAt: submission.createdAt
        },
        message: 'Host account created. Your vehicle submission is pending review.'
      };
    } catch (error) {
      if (pickupSpot?.id) {
        await prisma.hostPickupSpot.delete({ where: { id: pickupSpot.id } }).catch(() => null);
      }
      if (hostProfile?.id) {
        await prisma.hostProfile.delete({ where: { id: hostProfile.id } }).catch(() => null);
      }
      await prisma.user.delete({ where: { id: userId } }).catch(() => null);
      throw error;
    }
  },

  async getGuestSession(token) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) throw new Error('token is required');

    const customers = await prisma.customer.findMany({
      where: {
        guestAccessToken: cleanToken,
        guestAccessExpiresAt: { gt: new Date() }
      },
      include: {
        reservations: {
          include: {
            pickupLocation: true,
            returnLocation: true,
            vehicle: true,
            vehicleType: true,
            carSharingTrip: {
              include: {
                hostProfile: true,
                listing: {
                  include: {
                    vehicle: true
                  }
                }
              }
            }
          },
          orderBy: [{ pickupAt: 'desc' }]
        }
      }
    });

    if (!customers.length) throw new Error('Invalid or expired guest sign-in link');

    const primary = customers[0];
    const deduped = new Map();
    for (const customer of customers) {
      for (const reservation of customer.reservations || []) {
        deduped.set(reservation.id, bookingSummaryFromReservation(reservation));
      }
    }

    const bookings = [...deduped.values()].sort((a, b) => new Date(b.pickupAt).getTime() - new Date(a.pickupAt).getTime());

    return {
      customer: {
        id: primary.id,
        firstName: primary.firstName,
        lastName: primary.lastName,
        email: primary.email
      },
      bookings
    };
  },

  async createIssue(input = {}) {
    return issueCenterService.createGuestIncident(input);
  },

  async getHostProfile(id) {
    return hostReviewsService.getPublicHostProfile(id);
  },

  async getHostReviewPrompt(token) {
    return hostReviewsService.getPublicReviewPrompt(token);
  },

  async submitHostReview(token, input = {}) {
    return hostReviewsService.submitPublicReview(token, input);
  }
};
