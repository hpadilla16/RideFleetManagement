import { bookingEngineService } from '../booking-engine/booking-engine.service.js';
import { issueCenterService } from '../issue-center/issue-center.service.js';
import { hostReviewsService } from '../host-reviews/host-reviews.service.js';
import { authService } from '../auth/auth.service.js';
import { createHostVehicleSubmissionForProfile } from '../host-app/host-app.service.js';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { money } from '../../lib/money.js';
import crypto from 'node:crypto';

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
  // Trip chat conversation: created by tripChatService at CONFIRMED
  // transition (see messaging/trip-chat.service.js). For a guest looking
  // at their own bookings the relation is effectively 1:1, so we take
  // the first conversation and surface only the guest-scoped fields —
  // the Flutter car-sharing app uses `conversation.guestToken` to open
  // /api/public/booking/trip-chat/:token/* directly from trip detail.
  // Null for trips that haven't reached CONFIRMED yet.
  const conv = reservation.carSharingTrip?.conversations?.[0] || null;
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
      : null,
    conversation: conv
      ? {
          guestToken: conv.guestToken,
          guestTokenExpiresAt: conv.guestTokenExpiresAt
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
      carSharingSearchPlaces: payload.carSharingSearchPlaces || [],
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
        searchPlace: listing.searchPlace || null,
        visibilityMode: listing.pickupSpot?.visibilityMode || 'REVEAL_AFTER_BOOKING',
        exactLocationHidden: !!listing.pickupSpot?.exactLocationHidden,
        primaryImageUrl: listing.primaryImageUrl || '',
        imageUrls: listing.imageUrls || [],
        // `photos` is the canonical shape for native mobile clients that expect
        // structured image metadata. `imageUrls` is retained for backwards
        // compatibility with existing web/admin consumers — do not remove.
        photos: (listing.imageUrls || []).map((url) => ({ url, caption: null }))
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
      searchPlaces: payload.searchPlaces || [],
      locations: payload.locations || [],
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
        deliveryAreaHints: Array.isArray(result.listing.deliveryAreaHints) ? result.listing.deliveryAreaHints : [],
        pickupFee: money(result.listing.pickupFee),
        deliveryFee: money(result.listing.deliveryFee),
        deliveryNotes: result.listing.deliveryNotes || '',
        host: result.listing.host || null,
        vehicle: result.listing.vehicle || null,
        location: result.listing.location || null,
        pickupSpot: result.listing.pickupSpot || null,
        searchPlace: result.listing.searchPlace || null,
        searchMatch: result.listing.searchMatch || null,
        trustSummary: result.listing.trustSummary || null,
        trustScore: Number(result.listing.trustSummary?.score || 0),
        trustBadge: result.listing.trustSummary?.badge || '',
        trustReasons: Array.isArray(result.listing.trustSummary?.reasons) ? result.listing.trustSummary.reasons : [],
        trustTripSignals: result.listing.trustSummary?.tripSignals || null,
        searchPlaceType: result.listing.searchMatch?.searchPlaceType || result.listing.searchPlace?.placeType || null,
        matchReason: result.listing.searchMatch?.matchReason || '',
        matchReasonCode: result.listing.searchMatch?.matchReasonCode || null,
        recommendedBadge: result.listing.searchMatch?.recommendedBadge || '',
        rankingReasons: Array.isArray(result.listing.searchMatch?.rankingReasons)
          ? result.listing.searchMatch.rankingReasons
          : [],
        visibilityMode: result.listing.searchMatch?.visibilityMode || result.listing.pickupSpot?.visibilityMode || 'REVEAL_AFTER_BOOKING',
        exactLocationHidden: !!(result.listing.searchMatch?.exactLocationHidden ?? result.listing.pickupSpot?.exactLocationHidden),
        availableFulfillmentChoices: Array.isArray(result.listing.searchMatch?.availableFulfillmentChoices)
          ? result.listing.searchMatch.availableFulfillmentChoices
          : [],
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
        // Canonical shape for native clients (see notes above).
        photos: (result.listing.imageUrls || []).map((url) => ({ url, caption: null })),
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

      // Send welcome email to the new host (non-blocking)
      sendHostWelcomeEmail({
        email,
        displayName,
        vehicle: [submission.year, submission.make, submission.model].filter(Boolean).join(' '),
        tenantName: tenant.name
      }).catch(() => {});

      // Notify tenant admins about the new submission (non-blocking)
      notifyTenantAdminsNewSubmission({
        tenantId: tenant.id,
        tenantName: tenant.name,
        hostDisplayName: displayName,
        hostEmail: email,
        vehicle: [submission.year, submission.make, submission.model].filter(Boolean).join(' '),
        submissionId: submission.id
      }).catch(() => {});

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
                },
                // Pull the guest-scoped chat token so the Flutter client
                // can open /trip-chat/:token/* straight from trip detail.
                // Only one conversation per trip in practice; `take: 1`
                // keeps the Prisma plan small. We select only the two
                // fields the guest needs — never leak hostToken.
                conversations: {
                  select: {
                    guestToken: true,
                    guestTokenExpiresAt: true
                  },
                  take: 1
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

    const customerIds = customers.map((c) => c.id);
    const pendingReviews = await prisma.hostReview.findMany({
      where: {
        guestCustomerId: { in: customerIds },
        status: 'REQUESTED',
        publicToken: { not: null },
        publicTokenExpiresAt: { gt: new Date() }
      },
      select: {
        id: true,
        publicToken: true,
        publicTokenExpiresAt: true,
        status: true,
        tripId: true,
        hostProfile: { select: { id: true, displayName: true } },
        trip: { select: { tripCode: true, listing: { select: { title: true } } } }
      },
      orderBy: [{ requestedAt: 'desc' }]
    });

    // Issue a guest-role JWT alongside the magic-link session data so native
    // mobile clients (ride-fleet-car-sharing-app) can treat the redeem as a
    // completed sign-in. Expiry is handled by auth.service (currently 7d) and
    // surfaced to clients via `jwtExpiresInSeconds` so they can schedule
    // re-auth before the token lapses.
    const jwtExpiresIn = authService.guestJwtExpiresIn();
    const jwtExpiresInSeconds =
      typeof jwtExpiresIn === 'string' && jwtExpiresIn.endsWith('d')
        ? Number.parseInt(jwtExpiresIn, 10) * 24 * 60 * 60
        : null;

    return {
      customer: {
        id: primary.id,
        firstName: primary.firstName,
        lastName: primary.lastName,
        email: primary.email,
        tenantId: primary.tenantId || null
      },
      jwt: authService.issueGuestToken(primary),
      jwtExpiresInSeconds,
      bookings,
      pendingReviews: pendingReviews.map((r) => ({
        id: r.id,
        token: r.publicToken,
        expiresAt: r.publicTokenExpiresAt,
        tripCode: r.trip?.tripCode || '',
        listingTitle: r.trip?.listing?.title || '',
        hostDisplayName: r.hostProfile?.displayName || ''
      }))
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
  },

  // ── Rental agreement signature (Sprint 5) ────────────────────────
  async getGuestAgreement(token) {
    const reservation = await _findReservationBySignatureToken(token);
    return _formatAgreementResponse(reservation);
  },

  async submitGuestSignature(token, payload) {
    const reservation = await _findReservationBySignatureToken(token);
    if (reservation.signatureSignedAt) {
      throw new Error('Agreement already signed');
    }

    const signaturePng = payload.signaturePng != null
      ? _validateSignatureDataUrl(payload.signaturePng)
      : null;
    const typedName = payload.typedName != null
      ? String(payload.typedName).trim()
      : null;

    if (!signaturePng && !typedName) {
      throw new Error(
        'Either signaturePng (canvas data URL) or typedName is required',
      );
    }
    if (typedName && typedName.length < 2) {
      throw new Error('typedName is too short — provide at least 2 characters');
    }

    const signerName = typedName ||
      [reservation.customer?.firstName, reservation.customer?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      reservation.customer?.email ||
      'Guest';
    const signedAt = new Date();

    const note = `[SIGNATURE ${signedAt.toISOString()}] signed by ${signerName} via Flutter guest app`;

    await prisma.$transaction(async (tx) => {
      await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          signatureSignedAt: signedAt,
          signatureSignedBy: signerName,
          signatureDataUrl: signaturePng || null,
          notes: reservation.notes ? `${reservation.notes}\n${note}` : note,
        },
      });
      const latestAgreement = await tx.rentalAgreement.findFirst({
        where: { reservationId: reservation.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (latestAgreement?.id) {
        await tx.rentalAgreement.update({
          where: { id: latestAgreement.id },
          data: { locked: true },
        });
      }
      await tx.auditLog.create({
        data: {
          reservationId: reservation.id,
          action: 'UPDATE',
          metadata: JSON.stringify({
            signatureCompleted: true,
            signerName,
            typedSignature: !!typedName && !signaturePng,
            source: 'public-booking',
          }),
        },
      });
    });

    // Re-fetch so the response carries the fresh signedAt + any server-
    // side mutations that fired in the transaction.
    const updated = await _findReservationBySignatureToken(token, {
      allowSigned: true,
    });
    return _formatAgreementResponse(updated);
  },

  // ── Pre-check-in documents (Sprint 4) ────────────────────────────
  async getTripDocuments(tripCode) {
    const trip = await _findTripByCode(tripCode);
    const docs = await prisma.tripDocument.findMany({
      where: { tripId: trip.id },
      orderBy: { submittedAt: 'asc' },
    });
    return _formatTripDocumentsResponse(trip, docs);
  },

  async submitTripDocuments(tripCode, payload) {
    const trip = await _findTripByCode(tripCode);

    // Body is { license?: dataUrl, insurance?: dataUrl }. At least one
    // field is required per POST; idempotent by type so a resubmit
    // replaces the earlier row.
    const toWrite = [];
    if (payload.license != null) {
      toWrite.push({
        type: 'LICENSE',
        dataUrl: _validateDocDataUrl(payload.license, 'license'),
      });
    }
    if (payload.insurance != null) {
      toWrite.push({
        type: 'INSURANCE',
        dataUrl: _validateDocDataUrl(payload.insurance, 'insurance'),
      });
    }
    if (toWrite.length === 0) {
      throw new Error(
        'At least one of license or insurance is required',
      );
    }

    await prisma.$transaction(
      toWrite.map((doc) =>
        prisma.tripDocument.upsert({
          where: {
            tripId_documentType: {
              tripId: trip.id,
              documentType: doc.type,
            },
          },
          create: {
            tripId: trip.id,
            documentType: doc.type,
            dataUrl: doc.dataUrl,
            status: 'PENDING',
          },
          update: {
            dataUrl: doc.dataUrl,
            status: 'PENDING',
            rejectReason: null,
            submittedAt: new Date(),
            reviewedAt: null,
          },
        }),
      ),
    );

    // Host-facing notification fires on each submission so their
    // review queue sees an update even when the guest re-captures a
    // single doc. Keep it best-effort — we don't want the POST to fail
    // because MailerSend hiccupped.
    try {
      await _notifyHostOfDocumentSubmission(trip, toWrite.map((d) => d.type));
    } catch (err) {
      console.warn(
        '[pre-check-in] failed to notify host of document submission',
        err,
      );
    }

    const docs = await prisma.tripDocument.findMany({
      where: { tripId: trip.id },
      orderBy: { submittedAt: 'asc' },
    });
    return _formatTripDocumentsResponse(trip, docs);
  },

  async getHostStatus(user) {
    if (!user?.id) throw Object.assign(new Error('Unauthorized'), { status: 401 });

    const hostProfile = await prisma.hostProfile.findFirst({
      where: { userId: user.id },
      select: { id: true, displayName: true, email: true, phone: true, status: true, tenantId: true }
    });

    if (!hostProfile) {
      return { hostProfile: null, submissions: [] };
    }

    const submissions = await prisma.hostVehicleSubmission.findMany({
      where: { hostProfileId: hostProfile.id, tenantId: hostProfile.tenantId },
      include: {
        vehicleType: { select: { id: true, name: true } },
        preferredLocation: { select: { id: true, name: true, city: true, state: true } },
        communications: { orderBy: [{ createdAt: 'desc' }], take: 20 }
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 10
    });

    return {
      hostProfile: {
        id: hostProfile.id,
        displayName: hostProfile.displayName,
        email: hostProfile.email,
        phone: hostProfile.phone,
        status: hostProfile.status
      },
      submissions: submissions.map((sub) => ({
        id: sub.id,
        status: sub.status,
        year: sub.year,
        make: sub.make,
        model: sub.model,
        color: sub.color,
        plate: sub.plate,
        baseDailyRate: sub.baseDailyRate,
        reviewNotes: sub.reviewNotes,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt,
        vehicleType: sub.vehicleType,
        preferredLocation: sub.preferredLocation,
        communications: (sub.communications || []).map((c) => ({
          id: c.id,
          direction: c.direction,
          channel: c.channel,
          subject: c.subject,
          message: c.message,
          createdAt: c.createdAt,
          respondedAt: c.respondedAt
        }))
      }))
    };
  }
};

async function sendHostWelcomeEmail({ email, displayName, vehicle, tenantName }) {
  if (!email) return;
  const subject = `Welcome to ${tenantName || 'Ride Fleet'} — your host account is ready`;
  const text = [
    `Hello ${displayName || 'Host'},`,
    '',
    `Your host account has been created on ${tenantName || 'Ride Fleet'}.`,
    '',
    vehicle ? `Vehicle submitted: ${vehicle}` : '',
    'Your vehicle submission is now pending review. Our team typically reviews new vehicles within 48 hours.',
    '',
    'What happens next:',
    '1. Our review team checks your vehicle details and documents',
    '2. You\'ll receive an email when your vehicle is approved (or if we need more info)',
    '3. Once approved, your listing goes live and guests can start booking',
    '',
    'You can check your submission status anytime by signing in at the car sharing website.',
    '',
    'Thank you for hosting with us!',
    `— The ${tenantName || 'Ride Fleet'} Team`
  ].filter(Boolean).join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111;max-width:560px">
      <div style="padding:24px 28px;border-radius:16px;background:linear-gradient(135deg,#f5f0ff,#faf7ff);border:1px solid #e6dfff">
        <h1 style="margin:0 0 16px;font-size:22px;color:#1a1230">Welcome, ${(displayName || 'Host').replace(/</g, '&lt;')}!</h1>
        <p>Your host account on <strong>${(tenantName || 'Ride Fleet').replace(/</g, '&lt;')}</strong> has been created.</p>
        ${vehicle ? `<p style="margin:12px 0;padding:10px 14px;border-radius:10px;background:#fff;border:1px solid #e6dfff"><strong>Vehicle submitted:</strong> ${vehicle.replace(/</g, '&lt;')}</p>` : ''}
        <p>Your submission is now <strong>pending review</strong>. We typically review within 48 hours.</p>
        <h3 style="margin:20px 0 10px;font-size:16px;color:#1a1230">What happens next</h3>
        <ol style="margin:0;padding-left:20px">
          <li>Our team reviews your details and documents</li>
          <li>You'll get an email when approved or if we need more info</li>
          <li>Once approved, your listing goes live</li>
        </ol>
        <p style="margin-top:20px;font-size:13px;color:#6f668f">Thank you for hosting with us!</p>
      </div>
    </div>
  `;

  return sendEmail({ to: email, subject, text, html });
}

async function notifyTenantAdminsNewSubmission({ tenantId, tenantName, hostDisplayName, hostEmail, vehicle, submissionId }) {
  if (!tenantId) return;

  // Get tenant-scoped admins/ops AND platform super admins
  const [tenantAdmins, superAdmins] = await Promise.all([
    prisma.user.findMany({
      where: { tenantId, role: { in: ['ADMIN', 'OPS'] }, isActive: true },
      select: { email: true }
    }),
    prisma.user.findMany({
      where: { role: 'SUPER_ADMIN', isActive: true },
      select: { email: true }
    })
  ]);

  const adminEmails = [...new Set([...tenantAdmins, ...superAdmins].map((a) => a.email).filter(Boolean))];
  if (!adminEmails.length) return;

  const subject = `New host vehicle submission: ${vehicle || 'Vehicle'} from ${hostDisplayName || hostEmail || 'New host'}`;
  const text = [
    `A new host vehicle submission has been received on ${tenantName || 'Ride Fleet'}.`,
    '',
    `Host: ${hostDisplayName || '-'} (${hostEmail || '-'})`,
    `Vehicle: ${vehicle || '-'}`,
    `Submission ID: ${submissionId || '-'}`,
    '',
    'This submission is pending review. Log in to the Ride Fleet admin dashboard to review and approve.',
    '',
    `— ${tenantName || 'Ride Fleet'} notifications`
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111;max-width:560px">
      <div style="padding:20px 24px;border-radius:14px;background:#fffbeb;border:1px solid #fde68a">
        <h2 style="margin:0 0 12px;font-size:18px;color:#92400e">New Host Vehicle Submission</h2>
        <p style="margin:0 0 8px"><strong>Host:</strong> ${(hostDisplayName || '-').replace(/</g, '&lt;')} (${(hostEmail || '-').replace(/</g, '&lt;')})</p>
        <p style="margin:0 0 8px"><strong>Vehicle:</strong> ${(vehicle || '-').replace(/</g, '&lt;')}</p>
        <p style="margin:0 0 8px"><strong>Status:</strong> Pending Review</p>
        <p style="margin:16px 0 0;font-size:13px;color:#78716c">Log in to the admin dashboard to review this submission.</p>
      </div>
    </div>
  `;

  return sendEmail({ to: adminEmails.join(','), subject, text, html });
}

// ── Pre-check-in helpers (Sprint 4) ─────────────────────────────────

async function _findTripByCode(tripCode) {
  const clean = String(tripCode || '').trim();
  if (!clean) throw new Error('tripCode is required');
  const trip = await prisma.trip.findUnique({
    where: { tripCode: clean },
    select: {
      id: true,
      tenantId: true,
      tripCode: true,
      status: true,
      hostProfileId: true,
      hostProfile: {
        select: { id: true, displayName: true, email: true, phone: true },
      },
      guestCustomerId: true,
      guestCustomer: { select: { firstName: true, email: true } },
    },
  });
  if (!trip) throw new Error(`Trip not found: ${clean}`);
  return trip;
}

// Accepts `data:image/<type>;base64,<payload>` — same convention used
// by trip-chat attachments. Enforces ~8 MB hard limit on the raw
// base64 payload so a misbehaving client can't stuff a video in.
const _ALLOWED_DOC_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'application/pdf'];
const _MAX_DOC_BYTES = 8 * 1024 * 1024; // 8 MB

function _validateDocDataUrl(value, fieldLabel) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${fieldLabel} is required`);
  const match = raw.match(/^data:([^;,]+);base64,(.*)$/i);
  if (!match) {
    throw new Error(`${fieldLabel} must be a base64 data URL (data:<mime>;base64,…)`);
  }
  const mimeType = match[1].toLowerCase();
  if (!_ALLOWED_DOC_MIMES.includes(mimeType)) {
    throw new Error(
      `${fieldLabel} has unsupported mime type ${mimeType}. Allowed: ${_ALLOWED_DOC_MIMES.join(', ')}`,
    );
  }
  const payload = match[2].replace(/\s+/g, '');
  const approxBytes = Math.floor((payload.length * 3) / 4);
  if (approxBytes > _MAX_DOC_BYTES) {
    throw new Error(
      `${fieldLabel} is too large (${Math.round(approxBytes / 1024 / 1024)} MB). Max is 8 MB.`,
    );
  }
  return raw;
}

function _serializeDocument(doc) {
  return {
    type: doc.documentType,
    status: doc.status,
    submittedAt: doc.submittedAt,
    reviewedAt: doc.reviewedAt,
    rejectReason: doc.rejectReason,
  };
}

function _formatTripDocumentsResponse(trip, docs) {
  // Trip.status is normally only moved by host-facing actions; we
  // surface it here so the Flutter client can bail out early if the
  // backend already advanced the trip past RESERVED.
  return {
    tripCode: trip.tripCode,
    tripStatus: trip.status,
    documents: docs.map(_serializeDocument),
    requiredTypes: ['LICENSE', 'INSURANCE'],
  };
}

async function _notifyHostOfDocumentSubmission(trip, typesSubmitted) {
  const hostEmail = trip.hostProfile?.email;
  if (!hostEmail) return; // silent — host may not have email configured

  const subject = 'Guest pre-check-in documents submitted';
  const prettyTypes = typesSubmitted
    .map((t) => _prettyDocType(t))
    .join(', ');
  const text = [
    `Trip ${trip.tripCode}`,
    `Guest: ${trip.guestCustomer?.firstName || trip.guestCustomer?.email || 'Guest'}`,
    `Submitted: ${prettyTypes}`,
    '',
    'Log in to the Ride Fleet admin dashboard to review and approve.',
  ].join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111;max-width:560px">
      <div style="padding:20px 24px;border-radius:14px;background:#f5f3ff;border:1px solid #c4b5fd">
        <h2 style="margin:0 0 12px;font-size:18px;color:#5b21b6">Pre-check-in documents submitted</h2>
        <p style="margin:0 0 8px"><strong>Trip:</strong> ${trip.tripCode}</p>
        <p style="margin:0 0 8px"><strong>Submitted:</strong> ${prettyTypes.replace(/</g, '&lt;')}</p>
        <p style="margin:16px 0 0;font-size:13px;color:#6d28d9">Review in the Ride Fleet admin dashboard.</p>
      </div>
    </div>
  `;

  return sendEmail({ to: hostEmail, subject, text, html });
}

function _prettyDocType(type) {
  switch (type) {
    case 'LICENSE':
      return 'Driver license';
    case 'INSURANCE':
      return 'Insurance card';
    default:
      return type;
  }
}

// ── Agreement helpers (Sprint 5) ─────────────────────────────────────

async function _findReservationBySignatureToken(token, { allowSigned = false } = {}) {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('Signature token is required');
  const reservation = await prisma.reservation.findFirst({
    where: {
      signatureToken: clean,
      // When signing is completing, we re-fetch from the transaction —
      // allow lookups past the stored expiry in that case.
      ...(allowSigned
        ? {}
        : { signatureTokenExpiresAt: { gt: new Date() } }),
    },
    include: {
      customer: {
        select: { firstName: true, lastName: true, email: true },
      },
      vehicle: { select: { year: true, make: true, model: true, color: true } },
      vehicleType: { select: { label: true } },
      pickupLocation: { select: { name: true } },
      returnLocation: { select: { name: true } },
      carSharingTrip: { select: { tripCode: true } },
    },
  });
  if (!reservation) {
    throw new Error('Invalid or expired signature link');
  }
  return reservation;
}

// Signature PNG comes in as a `data:image/png;base64,…` URL. Same
// shape the trip-chat + pre-check-in endpoints use. Smaller cap (2 MB)
// since it's always a tiny PNG of a handwritten stroke.
const _SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;

function _validateSignatureDataUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('signaturePng is required');
  const match = raw.match(/^data:(image\/png|image\/jpeg|image\/jpg);base64,(.*)$/i);
  if (!match) {
    throw new Error(
      'signaturePng must be a base64 data URL (data:image/png;base64,…)',
    );
  }
  const payload = match[2].replace(/\s+/g, '');
  const approxBytes = Math.floor((payload.length * 3) / 4);
  if (approxBytes > _SIGNATURE_MAX_BYTES) {
    throw new Error(
      `signaturePng is too large (${Math.round(approxBytes / 1024)} KB). Max is 2 MB.`,
    );
  }
  return raw;
}

function _formatAgreementResponse(reservation) {
  const firstName = reservation.customer?.firstName || '';
  const lastName = reservation.customer?.lastName || '';
  const vehicle = reservation.vehicle;
  const vehicleLabel = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ').trim()
    : reservation.vehicleType?.label || 'Selected vehicle';

  return {
    agreementToken: reservation.signatureToken,
    tripCode: reservation.carSharingTrip?.tripCode || null,
    reservationNumber: reservation.reservationNumber,
    signedAt: reservation.signatureSignedAt,
    signedBy: reservation.signatureSignedBy,
    customerName: [firstName, lastName].filter(Boolean).join(' ').trim() || null,
    vehicleLabel,
    pickupAt: reservation.pickupAt,
    returnAt: reservation.returnAt,
    pickupLocationName: reservation.pickupLocation?.name || null,
    returnLocationName: reservation.returnLocation?.name || null,
    pdfUrl: null, // PDF generation is served via the admin-side HTML
                  // render today; a public-facing PDF URL lands in a
                  // later sprint when we swap HTML→PDF pipeline.
    keyTerms: _deriveKeyTerms(reservation),
  };
}

function _deriveKeyTerms(reservation) {
  const pickupAt = reservation.pickupAt;
  const returnAt = reservation.returnAt;
  const hasMileageCap = Number(reservation.dailyMileageCap || 0) > 0;
  const depositAmount = Number(reservation.securityDepositAmount || 300);

  const returnFmt = returnAt
    ? new Date(returnAt).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : 'the scheduled return time';

  return [
    {
      icon: 'clock',
      title: `Return by ${returnFmt}`,
      detail:
        'Grace window: 30 minutes. After that, a $50/hour late fee applies.',
    },
    {
      icon: 'road',
      title: hasMileageCap
        ? `${reservation.dailyMileageCap} miles/day included`
        : 'Mileage included per listing',
      detail:
        'Overage billed at $0.45/mi against the Renter\'s card at return.',
    },
    {
      icon: 'money',
      title: `$${depositAmount.toFixed(0)} security deposit`,
      detail:
        'Authorized on the card at pickup, released within 3 business days after return.',
    },
    {
      icon: 'car',
      title: 'Damage and wear',
      detail:
        "Renter is responsible for damage beyond normal wear, up to the deposit. Anything above goes through the incident flow.",
    },
  ];
}
