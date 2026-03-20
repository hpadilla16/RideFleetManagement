import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { ratesService } from '../rates/rates.service.js';
import { reservationsService } from '../reservations/reservations.service.js';
import { carSharingService } from '../car-sharing/car-sharing.service.js';
import { sendEmail } from '../../lib/mailer.js';
import { settingsService } from '../settings/settings.service.js';

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

function parseJsonArray(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isServiceEligibleForVehicleType(service, vehicleTypeId) {
  if (!vehicleTypeId) return true;
  if (service?.allVehicleTypes) return true;
  const ids = parseJsonArray(service?.vehicleTypeIds).map(String);
  return ids.includes(String(vehicleTypeId));
}

function computeAdditionalServiceLine(service, days, quantityOverride) {
  const qty = Math.max(1, Number(quantityOverride ?? service?.defaultQty ?? 1) || 1);
  const perDay = Number(service?.dailyRate || 0);
  const rate = perDay > 0 ? perDay : Number(service?.rate || 0);
  const total = perDay > 0 ? perDay * days * qty : Number(service?.rate || 0) * qty;
  return {
    serviceId: service.id,
    code: service.code || null,
    name: service.name,
    description: service.description || '',
    chargeType: service.chargeType || 'UNIT',
    unitLabel: service.unitLabel || 'Unit',
    pricingMode: perDay > 0 ? 'PER_DAY' : 'FLAT',
    quantity: qty,
    rate: money(rate),
    total: money(total),
    taxable: !!service.taxable,
    mandatory: !!service.mandatory
  };
}

function generateReservationNumber(prefix = 'WEB') {
  return `${prefix}-${Date.now().toString().slice(-8)}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function customerName(customer) {
  return `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() || 'Customer';
}

async function upsertPublicCustomer(tenantId, input = {}) {
  const email = String(input?.email || '').trim().toLowerCase();
  const phone = String(input?.phone || '').trim();
  const firstName = String(input?.firstName || '').trim();
  const lastName = String(input?.lastName || '').trim();
  if (!firstName || !lastName || !email || !phone) {
    throw new Error('customer firstName, lastName, email, and phone are required');
  }

  const existing = await prisma.customer.findFirst({
    where: { tenantId, email },
    select: { id: true }
  });

  const payload = {
    tenantId,
    firstName,
    lastName,
    email,
    phone,
    dateOfBirth: input?.dateOfBirth ? new Date(input.dateOfBirth) : undefined,
    licenseNumber: input?.licenseNumber ? String(input.licenseNumber).trim() : undefined,
    licenseState: input?.licenseState ? String(input.licenseState).trim() : undefined,
    address1: input?.address1 ? String(input.address1).trim() : undefined,
    address2: input?.address2 ? String(input.address2).trim() : undefined,
    city: input?.city ? String(input.city).trim() : undefined,
    state: input?.state ? String(input.state).trim() : undefined,
    zip: input?.zip ? String(input.zip).trim() : undefined,
    country: input?.country ? String(input.country).trim() : undefined
  };

  if (existing) {
    return prisma.customer.update({
      where: { id: existing.id },
      data: payload
    });
  }

  return prisma.customer.create({ data: payload });
}

async function issueCustomerInfoRequest(reservation) {
  const fullReservation = await prisma.reservation.findUnique({
    where: { id: reservation.id },
    include: {
      customer: true,
      pickupLocation: true
    }
  });
  if (!fullReservation) throw new Error('Reservation not found after booking creation');

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
  const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
  const link = `${base.replace(/\/$/, '')}/customer/precheckin?token=${token}`;
  const note = `[PUBLIC BOOKING REQUEST CUSTOMER INFO ${new Date().toISOString()}] token issued`;
  await prisma.reservation.update({
    where: { id: fullReservation.id },
    data: {
      customerInfoToken: token,
      customerInfoTokenExpiresAt: expiresAt,
      notes: fullReservation.notes ? `${fullReservation.notes}\n${note}` : note
    }
  });

  let emailSent = false;
  let warning = null;
  if (fullReservation.customer?.email) {
    const tpl = await settingsService.getEmailTemplates({ tenantId: fullReservation.tenantId || null });
    const render = (value = '') => String(value)
      .replaceAll('{{customerName}}', customerName(fullReservation.customer))
      .replaceAll('{{reservationNumber}}', String(fullReservation.reservationNumber || ''))
      .replaceAll('{{link}}', link)
      .replaceAll('{{expiresAt}}', expiresAt.toISOString())
      .replaceAll('{{companyName}}', fullReservation.pickupLocation?.name || 'Ride Fleet');
    try {
      await sendEmail({
        to: fullReservation.customer.email,
        subject: render(tpl.requestCustomerInfoSubject),
        text: render(tpl.requestCustomerInfoBody),
        html: render(tpl.requestCustomerInfoHtml || String(tpl.requestCustomerInfoBody || '').replaceAll('\n', '<br/>'))
      });
      emailSent = true;
    } catch (mailError) {
      warning = `Unable to send customer information request email: ${String(mailError?.message || mailError)}`;
    }
  }

  return { link, expiresAt, emailSent, warning };
}

async function listPublicAdditionalServices({ tenantId, locationId, vehicleTypeId, days }) {
  const services = await prisma.additionalService.findMany({
    where: {
      tenantId,
      isActive: true,
      displayOnline: true,
      OR: [
        { locationId: null },
        ...(locationId ? [{ locationId }] : [])
      ]
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
  });

  return services
    .filter((service) => isServiceEligibleForVehicleType(service, vehicleTypeId))
    .map((service) => computeAdditionalServiceLine(service, days, service.defaultQty));
}

function computeInsuranceLine(plan, baseAmount, days) {
  const label = plan?.label || plan?.name || plan?.code || 'Insurance';
  const mode = String(plan?.chargeBy || plan?.mode || 'FIXED').toUpperCase();
  const amount = Number(plan?.amount || 0);
  let quantity = 1;
  let rate = amount;
  let total = amount;
  if (mode === 'PER_DAY') {
    quantity = Math.max(1, Number(days || 1));
    total = amount * quantity;
  } else if (mode === 'PERCENTAGE') {
    quantity = 1;
    total = Number(baseAmount || 0) * (amount / 100);
    rate = total;
  }
  return {
    code: String(plan?.code || '').trim(),
    name: label,
    description: plan?.description || '',
    chargeBy: mode,
    amount: money(amount),
    taxable: !!plan?.taxable,
    quantity,
    rate: money(rate),
    total: money(total)
  };
}

async function listPublicInsurancePlans({ tenantId, locationId, vehicleTypeId, baseAmount, days }) {
  const plans = await settingsService.getInsurancePlans({ tenantId });
  return (Array.isArray(plans) ? plans : [])
    .filter((plan) => {
      if (plan?.isActive === false) return false;
      const locationIds = Array.isArray(plan?.locationIds) ? plan.locationIds.map(String) : [];
      const vehicleTypeIds = Array.isArray(plan?.vehicleTypeIds) ? plan.vehicleTypeIds.map(String) : [];
      if (locationIds.length && locationId && !locationIds.includes(String(locationId))) return false;
      if (vehicleTypeIds.length && vehicleTypeId && !vehicleTypeIds.includes(String(vehicleTypeId))) return false;
      return true;
    })
    .map((plan) => computeInsuranceLine(plan, baseAmount, days));
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

    const rentalDays = ceilTripDays(pickupDate, returnDate);
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

      const [additionalServices, insurancePlans] = await Promise.all([
        listPublicAdditionalServices({
          tenantId: tenant.id,
          locationId: location.id,
          vehicleTypeId: vehicleType.id,
          days: rentalDays
        }),
        listPublicInsurancePlans({
          tenantId: tenant.id,
          locationId: location.id,
          vehicleTypeId: vehicleType.id,
          baseAmount: Number(quote.baseTotal || 0),
          days: rentalDays
        })
      ]);
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
        deposit: depositSnapshot({ location, quote }),
        additionalServices,
        insurancePlans
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
  },

  async createPublicBooking(input = {}) {
    const tenant = await resolvePublicTenant({
      tenantSlug: input?.tenantSlug,
      tenantId: input?.tenantId
    });
    if (!tenant) throw new Error('tenant is required');

    const searchType = String(input?.searchType || '').trim().toUpperCase();
    if (!['RENTAL', 'CAR_SHARING'].includes(searchType)) {
      throw new Error('searchType must be RENTAL or CAR_SHARING');
    }

    const customer = await upsertPublicCustomer(tenant.id, input?.customer || {});

    if (searchType === 'RENTAL') {
      const search = await this.searchRental({
        tenantId: tenant.id,
        pickupLocationId: input?.pickupLocationId,
        pickupAt: input?.pickupAt,
        returnAt: input?.returnAt
      });
      const selected = (search.results || []).find((row) => row.vehicleType?.id === String(input?.vehicleTypeId || ''));
      if (!selected) throw new Error('Selected rental vehicle type is no longer available');
      if (!selected.availability?.available) throw new Error('Selected rental vehicle type is sold out for those dates');
      const insuranceSelection = input?.insuranceSelection || {};
      const selectedInsuranceCode = String(insuranceSelection?.selectedPlanCode || '').trim();
      const selectedInsurancePlan = selectedInsuranceCode
        ? (selected.insurancePlans || []).find((plan) => String(plan.code || '').trim().toUpperCase() === selectedInsuranceCode.toUpperCase())
        : null;
      const declinedCoverage = !!insuranceSelection?.declinedCoverage;
      const usingOwnInsurance = !!insuranceSelection?.usingOwnInsurance;
      const liabilityAccepted = !!insuranceSelection?.liabilityAccepted;
      if (!selectedInsurancePlan) {
        if (!(declinedCoverage && usingOwnInsurance && liabilityAccepted)) {
          throw new Error('Select one of our insurance plans or accept responsibility and confirm you will use your own insurance');
        }
      }
      const requestedServices = Array.isArray(input?.additionalServices) ? input.additionalServices : [];
      const chosenServices = requestedServices
        .map((row) => {
          const serviceId = String(row?.serviceId || '').trim();
          const match = (selected.additionalServices || []).find((service) => service.serviceId === serviceId);
          if (!match) return null;
          return {
            ...match,
            quantity: Math.max(1, Number(row?.quantity ?? match.quantity ?? 1) || 1)
          };
        })
        .filter(Boolean);

      const normalizedChosenServices = chosenServices.map((service) => ({
        ...service,
        total: service.pricingMode === 'PER_DAY'
          ? money(Number(service.rate || 0) * Number(selected.quote?.days || 1) * Number(service.quantity || 1))
          : money(Number(service.rate || 0) * Number(service.quantity || 1))
      }));
      const insuranceLine = selectedInsurancePlan
        ? {
            ...selectedInsurancePlan,
            source: 'INSURANCE',
            sourceRefId: selectedInsurancePlan.code
          }
        : null;
      const insuranceTotal = money(Number(insuranceLine?.total || 0));
      const addOnsTotal = money(normalizedChosenServices.reduce((sum, service) => sum + Number(service.total || 0), 0));
      const estimatedTotal = money(Number(selected.quote.total || 0) + addOnsTotal + insuranceTotal);

      const reservation = await reservationsService.create({
        reservationNumber: generateReservationNumber('WEB'),
        sourceRef: `PUBLICBOOK:${crypto.randomBytes(8).toString('hex')}`,
        status: selected.deposit?.required ? 'NEW' : 'CONFIRMED',
        customerId: customer.id,
        vehicleTypeId: selected.vehicleType.id,
        pickupAt: input.pickupAt,
        returnAt: input.returnAt,
        pickupLocationId: input.pickupLocationId,
        returnLocationId: input.returnLocationId || input.pickupLocationId,
        dailyRate: selected.quote.dailyRate,
        estimatedTotal,
        paymentStatus: 'PENDING',
        sendConfirmationEmail: false,
        notes: '[PUBLIC BOOKING] Created from booking web'
      }, { tenantId: tenant.id });

      await prisma.reservationPricingSnapshot.upsert({
        where: { reservationId: reservation.id },
        create: {
          reservationId: reservation.id,
          dailyRate: selected.quote.dailyRate,
          taxRate: Number(search.location?.taxRate || 0),
          selectedInsuranceCode: insuranceLine?.code || null,
          selectedInsuranceName: insuranceLine?.name || null,
          depositRequired: !!selected.deposit?.required,
          depositMode: selected.deposit?.mode || null,
          depositValue: selected.deposit?.value ?? null,
          depositAmountDue: selected.deposit?.amountDue ?? 0,
          securityDepositRequired: !!selected.deposit?.securityDepositRequired,
          securityDepositAmount: selected.deposit?.securityDepositAmount ?? 0,
          source: 'PUBLIC_BOOKING'
        },
        update: {
          dailyRate: selected.quote.dailyRate,
          taxRate: Number(search.location?.taxRate || 0),
          selectedInsuranceCode: insuranceLine?.code || null,
          selectedInsuranceName: insuranceLine?.name || null,
          depositRequired: !!selected.deposit?.required,
          depositMode: selected.deposit?.mode || null,
          depositValue: selected.deposit?.value ?? null,
          depositAmountDue: selected.deposit?.amountDue ?? 0,
          securityDepositRequired: !!selected.deposit?.securityDepositRequired,
          securityDepositAmount: selected.deposit?.securityDepositAmount ?? 0,
          source: 'PUBLIC_BOOKING'
        }
      });

      if (normalizedChosenServices.length || insuranceLine) {
        await prisma.reservationCharge.createMany({
          data: [
            ...normalizedChosenServices.map((service, idx) => ({
              reservationId: reservation.id,
              code: service.code,
              name: service.name,
              chargeType: service.chargeType || 'UNIT',
              quantity: Number(service.quantity || 1),
              rate: Number(service.rate || 0),
              total: Number(service.total || 0),
              taxable: !!service.taxable,
              selected: true,
              sortOrder: idx,
              source: 'ADDITIONAL_SERVICE',
              sourceRefId: service.serviceId
            })),
            ...(insuranceLine ? [{
              reservationId: reservation.id,
              code: insuranceLine.code,
              name: `Insurance: ${insuranceLine.name}`,
              chargeType: 'UNIT',
              quantity: Number(insuranceLine.quantity || 1),
              rate: Number(insuranceLine.rate || 0),
              total: Number(insuranceLine.total || 0),
              taxable: !!insuranceLine.taxable,
              selected: true,
              sortOrder: normalizedChosenServices.length,
              source: 'INSURANCE',
              sourceRefId: insuranceLine.code
            }] : [])
          ]
        });
      }

      if (!insuranceLine && (declinedCoverage || usingOwnInsurance || liabilityAccepted)) {
        const waiverNote = `[PUBLIC BOOKING INSURANCE WAIVER ${new Date().toISOString()}] Customer declined house insurance, confirmed use of their own insurance, and accepted responsibility/liability.${insuranceSelection?.ownPolicyNumber ? ` Policy: ${String(insuranceSelection.ownPolicyNumber).trim()}` : ''}`;
        await prisma.reservation.update({
          where: { id: reservation.id },
          data: {
            notes: reservation.notes ? `${reservation.notes}\n${waiverNote}` : waiverNote
          }
        });
        await prisma.customer.update({
          where: { id: customer.id },
          data: {
            insurancePolicyNumber: insuranceSelection?.ownPolicyNumber ? String(insuranceSelection.ownPolicyNumber).trim() : undefined
          }
        });
      }

      const nextActions = await issueCustomerInfoRequest(reservation);
      return {
        bookingType: 'RENTAL',
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        customer: {
          id: customer.id,
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          phone: customer.phone
        },
        reservation: {
          id: reservation.id,
          reservationNumber: reservation.reservationNumber,
          status: reservation.status,
          estimatedTotal: estimatedTotal,
          pickupAt: reservation.pickupAt,
          returnAt: reservation.returnAt
        },
        additionalServices: normalizedChosenServices,
        insuranceSelection: insuranceLine
          ? {
              type: 'PLAN',
              code: insuranceLine.code,
              name: insuranceLine.name,
              total: insuranceLine.total
            }
          : {
              type: 'OWN_POLICY',
              ownPolicyNumber: insuranceSelection?.ownPolicyNumber ? String(insuranceSelection.ownPolicyNumber).trim() : ''
            },
        nextActions
      };
    }

    const trip = await carSharingService.createTrip({
      tenantId: tenant.id,
      listingId: input?.listingId,
      guestCustomerId: customer.id,
      scheduledPickupAt: input?.pickupAt,
      scheduledReturnAt: input?.returnAt,
      pickupLocationId: input?.pickupLocationId || null,
      returnLocationId: input?.returnLocationId || input?.pickupLocationId || null,
      notes: '[PUBLIC BOOKING] Created from booking web'
    }, { tenantId: tenant.id });

    const nextActions = trip?.reservation
      ? await issueCustomerInfoRequest(trip.reservation)
      : { link: '', expiresAt: null, emailSent: false, warning: 'Trip created without linked reservation workflow' };

    return {
      bookingType: 'CAR_SHARING',
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      customer: {
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone
      },
      trip: {
        id: trip.id,
        tripCode: trip.tripCode,
        status: trip.status,
        quotedTotal: money(trip.quotedTotal),
        hostEarnings: money(trip.hostEarnings),
        platformFee: money(trip.platformFee)
      },
      reservation: trip?.reservation ? {
        id: trip.reservation.id,
        reservationNumber: trip.reservation.reservationNumber,
        status: trip.reservation.status
      } : null,
      nextActions
    };
  }
};
