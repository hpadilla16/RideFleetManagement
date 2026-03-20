import { prisma } from '../../lib/prisma.js';
import { ratesService } from '../rates/rates.service.js';

function parseLocationConfig(raw) {
  try {
    if (!raw) return {};
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object') return raw;
  } catch {}
  return {};
}

function toDate(value) {
  const dt = value ? new Date(value) : null;
  return dt && !Number.isNaN(dt.getTime()) ? dt : null;
}

function overlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function startOfUtcDay(dt) {
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

function addUtcDays(dt, days) {
  const copy = new Date(dt);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function ceilTripDays(startAt, endAt) {
  return Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / (24 * 60 * 60 * 1000)));
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function depositSnapshot({ location, quote, addOnsTotal = 0 }) {
  const cfg = parseLocationConfig(location?.locationConfig);
  const requireDeposit = !!cfg?.requireDeposit;
  const depositMode = String(cfg?.depositMode || 'FIXED').toUpperCase();
  const depositValue = Number(cfg?.depositAmount || 0);
  const basis = Array.isArray(cfg?.depositPercentBasis) && cfg.depositPercentBasis.length ? cfg.depositPercentBasis : ['rate'];
  const requireSecurityDeposit = !!cfg?.requireSecurityDeposit;
  const securityDepositAmount = requireSecurityDeposit ? Number(cfg?.securityDepositAmount || 0) : 0;

  let depositAmountDue = 0;
  if (requireDeposit && Number.isFinite(depositValue) && depositValue > 0) {
    if (depositMode === 'PERCENTAGE') {
      const ratePart = basis.includes('rate') ? Number(quote?.baseTotal || 0) : 0;
      const servicesPart = basis.includes('services') ? Math.max(0, Number(addOnsTotal || 0)) : 0;
      depositAmountDue = money((ratePart + servicesPart) * (depositValue / 100));
    } else {
      depositAmountDue = money(depositValue);
    }
  }

  return {
    required: requireDeposit,
    mode: requireDeposit ? depositMode : null,
    value: requireDeposit ? depositValue : null,
    amountDue: depositAmountDue,
    securityDepositRequired: requireSecurityDeposit || securityDepositAmount > 0,
    securityDepositAmount: securityDepositAmount > 0 ? money(securityDepositAmount) : 0
  };
}

function computeCarSharingQuote(listing, windows, pickupAt, returnAt) {
  const tripDays = ceilTripDays(pickupAt, returnAt);
  const tripStartDay = startOfUtcDay(pickupAt);
  const dayRates = [];

  for (let idx = 0; idx < tripDays; idx += 1) {
    const dayStart = addUtcDays(tripStartDay, idx);
    const dayEnd = addUtcDays(dayStart, 1);
    const overrideWindow = windows.find((window) =>
      window.priceOverride !== null
      && window.priceOverride !== undefined
      && overlap(new Date(window.startAt), new Date(window.endAt), dayStart, dayEnd)
    );
    dayRates.push(Number(overrideWindow?.priceOverride ?? listing.baseDailyRate ?? 0));
  }

  const subtotal = money(dayRates.reduce((sum, value) => sum + value, 0));
  const fees = money(Number(listing.cleaningFee || 0) + Number(listing.deliveryFee || 0));
  const taxes = 0;
  const total = money(subtotal + fees + taxes);
  const platformFee = money(subtotal * 0.15);
  const hostEarnings = money(total - platformFee);

  return { tripDays, subtotal, fees, taxes, total, platformFee, hostEarnings };
}

async function resolvePublicTenant({ tenantSlug, tenantId } = {}) {
  if (!tenantSlug && !tenantId) return null;
  return prisma.tenant.findFirst({
    where: {
      status: 'ACTIVE',
      ...(tenantSlug ? { slug: String(tenantSlug).trim() } : {}),
      ...(tenantId ? { id: String(tenantId).trim() } : {})
    }
  });
}

async function rentalAvailabilityCount({ tenantId, vehicleTypeId, pickupAt, returnAt }) {
  const vehicles = await prisma.vehicle.findMany({
    where: {
      tenantId,
      vehicleTypeId,
      fleetMode: { in: ['RENTAL_ONLY', 'BOTH'] },
      status: { notIn: ['IN_MAINTENANCE', 'OUT_OF_SERVICE'] }
    },
    select: { id: true }
  });

  if (!vehicles.length) return 0;

  const blockedReservations = await prisma.reservation.findMany({
    where: {
      tenantId,
      vehicleId: { in: vehicles.map((row) => row.id) },
      status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] },
      pickupAt: { lt: returnAt },
      returnAt: { gt: pickupAt }
    },
    select: { vehicleId: true }
  });

  const blocked = new Set(blockedReservations.map((row) => row.vehicleId).filter(Boolean));
  return vehicles.filter((row) => !blocked.has(row.id)).length;
}

export const bookingEngineService = {
  async getBootstrap({ tenantSlug, tenantId } = {}) {
    const tenant = await resolvePublicTenant({ tenantSlug, tenantId });

    if (!tenant) {
      const tenants = await prisma.tenant.findMany({
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          name: true,
          slug: true,
          carSharingEnabled: true
        },
        orderBy: [{ name: 'asc' }]
      });

      return {
        tenant: null,
        tenants,
        locations: [],
        vehicleTypes: [],
        featuredListings: [],
        bookingModes: {
          rental: true,
          carSharing: false
        }
      };
    }

    const [locations, vehicleTypes, featuredListings, tenants] = await Promise.all([
      prisma.location.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: { id: true, name: true, city: true, state: true, taxRate: true },
        orderBy: [{ name: 'asc' }]
      }),
      prisma.vehicleType.findMany({
        where: { tenantId: tenant.id },
        select: { id: true, code: true, name: true, description: true },
        orderBy: [{ name: 'asc' }]
      }),
      prisma.hostVehicleListing.findMany({
        where: { tenantId: tenant.id, status: 'PUBLISHED' },
        include: {
          hostProfile: { select: { id: true, displayName: true } },
          vehicle: { select: { id: true, make: true, model: true, year: true, color: true, plate: true } },
          location: { select: { id: true, name: true, city: true, state: true } }
        },
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        take: 8
      }),
      prisma.tenant.findMany({
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          name: true,
          slug: true,
          carSharingEnabled: true
        },
        orderBy: [{ name: 'asc' }]
      })
    ]);

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        carSharingEnabled: !!tenant.carSharingEnabled
      },
      tenants,
      locations,
      vehicleTypes,
      featuredListings: featuredListings.map((listing) => ({
        id: listing.id,
        slug: listing.slug,
        title: listing.title,
        shortDescription: listing.shortDescription,
        baseDailyRate: money(listing.baseDailyRate),
        cleaningFee: money(listing.cleaningFee),
        deliveryFee: money(listing.deliveryFee),
        instantBook: !!listing.instantBook,
        host: listing.hostProfile,
        vehicle: listing.vehicle,
        location: listing.location
      })),
      bookingModes: {
        rental: true,
        carSharing: !!tenant.carSharingEnabled
      }
    };
  },

  async searchRental({ tenantSlug, tenantId, pickupLocationId, pickupAt, returnAt }) {
    const tenant = await resolvePublicTenant({ tenantSlug, tenantId });
    if (!tenant) throw new Error('tenant is required');

    const pickupDate = toDate(pickupAt);
    const returnDate = toDate(returnAt);
    if (!pickupDate || !returnDate || pickupDate >= returnDate) {
      throw new Error('pickupAt and returnAt must be valid and returnAt must be after pickupAt');
    }
    if (!pickupLocationId) throw new Error('pickupLocationId is required');

    const [vehicleTypes, location] = await Promise.all([
      prisma.vehicleType.findMany({
        where: { tenantId: tenant.id },
        orderBy: [{ name: 'asc' }]
      }),
      prisma.location.findFirst({
        where: { id: String(pickupLocationId), tenantId: tenant.id, isActive: true },
        select: { id: true, name: true, city: true, state: true, taxRate: true, locationConfig: true }
      })
    ]);

    if (!location) throw new Error('Pickup location not found');

    const results = [];
    for (const vehicleType of vehicleTypes) {
      const [quote, availableUnits] = await Promise.all([
        ratesService.resolveForRental({
          vehicleTypeId: vehicleType.id,
          pickupLocationId: location.id,
          pickupAt: pickupDate.toISOString(),
          returnAt: returnDate.toISOString()
        }, { tenantId: tenant.id }, { displayOnline: true }),
        rentalAvailabilityCount({
          tenantId: tenant.id,
          vehicleTypeId: vehicleType.id,
          pickupAt: pickupDate,
          returnAt: returnDate
        })
      ]);

      if (!quote) continue;

      const taxes = money(Number(quote.baseTotal || 0) * (Number(location.taxRate || 0) / 100));
      const total = money(Number(quote.baseTotal || 0) + taxes);
      results.push({
        vehicleType: {
          id: vehicleType.id,
          code: vehicleType.code,
          name: vehicleType.name,
          description: vehicleType.description
        },
        availability: {
          availableUnits,
          available: availableUnits > 0
        },
        quote: {
          days: Number(quote.days || 0),
          dailyRate: money(quote.dailyRate),
          subtotal: money(quote.baseTotal),
          taxes,
          total,
          gracePeriodMin: Number(quote.gracePeriodMin || 0),
          source: quote.source || 'GLOBAL'
        },
        deposit: depositSnapshot({ location, quote })
      });
    }

    return {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      location,
      pickupAt: pickupDate,
      returnAt: returnDate,
      results
    };
  },

  async searchCarSharing({ tenantSlug, tenantId, pickupAt, returnAt, locationId }) {
    const tenant = await resolvePublicTenant({ tenantSlug, tenantId });
    if (!tenant) throw new Error('tenant is required');
    if (!tenant.carSharingEnabled) throw new Error('Car sharing is not enabled for this tenant');

    const pickupDate = toDate(pickupAt);
    const returnDate = toDate(returnAt);
    if (!pickupDate || !returnDate || pickupDate >= returnDate) {
      throw new Error('pickupAt and returnAt must be valid and returnAt must be after pickupAt');
    }

    const listings = await prisma.hostVehicleListing.findMany({
      where: {
        tenantId: tenant.id,
        status: 'PUBLISHED',
        ...(locationId ? { locationId: String(locationId) } : {})
      },
      include: {
        hostProfile: { select: { id: true, displayName: true } },
        vehicle: { select: { id: true, make: true, model: true, year: true, color: true, plate: true } },
        location: { select: { id: true, name: true, city: true, state: true } },
        availabilityWindows: { orderBy: [{ startAt: 'asc' }] }
      },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }]
    });

    const tripDays = ceilTripDays(pickupDate, returnDate);
    const results = listings.flatMap((listing) => {
      if (tripDays < Number(listing.minTripDays || 1)) return [];
      if (listing.maxTripDays && tripDays > Number(listing.maxTripDays)) return [];

      const overlappingWindows = (listing.availabilityWindows || []).filter((window) =>
        overlap(new Date(window.startAt), new Date(window.endAt), pickupDate, returnDate)
      );
      if (overlappingWindows.some((window) => !!window.isBlocked)) return [];
      if (overlappingWindows.some((window) => window.minTripDaysOverride && tripDays < Number(window.minTripDaysOverride))) return [];

      const quote = computeCarSharingQuote(listing, overlappingWindows, pickupDate, returnDate);
      return [{
        listing: {
          id: listing.id,
          slug: listing.slug,
          title: listing.title,
          shortDescription: listing.shortDescription,
          tripRules: listing.tripRules,
          instantBook: !!listing.instantBook,
          minTripDays: listing.minTripDays,
          maxTripDays: listing.maxTripDays,
          host: listing.hostProfile,
          vehicle: listing.vehicle,
          location: listing.location
        },
        quote
      }];
    });

    return {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      pickupAt: pickupDate,
      returnAt: returnDate,
      results
    };
  },

  async getListingDetail({ slug, tenantSlug, tenantId, pickupAt, returnAt }) {
    if (!slug) throw new Error('slug is required');
    const tenant = await resolvePublicTenant({ tenantSlug, tenantId });
    if (!tenant) throw new Error('tenant is required');
    if (!tenant.carSharingEnabled) throw new Error('Car sharing is not enabled for this tenant');

    const listing = await prisma.hostVehicleListing.findFirst({
      where: {
        tenantId: tenant.id,
        slug: String(slug).trim(),
        status: 'PUBLISHED'
      },
      include: {
        hostProfile: { select: { id: true, displayName: true, notes: true } },
        vehicle: { select: { id: true, make: true, model: true, year: true, color: true, plate: true } },
        location: { select: { id: true, name: true, city: true, state: true } },
        availabilityWindows: { orderBy: [{ startAt: 'asc' }] }
      }
    });

    if (!listing) throw new Error('Listing not found');

    const detail = {
      id: listing.id,
      slug: listing.slug,
      title: listing.title,
      shortDescription: listing.shortDescription,
      description: listing.description,
      baseDailyRate: money(listing.baseDailyRate),
      cleaningFee: money(listing.cleaningFee),
      deliveryFee: money(listing.deliveryFee),
      securityDeposit: money(listing.securityDeposit),
      instantBook: !!listing.instantBook,
      minTripDays: listing.minTripDays,
      maxTripDays: listing.maxTripDays,
      tripRules: listing.tripRules,
      host: listing.hostProfile,
      vehicle: listing.vehicle,
      location: listing.location
    };

    const pickupDate = toDate(pickupAt);
    const returnDate = toDate(returnAt);
    if (!pickupDate || !returnDate || pickupDate >= returnDate) {
      return { tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug }, listing: detail, quote: null };
    }

    const tripDays = ceilTripDays(pickupDate, returnDate);
    const overlappingWindows = (listing.availabilityWindows || []).filter((window) =>
      overlap(new Date(window.startAt), new Date(window.endAt), pickupDate, returnDate)
    );
    const blocked = overlappingWindows.some((window) => !!window.isBlocked);
    const invalidMinDays = overlappingWindows.some((window) => window.minTripDaysOverride && tripDays < Number(window.minTripDaysOverride));

    return {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      listing: detail,
      quote: blocked || invalidMinDays ? null : computeCarSharingQuote(listing, overlappingWindows, pickupDate, returnDate)
    };
  }
};
