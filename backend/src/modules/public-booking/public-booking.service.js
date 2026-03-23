import { bookingEngineService } from '../booking-engine/booking-engine.service.js';
import { issueCenterService } from '../issue-center/issue-center.service.js';
import { hostReviewsService } from '../host-reviews/host-reviews.service.js';

function money(value) {
  return Number(Number(value || 0).toFixed(2));
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
        host: listing.host || null,
        vehicle: listing.vehicle || null,
        location: listing.location || null,
        primaryImageUrl: listing.primaryImageUrl || '',
        imageUrls: listing.imageUrls || []
      }))
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
        location: payload.location,
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
          baseTotal: money(result.quote?.subtotal),
          estimatedTaxes: money(result.quote?.taxes),
          estimatedTripTotal: money(result.quote?.total),
          gracePeriodMin: Number(result.quote?.gracePeriodMin || 0),
          source: result.quote?.source || 'GLOBAL',
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
          mandatory: !!service.mandatory
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
        host: result.listing.host || null,
        vehicle: result.listing.vehicle || null,
        location: result.listing.location || null,
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
          fees: money(result.quote?.fees),
          taxes: money(result.quote?.taxes),
          total: money(result.quote?.total),
          hostEarnings: money(result.quote?.hostEarnings),
          platformFee: money(result.quote?.platformFee)
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
