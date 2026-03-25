import { bookingEngineService } from '../booking-engine/booking-engine.service.js';
import { issueCenterService } from '../issue-center/issue-center.service.js';
import { hostReviewsService } from '../host-reviews/host-reviews.service.js';
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

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
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
