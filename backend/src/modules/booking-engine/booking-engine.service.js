import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { ratesService } from '../rates/rates.service.js';
import { reservationsService } from '../reservations/reservations.service.js';
import { carSharingService } from '../car-sharing/car-sharing.service.js';
import { sendEmail } from '../../lib/mailer.js';
import { settingsService } from '../settings/settings.service.js';
import { computeMarketplaceTripPricing } from '../car-sharing/car-sharing-pricing.js';
import { serializePublicTripFulfillmentPlan } from '../car-sharing/car-sharing-handoff.js';
import { activeVehicleBlockOverlapWhere } from '../vehicles/vehicle-blocks.js';
import {
  compareCarSharingSearchResults,
  resolveListingSearchMatch,
  serializeCarSharingSearchPlace,
  serializePublicPickupSpot
} from './car-sharing-discovery.js';

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

function ratingNumber(value) {
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

function normalizePhotoList(value, limit = 6) {
  return parseJsonArray(value)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeHostAddOns(value) {
  return parseJsonArray(value)
    .map((item, index) => {
      const name = String(item?.name || '').trim();
      const description = String(item?.description || '').trim();
      const rate = money(item?.price || 0);
      if (!name || rate <= 0) return null;
      return {
        serviceId: String(item?.id || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'addon'}-${index + 1}`),
        code: null,
        name,
        description,
        chargeType: 'UNIT',
        unitLabel: 'Unit',
        pricingMode: 'FLAT',
        quantity: 1,
        rate,
        total: rate,
        taxable: false,
        mandatory: false,
        source: 'HOST_ADDON'
      };
    })
    .filter(Boolean);
}

function countHostAddOns(value) {
  return normalizeHostAddOns(value).length;
}

function normalizeDeliveryAreas(value) {
  return parseJsonArray(value)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

function countListingPhotos(value) {
  return normalizePhotoList(value).length;
}

function roundScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0))));
}

function pct(part, total) {
  if (!total) return 0;
  return Number(((Number(part || 0) / Number(total || 1)) * 100).toFixed(2));
}

function buildListingTrustSignals(trips = []) {
  const recentTrips = Array.isArray(trips) ? trips.slice(0, 12) : [];
  const completedTrips = recentTrips.filter((trip) => String(trip?.status || '').toUpperCase() === 'COMPLETED');
  const cancelledTrips = recentTrips.filter((trip) => String(trip?.status || '').toUpperCase() === 'CANCELLED');
  const confirmedHandoffTrips = recentTrips.filter((trip) => !!trip?.fulfillmentPlan?.confirmedAt);
  const reviewedTrips = recentTrips.filter((trip) => !!trip?.hostReview?.submittedAt);
  const onTimePickupTrips = recentTrips.filter((trip) => {
    const scheduled = trip?.scheduledPickupAt ? new Date(trip.scheduledPickupAt) : null;
    const actual = trip?.actualPickupAt ? new Date(trip.actualPickupAt) : null;
    if (!scheduled || !actual || Number.isNaN(scheduled.getTime()) || Number.isNaN(actual.getTime())) return false;
    return Math.abs(actual.getTime() - scheduled.getTime()) <= (90 * 60 * 1000);
  });

  return {
    tripCount: recentTrips.length,
    completedTripCount: completedTrips.length,
    cancelledTripCount: cancelledTrips.length,
    confirmedHandoffCount: confirmedHandoffTrips.length,
    reviewedTripCount: reviewedTrips.length,
    onTimePickupCount: onTimePickupTrips.length,
    completionRatePct: pct(completedTrips.length, recentTrips.length),
    cancellationRatePct: pct(cancelledTrips.length, recentTrips.length),
    handoffConfirmationRatePct: pct(confirmedHandoffTrips.length, recentTrips.length),
    pickupReliabilityPct: pct(onTimePickupTrips.length, completedTrips.length || recentTrips.length)
  };
}

function buildCarSharingTrustSummary({ listing, searchMatch, trustSignals = null } = {}) {
  const rating = Number(listing?.hostProfile?.averageRating || 0);
  const reviewCount = Number(listing?.hostProfile?.reviewCount || 0);
  const photoCount = countListingPhotos(listing?.photosJson);
  const addOnCount = countHostAddOns(listing?.addOnsJson);
  const fulfillmentMode = String(listing?.fulfillmentMode || 'PICKUP_ONLY').trim().toUpperCase();
  const exactVisible = String(searchMatch?.visibilityMode || 'REVEAL_AFTER_BOOKING').trim().toUpperCase() === 'PUBLIC_EXACT';
  const exactMatch = ['HOST_PICKUP_SPOT_EXACT', 'DELIVERY_ZONE_EXACT', 'TENANT_BRANCH'].includes(String(searchMatch?.matchReasonCode || '').trim().toUpperCase());
  const signals = trustSignals || buildListingTrustSignals([]);

  let score = 30;
  if (listing?.instantBook) score += 15;
  score += Math.min(25, rating * 5);
  score += Math.min(12, reviewCount >= 1 ? (Math.log10(reviewCount + 1) * 10) : 0);
  if (photoCount >= 5) score += 12;
  else if (photoCount >= 3) score += 8;
  else if (photoCount >= 1) score += 4;
  if (addOnCount >= 3) score += 5;
  else if (addOnCount >= 1) score += 3;
  if (fulfillmentMode === 'PICKUP_OR_DELIVERY') score += 6;
  else if (fulfillmentMode === 'DELIVERY_ONLY') score += 4;
  if (exactVisible) score += 5;
  if (exactMatch) score += 5;
  score += Math.min(10, (signals.completionRatePct || 0) / 10);
  score += Math.min(8, (signals.handoffConfirmationRatePct || 0) / 12.5);
  score += Math.min(8, (signals.pickupReliabilityPct || 0) / 12.5);
  score -= Math.min(10, (signals.cancellationRatePct || 0) / 8);

  const normalizedScore = roundScore(score);
  const reasons = [];
  if (listing?.instantBook) reasons.push('Instant book ready');
  if (reviewCount >= 10) reasons.push('Strong review history');
  else if (reviewCount >= 3) reasons.push('Reviewed host');
  if (rating >= 4.8 && reviewCount) reasons.push('Top-rated host');
  else if (rating >= 4.5 && reviewCount) reasons.push('Highly rated host');
  if (photoCount >= 5) reasons.push('Rich photo gallery');
  else if (photoCount >= 3) reasons.push('Solid photo coverage');
  if (addOnCount >= 1) reasons.push('Trip add-ons available');
  if (fulfillmentMode === 'PICKUP_OR_DELIVERY') reasons.push('Flexible pickup or delivery');
  if (exactVisible) reasons.push('Exact handoff visible');
  if (signals.tripCount >= 3 && signals.completionRatePct >= 80) reasons.push('Strong trip completion history');
  if (signals.tripCount >= 3 && signals.handoffConfirmationRatePct >= 70) reasons.push('Reliable handoff release');
  if (signals.completedTripCount >= 2 && signals.pickupReliabilityPct >= 70) reasons.push('Pickup timing looks reliable');
  if (searchMatch?.recommendedBadge) reasons.push(searchMatch.recommendedBadge);

  let badge = 'Hosted match';
  if (normalizedScore >= 90) badge = 'Top match';
  else if (normalizedScore >= 80) badge = 'Trusted match';
  else if (normalizedScore >= 70) badge = 'Strong host match';
  else if (normalizedScore >= 60) badge = 'Solid host option';

  return {
    score: normalizedScore,
    badge,
    photoCount,
    addOnCount,
    tripSignals: signals,
    reasons: Array.from(new Set(reasons)).slice(0, 5)
  };
}

function bookingImageSet({ vehicleTypeImageUrl, listingPhotos }) {
  const photos = normalizePhotoList(listingPhotos);
  if (photos.length) {
    return {
      primaryImageUrl: photos[0],
      imageUrls: photos
    };
  }
  return {
    primaryImageUrl: vehicleTypeImageUrl ? String(vehicleTypeImageUrl).trim() : '',
    imageUrls: vehicleTypeImageUrl ? [String(vehicleTypeImageUrl).trim()] : []
  };
}

function publicHostSelect() {
  return {
    id: true,
    displayName: true,
    averageRating: true,
    reviewCount: true,
    createdAt: true
  };
}

function publicHostSummary(hostProfile) {
  if (!hostProfile) return null;
  return {
    id: hostProfile.id,
    displayName: hostProfile.displayName,
    averageRating: ratingNumber(hostProfile.averageRating),
    reviewCount: Number(hostProfile.reviewCount || 0),
    createdAt: hostProfile.createdAt || null
  };
}

function publicSearchPlaceWhere({ directTenant = null } = {}) {
  return {
    searchable: true,
    isActive: true,
    approvalStatus: 'APPROVED',
    tenant: {
      status: 'ACTIVE',
      ...(directTenant ? { id: directTenant.id } : { carSharingEnabled: true })
    }
  };
}

async function listPublicCarSharingSearchPlaces({ directTenant = null, take = 100 } = {}) {
  const rows = await prisma.carSharingSearchPlace.findMany({
    where: publicSearchPlaceWhere({ directTenant }),
    include: {
      anchorLocation: { select: { id: true, name: true, city: true, state: true } }
    },
    orderBy: [{ publicLabel: 'asc' }, { label: 'asc' }],
    take
  });
  return rows.map((row) => serializeCarSharingSearchPlace(row));
}

async function resolveCarSharingSearchScope({ directTenant = null, requestedIds = [], searchPlaceIds = [] } = {}) {
  const normalizedRequestedIds = Array.from(new Set([
    ...(Array.isArray(requestedIds) ? requestedIds : []).map((value) => String(value)).filter(Boolean),
    ...(Array.isArray(searchPlaceIds) ? searchPlaceIds : []).map((value) => String(value)).filter(Boolean)
  ]));

  const locationWhere = {
    id: { in: normalizedRequestedIds },
    isActive: true,
    tenant: {
      status: 'ACTIVE',
      ...(directTenant ? { id: directTenant.id } : { carSharingEnabled: true })
    }
  };

  const explicitSearchPlaceWhere = {
    id: { in: normalizedRequestedIds },
    ...publicSearchPlaceWhere({ directTenant })
  };

  const [matchedLocations, explicitSearchPlaces] = await Promise.all([
    normalizedRequestedIds.length
      ? prisma.location.findMany({
          where: locationWhere,
          select: { id: true, tenantId: true, name: true, city: true, state: true }
        })
      : Promise.resolve([]),
    normalizedRequestedIds.length
      ? prisma.carSharingSearchPlace.findMany({
          where: explicitSearchPlaceWhere,
          include: {
            anchorLocation: { select: { id: true, name: true, city: true, state: true } }
          }
        })
      : Promise.resolve([])
  ]);

  const anchorLocationIds = matchedLocations.map((row) => String(row.id));
  const anchoredSearchPlaces = anchorLocationIds.length
    ? await prisma.carSharingSearchPlace.findMany({
        where: {
          anchorLocationId: { in: anchorLocationIds },
          ...publicSearchPlaceWhere({ directTenant })
        },
        include: {
          anchorLocation: { select: { id: true, name: true, city: true, state: true } }
        }
      })
    : [];

  const searchPlaceMap = new Map();
  [...explicitSearchPlaces, ...anchoredSearchPlaces].forEach((place) => {
    if (place?.id) searchPlaceMap.set(String(place.id), place);
  });

  return {
    matchedLocations,
    resolvedSearchPlaces: Array.from(searchPlaceMap.values()),
    requestedIds: normalizedRequestedIds
  };
}

function serializeListingSearchSummary(match) {
  if (!match) return null;
  return {
    searchPlace: match.searchPlaceSummary || null,
    searchPlaceType: match.searchPlaceType || match.searchPlaceSummary?.placeType || 'HOST_PICKUP_SPOT',
    matchReason: match.matchReason || 'Available in this area',
    matchReasonCode: match.matchReasonCode || null,
    recommendedBadge: match.recommendedBadge || '',
    rankingReasons: Array.isArray(match.rankingReasons) ? match.rankingReasons : [],
    visibilityMode: match.visibilityMode || 'REVEAL_AFTER_BOOKING',
    exactLocationHidden: !!match.exactLocationHidden,
    availableFulfillmentChoices: Array.isArray(match.availableFulfillmentChoices)
      ? match.availableFulfillmentChoices
      : ['PICKUP']
  };
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
    mandatory: !!service.mandatory,
    linkedFee: service?.linkedFee ? {
      feeId: service.linkedFee.id,
      code: service.linkedFee.code || null,
      name: service.linkedFee.name,
      description: service.linkedFee.description || '',
      mode: String(service.linkedFee.mode || 'FIXED').toUpperCase(),
      amount: money(service.linkedFee.amount),
      taxable: !!service.linkedFee.taxable
    } : null
  };
}

function computeLinkedFeeLineForService(service, fee, { baseAmount = 0, days = 1 } = {}) {
  if (!service?.serviceId || !fee?.id) return null;
  const normalizedFee = computePublicFeeLine(fee, baseAmount, days);
  return {
    ...normalizedFee,
    source: 'SERVICE_LINKED_FEE',
    serviceId: service.serviceId,
    serviceCode: service.code || null,
    serviceName: service.name || 'Additional service',
    name: `${normalizedFee.name} | ${service.name || 'Service'}`
  };
}

function computePublicFeeLine(fee, baseAmount, days) {
  const amount = Number(fee?.amount || 0);
  const mode = String(fee?.mode || 'FIXED').toUpperCase();
  const total = mode === 'PERCENTAGE'
    ? Number((Number(baseAmount || 0) * (amount / 100)).toFixed(2))
    : mode === 'PER_DAY'
      ? Number((amount * Math.max(1, Number(days || 1))).toFixed(2))
      : Number(amount.toFixed(2));
  return {
    feeId: fee.id,
    code: fee.code || null,
    name: fee.name,
    description: fee.description || '',
    mode,
    amount: money(amount),
    total: money(total),
    taxable: !!fee.taxable,
    mandatory: !!fee.mandatory
  };
}

async function listMandatoryFeesForLocation({ tenantId, locationId, baseAmount, days }) {
  if (!tenantId || !locationId) return [];
  const location = await prisma.location.findFirst({
    where: { id: String(locationId), tenantId: String(tenantId) },
    include: {
      locationFees: {
        include: {
          fee: true
        }
      }
    }
  });
  return (location?.locationFees || [])
    .map((row) => row.fee)
    .filter((fee) => fee?.isActive && fee?.mandatory)
    .map((fee) => computePublicFeeLine(fee, baseAmount, days));
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

function portalPathForKind(kind) {
  if (kind === 'signature') return '/customer/sign-agreement';
  if (kind === 'payment') return '/customer/pay';
  return '/customer/precheckin';
}

function noteLabelForKind(kind) {
  if (kind === 'signature') return 'REQUEST SIGNATURE';
  if (kind === 'payment') return 'REQUEST PAYMENT';
  return 'REQUEST CUSTOMER INFO';
}

function tokenFieldMap(kind) {
  if (kind === 'signature') {
    return { tokenField: 'signatureToken', expiresField: 'signatureTokenExpiresAt' };
  }
  if (kind === 'payment') {
    return { tokenField: 'paymentRequestToken', expiresField: 'paymentRequestTokenExpiresAt' };
  }
  return { tokenField: 'customerInfoToken', expiresField: 'customerInfoTokenExpiresAt' };
}

async function issuePortalRequest(kind, reservation, { sendEmailToCustomer = false } = {}) {
  const fullReservation = await prisma.reservation.findUnique({
    where: { id: reservation.id },
    include: {
      customer: true,
      pickupLocation: true
    }
  });
  if (!fullReservation) throw new Error('Reservation not found after booking creation');

  const { tokenField, expiresField } = tokenFieldMap(kind);
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
  const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
  const link = `${base.replace(/\/$/, '')}${portalPathForKind(kind)}?token=${token}`;
  const note = `[PUBLIC BOOKING ${noteLabelForKind(kind)} ${new Date().toISOString()}] token issued`;
  await prisma.reservation.update({
    where: { id: fullReservation.id },
    data: {
      [tokenField]: token,
      [expiresField]: expiresAt,
      notes: fullReservation.notes ? `${fullReservation.notes}\n${note}` : note
    }
  });

  let emailSent = false;
  let warning = null;
  if (sendEmailToCustomer && fullReservation.customer?.email) {
    const tpl = await settingsService.getEmailTemplates({ tenantId: fullReservation.tenantId || null });
    const render = (value = '') => String(value)
      .replaceAll('{{customerName}}', customerName(fullReservation.customer))
      .replaceAll('{{reservationNumber}}', String(fullReservation.reservationNumber || ''))
      .replaceAll('{{link}}', link)
      .replaceAll('{{expiresAt}}', expiresAt.toISOString())
      .replaceAll('{{companyName}}', fullReservation.pickupLocation?.name || 'Ride Fleet');
    const subjectTpl = kind === 'signature'
      ? tpl.requestSignatureSubject
      : kind === 'payment'
        ? tpl.requestPaymentSubject
        : tpl.requestCustomerInfoSubject;
    const bodyTpl = kind === 'signature'
      ? tpl.requestSignatureBody
      : kind === 'payment'
        ? tpl.requestPaymentBody
        : tpl.requestCustomerInfoBody;
    const htmlTpl = kind === 'signature'
      ? tpl.requestSignatureHtml
      : kind === 'payment'
        ? tpl.requestPaymentHtml
        : tpl.requestCustomerInfoHtml;
    try {
      await sendEmail({
        to: fullReservation.customer.email,
        subject: render(subjectTpl),
        text: render(bodyTpl),
        html: render(htmlTpl || String(bodyTpl || '').replaceAll('\n', '<br/>'))
      });
      emailSent = true;
    } catch (mailError) {
      warning = `Unable to send ${kind} request email: ${String(mailError?.message || mailError)}`;
    }
  }

  return { kind, link, expiresAt, emailSent, warning };
}

async function issueCustomerInfoRequest(reservation) {
  return issuePortalRequest('customer-info', reservation, { sendEmailToCustomer: true });
}

function displayDateTime(value) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleString();
}

function renderTemplateString(value = '', replacements = {}) {
  return Object.entries(replacements).reduce(
    (out, [key, replacement]) => out.replaceAll(`{{${key}}}`, String(replacement ?? '')),
    String(value || '')
  );
}

async function sendPublicBookingConfirmationEmail({
  reservation,
  customer,
  tenant,
  pricingBreakdown = {},
  nextActions = {},
  bookingType = 'RENTAL',
  trip = null,
  vehicleLabel = ''
} = {}) {
  if (!reservation?.id || !customer?.email) {
    return {
      emailSent: false,
      sentTo: [],
      warning: 'No customer email found for booking confirmation'
    };
  }

  const fullReservation = await prisma.reservation.findUnique({
    where: { id: reservation.id },
    include: {
      customer: true,
      pickupLocation: true,
      returnLocation: true,
      vehicle: true,
      vehicleType: true
    }
  });

  if (!fullReservation) {
    return {
      emailSent: false,
      sentTo: [],
      warning: 'Reservation not found for booking confirmation email'
    };
  }

  const guestName = customerName(fullReservation.customer || customer);
  const reference = trip?.tripCode || fullReservation.reservationNumber || reservation.reservationNumber || '-';
  const resolvedVehicleLabel = vehicleLabel
    || [
      fullReservation.vehicle?.year || '',
      fullReservation.vehicle?.make || '',
      fullReservation.vehicle?.model || ''
    ].filter(Boolean).join(' ')
    || fullReservation.vehicleType?.name
    || 'Vehicle';
  const dueNow = money(
    pricingBreakdown?.dueNow
    ?? pricingBreakdown?.depositDueNow
    ?? pricingBreakdown?.depositDue
    ?? pricingBreakdown?.amountDueNow
    ?? reservation?.amountDueNow
    ?? trip?.amountDueNow
    ?? 0
  );
  const estimatedTotal = money(
    pricingBreakdown?.guestTotal
    ?? pricingBreakdown?.reservationEstimate
    ?? pricingBreakdown?.estimatedTotal
    ?? reservation?.estimatedTotal
    ?? trip?.quotedTotal
    ?? 0
  );

  const replacements = {
    customerName: guestName,
    reservationNumber: String(fullReservation.reservationNumber || reservation?.reservationNumber || ''),
    tripCode: String(trip?.tripCode || ''),
    reference,
    bookingType: String(bookingType || 'RENTAL'),
    status: String(trip?.status || fullReservation.status || reservation?.status || '-'),
    pickupAt: displayDateTime(fullReservation.pickupAt || reservation?.pickupAt),
    returnAt: displayDateTime(fullReservation.returnAt || reservation?.returnAt),
    pickupLocation: fullReservation.pickupLocation?.name || '-',
    returnLocation: fullReservation.returnLocation?.name || '-',
    vehicle: resolvedVehicleLabel,
    dailyRate: reservation?.dailyRate != null ? `$${Number(reservation.dailyRate).toFixed(2)}` : '-',
    estimatedTotal: `$${estimatedTotal.toFixed(2)}`,
    dueNow: `$${dueNow.toFixed(2)}`,
    companyName: tenant?.name || fullReservation.pickupLocation?.name || 'Ride Fleet',
    customerInfoLink: nextActions?.customerInfo?.link || '',
    signatureLink: nextActions?.signature?.link || '',
    paymentLink: nextActions?.payment?.link || ''
  };

  const tpl = await settingsService.getEmailTemplates({ tenantId: fullReservation.tenantId || null });
  const subject = renderTemplateString(
    tpl.reservationDetailSubject || 'Reservation Details - {{reservationNumber}}',
    replacements
  );
  const baseText = renderTemplateString(
    tpl.reservationDetailBody || 'Hello {{customerName}},\n\nReservation #: {{reservationNumber}}',
    replacements
  );
  const baseHtml = renderTemplateString(
    tpl.reservationDetailHtml || String(baseText).replaceAll('\n', '<br/>'),
    replacements
  );

  const nextStepLines = [
    '',
    'Next steps:',
    nextActions?.customerInfo?.link ? `Complete customer info: ${nextActions.customerInfo.link}` : null,
    nextActions?.signature?.link ? `Open agreement signature: ${nextActions.signature.link}` : null,
    nextActions?.payment?.link ? `Pay now: ${nextActions.payment.link}` : null,
    '',
    dueNow > 0 ? `Amount due now: $${dueNow.toFixed(2)}` : 'No payment is due right now.'
  ].filter(Boolean);

  const nextStepHtml = `
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid #e5e7eb">
      <div style="font-weight:700;margin-bottom:8px">Next steps</div>
      ${nextActions?.customerInfo?.link ? `<div style="margin-bottom:6px">Complete customer info: <a href="${nextActions.customerInfo.link}">${nextActions.customerInfo.link}</a></div>` : ''}
      ${nextActions?.signature?.link ? `<div style="margin-bottom:6px">Open agreement signature: <a href="${nextActions.signature.link}">${nextActions.signature.link}</a></div>` : ''}
      ${nextActions?.payment?.link ? `<div style="margin-bottom:6px">Pay now: <a href="${nextActions.payment.link}">${nextActions.payment.link}</a></div>` : ''}
      <div style="margin-top:10px">${dueNow > 0 ? `Amount due now: <strong>$${dueNow.toFixed(2)}</strong>` : 'No payment is due right now.'}</div>
    </div>
  `;

  try {
    await sendEmail({
      to: customer.email,
      subject,
      text: [baseText, ...nextStepLines].join('\n'),
      html: `${baseHtml}${nextStepHtml}`
    });
    const note = `[PUBLIC BOOKING CONFIRMATION EMAIL ${new Date().toISOString()}] emailed to ${customer.email}`;
    await prisma.reservation.update({
      where: { id: fullReservation.id },
      data: {
        notes: fullReservation.notes ? `${fullReservation.notes}\n${note}` : note
      }
    });
    return {
      emailSent: true,
      sentTo: [customer.email],
      warning: null
    };
  } catch (mailError) {
    const warning = `Unable to send reservation confirmation email: ${String(mailError?.message || mailError)}`;
    return {
      emailSent: false,
      sentTo: [customer.email],
      warning
    };
  }
}

function existingPortalAction(kind, reservation) {
  const { tokenField, expiresField } = tokenFieldMap(kind);
  const token = reservation?.[tokenField];
  const expiresAt = reservation?.[expiresField];
  if (!token || !expiresAt) return null;
  const expiresDate = new Date(expiresAt);
  if (Number.isNaN(expiresDate.getTime()) || expiresDate.getTime() <= Date.now()) return null;
  const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
  return {
    kind,
    link: `${base.replace(/\/$/, '')}${portalPathForKind(kind)}?token=${token}`,
    expiresAt: expiresDate,
    emailSent: false,
    warning: null
  };
}

async function ensurePortalRequest(kind, reservation) {
  return existingPortalAction(kind, reservation) || issuePortalRequest(kind, reservation);
}

function existingHostReviewAction(review) {
  if (!review?.publicToken) return null;
  const expiresAt = review.publicTokenExpiresAt ? new Date(review.publicTokenExpiresAt) : null;
  if (review.status !== 'SUBMITTED' && (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    return null;
  }
  const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
  return {
    kind: 'host-review',
    link: `${base.replace(/\/$/, '')}/host-review?token=${review.publicToken}`,
    expiresAt,
    completed: review.status === 'SUBMITTED'
  };
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
    include: {
      linkedFee: true
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

  const subtotal = dayRates.reduce((sum, value) => sum + value, 0);
  const fulfillmentMode = String(listing.fulfillmentMode || 'PICKUP_ONLY').toUpperCase();
  const defaultChoice = fulfillmentMode === 'DELIVERY_ONLY' ? 'DELIVERY' : 'PICKUP';
  const pickupPricing = fulfillmentMode === 'DELIVERY_ONLY'
    ? null
    : computeMarketplaceTripPricing({
        subtotal,
        cleaningFee: Number(listing.cleaningFee || 0),
        pickupFee: Number(listing.pickupFee || 0),
        deliveryFee: Number(listing.deliveryFee || 0),
        fulfillmentChoice: 'PICKUP',
        taxes: 0,
        hostProfile: listing.hostProfile
      });
  const deliveryPricing = fulfillmentMode === 'PICKUP_ONLY'
    ? null
    : computeMarketplaceTripPricing({
        subtotal,
        cleaningFee: Number(listing.cleaningFee || 0),
        pickupFee: Number(listing.pickupFee || 0),
        deliveryFee: Number(listing.deliveryFee || 0),
        fulfillmentChoice: 'DELIVERY',
        taxes: 0,
        hostProfile: listing.hostProfile
      });
  const pricing = (defaultChoice === 'DELIVERY' ? deliveryPricing : pickupPricing) || pickupPricing || deliveryPricing;

  return {
    tripDays,
    subtotal: pricing.tripSubtotal,
    pickupFee: money(listing.pickupFee || 0),
    deliveryFee: money(listing.deliveryFee || 0),
    pickupTotal: money(pickupPricing?.quotedTotal || 0),
    deliveryTotal: money(deliveryPricing?.quotedTotal || 0),
    pickupGuestTripFee: money(pickupPricing?.guestTripFee || 0),
    deliveryGuestTripFee: money(deliveryPricing?.guestTripFee || 0),
    pickupHostChargeFees: money(pickupPricing?.hostChargeFees || 0),
    deliveryHostChargeFees: money(deliveryPricing?.hostChargeFees || 0),
    defaultFulfillmentChoice: defaultChoice,
    fulfillmentChoice: pricing.fulfillmentChoice,
    selectedFulfillmentFee: pricing.selectedFulfillmentFee,
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

async function resolveActiveLocation(locationId) {
  if (!locationId) return null;
  return prisma.location.findFirst({
    where: { id: String(locationId), isActive: true },
    select: { id: true, tenantId: true, name: true, city: true, state: true, taxRate: true, locationConfig: true }
  });
}

async function resolvePublicTenantContext(input = {}) {
  const directTenant = await resolvePublicTenant({
    tenantSlug: input?.tenantSlug,
    tenantId: input?.tenantId
  });
  if (directTenant) return directTenant;

  const location = await resolveActiveLocation(input?.pickupLocationId || input?.locationId || input?.returnLocationId);
  if (location?.tenantId) {
    return prisma.tenant.findFirst({
      where: { id: location.tenantId, status: 'ACTIVE' }
    });
  }

  if (input?.vehicleTypeId) {
    const vehicleType = await prisma.vehicleType.findFirst({
      where: { id: String(input.vehicleTypeId) },
      select: { tenantId: true }
    });
    if (vehicleType?.tenantId) {
      return prisma.tenant.findFirst({
        where: { id: vehicleType.tenantId, status: 'ACTIVE' }
      });
    }
  }

  if (input?.listingId) {
    const listing = await prisma.hostVehicleListing.findFirst({
      where: { id: String(input.listingId) },
      select: { tenantId: true }
    });
    if (listing?.tenantId) {
      return prisma.tenant.findFirst({
        where: { id: listing.tenantId, status: 'ACTIVE' }
      });
    }
  }

  return null;
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

  const blockedAvailability = await prisma.vehicleAvailabilityBlock.findMany({
    where: {
      tenantId,
      vehicleId: { in: vehicles.map((row) => row.id) },
      ...activeVehicleBlockOverlapWhere({ start: pickupAt, end: returnAt })
    },
    select: { vehicleId: true }
  });

  const blocked = new Set(blockedReservations.map((row) => row.vehicleId).filter(Boolean));
  blockedAvailability.forEach((row) => {
    if (row?.vehicleId) blocked.add(row.vehicleId);
  });
  return vehicles.filter((row) => !blocked.has(row.id)).length;
}

export const bookingEngineService = {
  async getBootstrap({ tenantSlug, tenantId } = {}) {
    const tenant = await resolvePublicTenant({ tenantSlug, tenantId });

    if (!tenant) {
      const [tenants, locations, vehicleTypes, featuredListings, carSharingSearchPlaces] = await Promise.all([
        prisma.tenant.findMany({
          where: { status: 'ACTIVE' },
          select: {
            id: true,
            name: true,
            slug: true,
            carSharingEnabled: true
          },
          orderBy: [{ name: 'asc' }]
        }),
        prisma.location.findMany({
          where: {
            isActive: true,
            tenant: { status: 'ACTIVE' }
          },
          select: { id: true, tenantId: true, name: true, city: true, state: true, taxRate: true },
          orderBy: [{ name: 'asc' }]
        }),
        prisma.vehicleType.findMany({
          where: {
            tenant: { status: 'ACTIVE' }
          },
          select: { id: true, tenantId: true, code: true, name: true, description: true, imageUrl: true },
          orderBy: [{ name: 'asc' }]
        }),
        prisma.hostVehicleListing.findMany({
          where: {
            status: 'PUBLISHED',
            tenant: { status: 'ACTIVE' }
          },
          include: {
            hostProfile: { select: publicHostSelect() },
            vehicle: { select: { id: true, make: true, model: true, year: true, color: true, plate: true, vehicleType: { select: { imageUrl: true } } } },
            location: { select: { id: true, name: true, city: true, state: true } },
            pickupSpot: {
              include: {
                anchorLocation: { select: { id: true, name: true, city: true, state: true } },
                searchPlace: { include: { anchorLocation: { select: { id: true, name: true, city: true, state: true } } } }
              }
            }
          },
          orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
          take: 8
        }),
        listPublicCarSharingSearchPlaces({ directTenant: null, take: 120 })
      ]);

      return {
        tenant: null,
        tenants,
        locations,
        carSharingSearchPlaces,
        vehicleTypes,
        featuredListings: featuredListings.map((listing) => ({
          id: listing.id,
          slug: listing.slug,
          title: listing.title,
          shortDescription: listing.shortDescription,
          baseDailyRate: money(listing.baseDailyRate),
          cleaningFee: money(listing.cleaningFee),
          pickupFee: money(listing.pickupFee),
          deliveryFee: money(listing.deliveryFee),
          fulfillmentMode: listing.fulfillmentMode,
          deliveryRadiusMiles: listing.deliveryRadiusMiles,
          deliveryAreas: normalizeDeliveryAreas(listing.deliveryAreasJson),
          deliveryNotes: listing.deliveryNotes,
          instantBook: !!listing.instantBook,
          host: publicHostSummary(listing.hostProfile),
          vehicle: listing.vehicle,
          location: listing.location,
          pickupSpot: serializePublicPickupSpot(listing.pickupSpot),
          searchPlace: serializeCarSharingSearchPlace(listing.pickupSpot?.searchPlace),
          ...bookingImageSet({
            vehicleTypeImageUrl: listing.vehicle?.vehicleType?.imageUrl,
            listingPhotos: listing.photosJson
          })
        })),
        bookingModes: {
          rental: true,
          carSharing: tenants.some((row) => !!row.carSharingEnabled)
        }
      };
    }

    const [locations, vehicleTypes, featuredListings, tenants, carSharingSearchPlaces] = await Promise.all([
      prisma.location.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: { id: true, tenantId: true, name: true, city: true, state: true, taxRate: true },
        orderBy: [{ name: 'asc' }]
      }),
      prisma.vehicleType.findMany({
        where: { tenantId: tenant.id },
        select: { id: true, tenantId: true, code: true, name: true, description: true, imageUrl: true },
        orderBy: [{ name: 'asc' }]
      }),
      prisma.hostVehicleListing.findMany({
        where: { tenantId: tenant.id, status: 'PUBLISHED' },
        include: {
          hostProfile: { select: publicHostSelect() },
          vehicle: { select: { id: true, make: true, model: true, year: true, color: true, plate: true, vehicleType: { select: { imageUrl: true } } } },
          location: { select: { id: true, name: true, city: true, state: true } },
          pickupSpot: {
            include: {
              anchorLocation: { select: { id: true, name: true, city: true, state: true } },
              searchPlace: { include: { anchorLocation: { select: { id: true, name: true, city: true, state: true } } } }
            }
          }
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
      }),
      listPublicCarSharingSearchPlaces({ directTenant: tenant, take: 120 })
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
      carSharingSearchPlaces,
      vehicleTypes,
      featuredListings: featuredListings.map((listing) => ({
        id: listing.id,
        slug: listing.slug,
        title: listing.title,
        shortDescription: listing.shortDescription,
        baseDailyRate: money(listing.baseDailyRate),
        cleaningFee: money(listing.cleaningFee),
        pickupFee: money(listing.pickupFee),
        deliveryFee: money(listing.deliveryFee),
        fulfillmentMode: listing.fulfillmentMode,
        deliveryRadiusMiles: listing.deliveryRadiusMiles,
        deliveryAreas: normalizeDeliveryAreas(listing.deliveryAreasJson),
        deliveryNotes: listing.deliveryNotes,
        instantBook: !!listing.instantBook,
        host: publicHostSummary(listing.hostProfile),
        vehicle: listing.vehicle,
        location: listing.location,
        pickupSpot: serializePublicPickupSpot(listing.pickupSpot),
        searchPlace: serializeCarSharingSearchPlace(listing.pickupSpot?.searchPlace),
        ...bookingImageSet({
          vehicleTypeImageUrl: listing.vehicle?.vehicleType?.imageUrl,
          listingPhotos: listing.photosJson
        })
      })),
      bookingModes: {
        rental: true,
        carSharing: !!tenant.carSharingEnabled
      }
    };
  },

  async searchRental({ tenantSlug, tenantId, pickupLocationId, pickupLocationIds = [], pickupAt, returnAt }) {
    const pickupDate = toDate(pickupAt);
    const returnDate = toDate(returnAt);
    if (!pickupDate || !returnDate || pickupDate >= returnDate) {
      throw new Error('pickupAt and returnAt must be valid and returnAt must be after pickupAt');
    }
    if (!pickupLocationId) throw new Error('pickupLocationId is required');

    const rentalDays = ceilTripDays(pickupDate, returnDate);
    const directTenant = await resolvePublicTenant({ tenantSlug, tenantId });
    const requestedLocationIds = Array.isArray(pickupLocationIds) && pickupLocationIds.length
      ? pickupLocationIds.map((value) => String(value)).filter(Boolean)
      : pickupLocationId ? [String(pickupLocationId)] : [];
    const locations = await prisma.location.findMany({
      where: {
        id: { in: requestedLocationIds },
        isActive: true,
        ...(directTenant ? { tenantId: directTenant.id } : {}),
        tenant: { status: 'ACTIVE' }
      },
      select: { id: true, tenantId: true, name: true, city: true, state: true, taxRate: true, locationConfig: true },
      orderBy: [{ name: 'asc' }]
    });
    if (!locations.length) throw new Error('Pickup location not found');

    const vehicleTypesByTenant = new Map();
    const results = [];
    for (const location of locations) {
      const tenant = directTenant || await resolvePublicTenantContext({ pickupLocationId: location.id });
      if (!tenant) continue;
      if (!vehicleTypesByTenant.has(tenant.id)) {
        const tenantVehicleTypes = await prisma.vehicleType.findMany({
          where: { tenantId: tenant.id },
          orderBy: [{ name: 'asc' }]
        });
        vehicleTypesByTenant.set(tenant.id, tenantVehicleTypes);
      }
      const vehicleTypes = vehicleTypesByTenant.get(tenant.id) || [];

      for (const vehicleType of vehicleTypes) {
        const [revenueRecommendation, availableUnits] = await Promise.all([
          ratesService.getRevenueRecommendation({
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

        if (!revenueRecommendation?.baseQuote) continue;
        const revenuePricingApplied = !!(revenueRecommendation.enabled && revenueRecommendation.applyToPublicQuotes);
        const quote = revenuePricingApplied
          ? {
              ...revenueRecommendation.baseQuote,
              dailyRate: revenueRecommendation.recommendedDailyRate,
              baseTotal: revenueRecommendation.recommendedBaseTotal
            }
          : revenueRecommendation.baseQuote;

        const [additionalServices, insurancePlans, mandatoryFees] = await Promise.all([
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
          }),
          listMandatoryFeesForLocation({
            tenantId: tenant.id,
            locationId: location.id,
            baseAmount: Number(quote.baseTotal || 0),
            days: rentalDays
          })
        ]);
        const taxes = money(Number(quote.baseTotal || 0) * (Number(location.taxRate || 0) / 100));
        const mandatoryFeesTotal = money((mandatoryFees || []).reduce((sum, fee) => sum + Number(fee.total || 0), 0));
        const total = money(Number(quote.baseTotal || 0) + taxes + mandatoryFeesTotal);
        results.push({
          location: {
            id: location.id,
            tenantId: location.tenantId,
            name: location.name,
            city: location.city,
            state: location.state,
            taxRate: location.taxRate
          },
          vehicleType: {
            id: vehicleType.id,
            code: vehicleType.code,
            name: vehicleType.name,
            description: vehicleType.description,
            imageUrl: vehicleType.imageUrl || ''
          },
        availability: {
          availableUnits,
          available: availableUnits > 0
        },
        quote: {
          days: Number(quote.days || 0),
          dailyRate: money(quote.dailyRate),
          subtotal: money(quote.baseTotal),
          baseDailyRate: money(revenueRecommendation.baseQuote?.dailyRate),
          baseSubtotal: money(revenueRecommendation.baseQuote?.baseTotal),
          fees: mandatoryFeesTotal,
          taxes,
          total,
          gracePeriodMin: Number(quote.gracePeriodMin || 0),
          source: quote.source || 'GLOBAL',
          revenuePricingApplied,
          revenueRecommendationMode: revenueRecommendation.recommendationMode || 'ADVISORY',
          revenueAdjustmentPct: money(revenueRecommendation.adjustmentPct),
          revenueFactors: Array.isArray(revenueRecommendation.factors) ? revenueRecommendation.factors : [],
          revenueSummary: revenueRecommendation.summary || '',
          revenueMetrics: revenueRecommendation.metrics || null,
          revenueDailyBreakdown: Array.isArray(revenueRecommendation.recommendedDailyBreakdown)
            ? revenueRecommendation.recommendedDailyBreakdown
            : []
        },
          deposit: depositSnapshot({ location, quote }),
          additionalServices,
          mandatoryFees,
          insurancePlans
        });
      }
    }

    return {
      tenant: directTenant ? { id: directTenant.id, name: directTenant.name, slug: directTenant.slug } : null,
      location: locations[0] || null,
      pickupAt: pickupDate,
      returnAt: returnDate,
      results
    };
  },

  async searchCarSharing({
    tenantSlug,
    tenantId,
    pickupAt,
    returnAt,
    locationId,
    locationIds = [],
    searchPlaceId,
    searchPlaceIds = []
  }) {
    const pickupDate = toDate(pickupAt);
    const returnDate = toDate(returnAt);
    if (!pickupDate || !returnDate || pickupDate >= returnDate) {
      throw new Error('pickupAt and returnAt must be valid and returnAt must be after pickupAt');
    }

    const directTenant = await resolvePublicTenant({ tenantSlug, tenantId });
    const normalizedLocationIds = Array.isArray(locationIds) && locationIds.length
      ? locationIds.map((value) => String(value)).filter(Boolean)
      : locationId ? [String(locationId)] : [];
    const explicitSearchPlaceIds = Array.isArray(searchPlaceIds) && searchPlaceIds.length
      ? searchPlaceIds.map((value) => String(value)).filter(Boolean)
      : searchPlaceId ? [String(searchPlaceId)] : [];
    if (!normalizedLocationIds.length && !explicitSearchPlaceIds.length) {
      throw new Error('Choose a valid location before searching car sharing');
    }

    const scope = await resolveCarSharingSearchScope({
      directTenant,
      requestedIds: normalizedLocationIds,
      searchPlaceIds: explicitSearchPlaceIds
    });
    const resolvedLocationIds = scope.matchedLocations.map((row) => String(row.id));
    const resolvedSearchPlaceIds = scope.resolvedSearchPlaces.map((row) => String(row.id));
    const resolvedPickupSpotIds = scope.resolvedSearchPlaces
      .map((row) => row?.hostPickupSpotId ? String(row.hostPickupSpotId) : '')
      .filter(Boolean);
    if (!resolvedLocationIds.length && !resolvedSearchPlaceIds.length) {
      throw new Error('Choose a valid location before searching car sharing');
    }

    const listings = await prisma.hostVehicleListing.findMany({
      where: {
        status: 'PUBLISHED',
        tenant: {
          status: 'ACTIVE',
          ...(directTenant ? { id: directTenant.id } : {}),
          carSharingEnabled: true
        },
        OR: [
          resolvedLocationIds.length ? { locationId: { in: resolvedLocationIds } } : null,
          resolvedPickupSpotIds.length ? { pickupSpotId: { in: resolvedPickupSpotIds } } : null,
          resolvedLocationIds.length ? {
            pickupSpot: {
              isActive: true,
              approvalStatus: 'APPROVED',
              anchorLocationId: { in: resolvedLocationIds }
            }
          } : null,
          resolvedSearchPlaceIds.length ? {
            serviceAreas: {
              some: {
                isActive: true,
                searchPlaceId: { in: resolvedSearchPlaceIds }
              }
            }
          } : null
        ].filter(Boolean)
      },
      include: {
        hostProfile: { select: publicHostSelect() },
        vehicle: { select: { id: true, make: true, model: true, year: true, color: true, plate: true, vehicleType: { select: { imageUrl: true } } } },
        location: { select: { id: true, name: true, city: true, state: true } },
        pickupSpot: {
          include: {
            anchorLocation: { select: { id: true, name: true, city: true, state: true } },
            searchPlace: { include: { anchorLocation: { select: { id: true, name: true, city: true, state: true } } } }
          }
        },
        serviceAreas: {
          where: { isActive: true },
          include: {
            searchPlace: {
              include: { anchorLocation: { select: { id: true, name: true, city: true, state: true } } }
            }
          }
        },
        availabilityWindows: { orderBy: [{ startAt: 'asc' }] }
      },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }]
    });
    const listingIds = listings.map((listing) => String(listing.id)).filter(Boolean);
    const recentTripRows = listingIds.length
      ? await prisma.trip.findMany({
          where: { listingId: { in: listingIds } },
          select: {
            id: true,
            listingId: true,
            status: true,
            scheduledPickupAt: true,
            actualPickupAt: true,
            actualReturnAt: true,
            createdAt: true,
            fulfillmentPlan: { select: { confirmedAt: true } },
            hostReview: { select: { submittedAt: true, rating: true } }
          },
          orderBy: [{ createdAt: 'desc' }]
        })
      : [];
    const listingTripMap = new Map();
    for (const row of recentTripRows) {
      const key = String(row.listingId || '');
      if (!key) continue;
      const current = listingTripMap.get(key) || [];
      if (current.length >= 12) continue;
      current.push(row);
      listingTripMap.set(key, current);
    }
    if (!directTenant && !listings.length) {
      throw new Error('No car sharing vehicles are available for this location yet');
    }

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
      const searchMatch = resolveListingSearchMatch({
        listing,
        requestedLocationIds: resolvedLocationIds,
        requestedSearchPlaceIds: resolvedSearchPlaceIds
      });
      if (!searchMatch) return [];
      const trustSummary = buildCarSharingTrustSummary({
        listing,
        searchMatch,
        trustSignals: buildListingTrustSignals(listingTripMap.get(String(listing.id)) || [])
      });
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
          fulfillmentMode: listing.fulfillmentMode,
          deliveryRadiusMiles: listing.deliveryRadiusMiles,
          deliveryAreas: normalizeDeliveryAreas(listing.deliveryAreasJson),
          deliveryNotes: listing.deliveryNotes,
          host: publicHostSummary(listing.hostProfile),
          vehicle: listing.vehicle,
          location: listing.location,
          pickupSpot: serializePublicPickupSpot(listing.pickupSpot),
          searchPlace: searchMatch.searchPlaceSummary || null,
          searchMatch: serializeListingSearchSummary(searchMatch),
          trustSummary,
          additionalServices: normalizeHostAddOns(listing.addOnsJson),
          publishedAt: listing.publishedAt || null,
          createdAt: listing.createdAt || null,
          ...bookingImageSet({
            vehicleTypeImageUrl: listing.vehicle?.vehicleType?.imageUrl,
            listingPhotos: listing.photosJson
          })
        },
        quote,
        searchMatch
      }];
    });

    results.sort(compareCarSharingSearchResults);

    return {
      tenant: directTenant ? { id: directTenant.id, name: directTenant.name, slug: directTenant.slug } : null,
      pickupAt: pickupDate,
      returnAt: returnDate,
      searchPlaces: scope.resolvedSearchPlaces.map((row) => serializeCarSharingSearchPlace(row)),
      locations: scope.matchedLocations,
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
        hostProfile: { select: publicHostSelect() },
        vehicle: { select: { id: true, make: true, model: true, year: true, color: true, plate: true, vehicleType: { select: { imageUrl: true } } } },
        location: { select: { id: true, name: true, city: true, state: true } },
        pickupSpot: {
          include: {
            anchorLocation: { select: { id: true, name: true, city: true, state: true } },
            searchPlace: { include: { anchorLocation: { select: { id: true, name: true, city: true, state: true } } } }
          }
        },
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
      fulfillmentMode: listing.fulfillmentMode,
      deliveryRadiusMiles: listing.deliveryRadiusMiles,
      deliveryAreas: normalizeDeliveryAreas(listing.deliveryAreasJson),
      deliveryNotes: listing.deliveryNotes,
      tripRules: listing.tripRules,
      host: publicHostSummary(listing.hostProfile),
      vehicle: listing.vehicle,
      location: listing.location,
      pickupSpot: serializePublicPickupSpot(listing.pickupSpot),
      searchPlace: serializeCarSharingSearchPlace(listing.pickupSpot?.searchPlace),
      ...bookingImageSet({
        vehicleTypeImageUrl: listing.vehicle?.vehicleType?.imageUrl,
        listingPhotos: listing.photosJson
      })
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
    const tenant = await resolvePublicTenantContext({
      tenantSlug: input?.tenantSlug,
      tenantId: input?.tenantId,
      pickupLocationId: input?.pickupLocationId,
      returnLocationId: input?.returnLocationId,
      vehicleTypeId: input?.vehicleTypeId,
      listingId: input?.listingId
    });
    if (!tenant) throw new Error('tenant is required');

    const searchType = String(input?.searchType || '').trim().toUpperCase();
    if (!['RENTAL', 'CAR_SHARING'].includes(searchType)) {
      throw new Error('searchType must be RENTAL or CAR_SHARING');
    }

    const customer = await upsertPublicCustomer(tenant.id, input?.customer || {});

    if (searchType === 'RENTAL') {
      const search = await this.searchRental({
        pickupLocationId: input?.pickupLocationId,
        pickupLocationIds: input?.pickupLocationId ? [input.pickupLocationId] : [],
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
      const linkedServiceFees = normalizedChosenServices
        .map((service) => computeLinkedFeeLineForService(service, service.linkedFee, {
          baseAmount: Number(selected.quote?.subtotal || 0) + normalizedChosenServices.reduce((sum, row) => sum + Number(row.total || 0), 0),
          days: Number(selected.quote?.days || 1)
        }))
        .filter(Boolean);
      const insuranceLine = selectedInsurancePlan
        ? {
            ...selectedInsurancePlan,
            source: 'INSURANCE',
            sourceRefId: selectedInsurancePlan.code
          }
        : null;
      const mandatoryFees = Array.isArray(selected.mandatoryFees) ? selected.mandatoryFees : [];
      const mandatoryFeesTotal = money(mandatoryFees.reduce((sum, fee) => sum + Number(fee.total || 0), 0));
      const insuranceTotal = money(Number(insuranceLine?.total || 0));
      const addOnsTotal = money(normalizedChosenServices.reduce((sum, service) => sum + Number(service.total || 0), 0));
      const linkedServiceFeesTotal = money(linkedServiceFees.reduce((sum, fee) => sum + Number(fee.total || 0), 0));
      const estimatedTotal = money(Number(selected.quote.total || 0) + addOnsTotal + linkedServiceFeesTotal + insuranceTotal);

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

      if (normalizedChosenServices.length || linkedServiceFees.length || insuranceLine || mandatoryFees.length) {
        await prisma.reservationCharge.createMany({
          data: [
            ...mandatoryFees.map((fee, idx) => ({
              reservationId: reservation.id,
              code: fee.code,
              name: fee.name,
              chargeType: 'UNIT',
              quantity: 1,
              rate: Number(fee.mode === 'PERCENTAGE' ? fee.amount : fee.total || 0),
              total: Number(fee.total || 0),
              taxable: !!fee.taxable,
              selected: true,
              sortOrder: idx,
              source: 'MANDATORY_FEE',
              sourceRefId: fee.feeId
            })),
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
              sortOrder: idx + mandatoryFees.length,
              source: 'ADDITIONAL_SERVICE',
              sourceRefId: service.serviceId
            })),
            ...linkedServiceFees.map((fee, idx) => ({
              reservationId: reservation.id,
              code: fee.code,
              name: fee.name,
              chargeType: 'UNIT',
              quantity: 1,
              rate: Number(fee.mode === 'PERCENTAGE' ? fee.amount : fee.total || 0),
              total: Number(fee.total || 0),
              taxable: !!fee.taxable,
              selected: true,
              sortOrder: idx + mandatoryFees.length + normalizedChosenServices.length,
              source: 'SERVICE_LINKED_FEE',
              sourceRefId: `${fee.feeId}:${fee.serviceId}`,
              notes: fee.serviceName ? `Auto-added because service "${fee.serviceName}" was selected` : 'Auto-added because a linked service was selected'
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
              sortOrder: normalizedChosenServices.length + mandatoryFees.length + linkedServiceFees.length,
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

      const customerInfoRequest = await issueCustomerInfoRequest(reservation);
      const [signatureRequest, paymentRequest] = await Promise.all([
        issuePortalRequest('signature', reservation),
        issuePortalRequest('payment', reservation)
      ]);
      const nextActions = {
        customerInfo: customerInfoRequest,
        signature: signatureRequest,
        payment: paymentRequest,
        primaryStep: 'customer-info'
      };
      const confirmationEmail = await sendPublicBookingConfirmationEmail({
        reservation,
        customer,
        tenant,
        pricingBreakdown: {
          dueNow: money(selected.deposit?.amountDue),
          estimatedTotal,
          reservationEstimate: estimatedTotal
        },
        nextActions,
        bookingType: 'RENTAL',
        vehicleLabel: selected?.vehicleType?.name || 'Vehicle'
      });
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
        pricingBreakdown: {
          tripDays: Number(selected.quote?.days || 0),
          dailyRate: money(selected.quote?.dailyRate),
          baseSubtotal: money(selected.quote?.subtotal),
          mandatoryFeesTotal,
          estimatedTaxes: money(selected.quote?.taxes),
          baseReservationTotal: money(selected.quote?.total),
          additionalServicesTotal: addOnsTotal,
          linkedServiceFeesTotal,
          insuranceTotal,
          reservationEstimate: estimatedTotal,
          depositDueNow: money(selected.deposit?.amountDue),
          securityDeposit: money(selected.deposit?.securityDepositAmount),
          currency: 'USD'
        },
        mandatoryFees,
        additionalServices: normalizedChosenServices,
        linkedServiceFees,
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
        nextActions,
        confirmationEmail
      };
    }

    const search = await this.searchCarSharing({
      tenantSlug: tenant.slug,
      tenantId: tenant.id,
      pickupAt: input?.pickupAt,
      returnAt: input?.returnAt,
      locationId: input?.pickupLocationId || null,
      locationIds: input?.pickupLocationId ? [input.pickupLocationId] : [],
      searchPlaceId: input?.searchPlaceId || input?.requestedSearchPlaceId || null,
      searchPlaceIds: input?.searchPlaceId || input?.requestedSearchPlaceId
        ? [String(input?.searchPlaceId || input?.requestedSearchPlaceId)]
        : []
    });
    const selected = (search.results || []).find((row) => row.listing?.id === String(input?.listingId || ''));
    if (!selected) throw new Error('Selected car sharing listing is no longer available');
    const requestedServices = Array.isArray(input?.additionalServices) ? input.additionalServices : [];
    const normalizedChosenServices = requestedServices
      .map((row) => {
        const serviceId = String(row?.serviceId || '').trim();
        const match = (selected.listing?.additionalServices || []).find((service) => service.serviceId === serviceId);
        if (!match) return null;
        const quantity = Math.max(1, Number(row?.quantity ?? match.quantity ?? 1) || 1);
        return {
          ...match,
          quantity,
          total: money(Number(match.rate || 0) * quantity)
        };
      })
      .filter(Boolean);
    const fulfillmentChoice = String(input?.fulfillmentChoice || selected.quote?.fulfillmentChoice || selected.quote?.defaultFulfillmentChoice || 'PICKUP').trim().toUpperCase() === 'DELIVERY'
      ? 'DELIVERY'
      : 'PICKUP';
    const allowedDeliveryAreas = normalizeDeliveryAreas(selected.listing?.deliveryAreasJson || selected.listing?.deliveryAreas || []);
    const deliveryAreaChoice = String(input?.deliveryAreaChoice || '').trim();
    if (fulfillmentChoice === 'DELIVERY' && allowedDeliveryAreas.length && !allowedDeliveryAreas.includes(deliveryAreaChoice)) {
      throw new Error('Choose a valid delivery area for this listing');
    }

    const trip = await carSharingService.createTrip({
      tenantId: tenant.id,
      listingId: input?.listingId,
      guestCustomerId: customer.id,
      scheduledPickupAt: input?.pickupAt,
      scheduledReturnAt: input?.returnAt,
      pickupLocationId: input?.pickupLocationId || null,
      returnLocationId: input?.returnLocationId || input?.pickupLocationId || null,
      searchPlaceId: input?.searchPlaceId || selected.listing?.searchPlace?.id || null,
      requestedSearchPlaceId: input?.requestedSearchPlaceId || input?.searchPlaceId || null,
      fulfillmentChoice,
      deliveryAreaChoice,
      notes: ['[PUBLIC BOOKING] Created from booking web', deliveryAreaChoice ? `Delivery area: ${deliveryAreaChoice}` : ''].filter(Boolean).join(' · ')
    }, { tenantId: tenant.id });

    if (trip?.reservation && normalizedChosenServices.length) {
      await prisma.reservationCharge.createMany({
        data: normalizedChosenServices.map((service, idx) => ({
          reservationId: trip.reservation.id,
          code: service.code,
          name: service.name,
          chargeType: service.chargeType || 'UNIT',
          quantity: Number(service.quantity || 1),
          rate: Number(service.rate || 0),
          total: Number(service.total || 0),
          taxable: !!service.taxable,
          selected: true,
          sortOrder: idx,
          source: 'HOST_ADDON',
          sourceRefId: service.serviceId
        }))
      });
    }

    const nextActions = trip?.reservation
      ? {
          customerInfo: await issueCustomerInfoRequest(trip.reservation),
          ...(await (async () => {
            const [signature, payment] = await Promise.all([
              issuePortalRequest('signature', trip.reservation),
              issuePortalRequest('payment', trip.reservation)
            ]);
            return {
              signature,
              payment,
              primaryStep: 'customer-info'
            };
          })())
        }
      : {
          customerInfo: { kind: 'customer-info', link: '', expiresAt: null, emailSent: false, warning: 'Trip created without linked reservation workflow' },
          signature: { kind: 'signature', link: '', expiresAt: null, emailSent: false, warning: 'Trip created without linked reservation workflow' },
          payment: { kind: 'payment', link: '', expiresAt: null, emailSent: false, warning: 'Trip created without linked reservation workflow' },
          primaryStep: 'customer-info'
        };
    const confirmationEmail = trip?.reservation
      ? await sendPublicBookingConfirmationEmail({
          reservation: trip.reservation,
          customer,
          tenant,
          pricingBreakdown: {
            dueNow: money(selected.quote?.amountDueNow),
            guestTotal: money(Number(trip.quotedTotal || 0) + normalizedChosenServices.reduce((sum, service) => sum + Number(service.total || 0), 0))
          },
          nextActions,
          bookingType: 'CAR_SHARING',
          trip,
          vehicleLabel: selected.listing?.vehicle?.label || selected.listing?.title || 'Vehicle'
        })
      : {
          emailSent: false,
          sentTo: customer?.email ? [customer.email] : [],
          warning: 'Trip created without linked reservation workflow'
        };
    const selfServiceConfig = trip?.tenantId
      ? await settingsService.getSelfServiceConfig({ tenantId: trip.tenantId }).catch(() => null)
      : null;

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
        hostGrossRevenue: money(trip.hostGrossRevenue),
        hostServiceFeeRate: money(trip.hostServiceFeeRate),
        hostServiceFee: money(trip.hostServiceFee),
        guestTripFee: money(trip.guestTripFee),
        hostEarnings: money(trip.hostEarnings),
        platformFee: money(trip.platformFee),
        platformRevenue: money(trip.platformRevenue),
        location: selected.listing?.location || null,
        pickupSpot: selected.listing?.pickupSpot || null,
        searchPlace: selected.listing?.searchPlace || null,
        searchMatch: selected.listing?.searchMatch || null,
        fulfillmentPlan: serializePublicTripFulfillmentPlan(trip?.fulfillmentPlan, {
          pickupAt: trip?.reservation?.pickupAt || null,
          selfServiceConfig: selfServiceConfig || {},
          serializeSearchPlace: serializeCarSharingSearchPlace,
          serializePickupSpot: serializePublicPickupSpot,
          serializeServiceAreaSearchPlace: serializeCarSharingSearchPlace
        }),
        vehicleLabel: selected.listing?.vehicle?.label || '',
        selectedFulfillmentChoice: fulfillmentChoice,
        fulfillmentMode: selected.listing?.fulfillmentMode || 'PICKUP_ONLY',
        deliveryRadiusMiles: selected.listing?.deliveryRadiusMiles || null,
        deliveryAreas: normalizeDeliveryAreas(selected.listing?.deliveryAreasJson || selected.listing?.deliveryAreas || []),
        deliveryAreaChoice: deliveryAreaChoice || null,
        deliveryNotes: selected.listing?.deliveryNotes || null,
        pickupFee: money(selected.listing?.pickupFee || 0),
        deliveryFee: money(selected.listing?.deliveryFee || 0),
        selectedFulfillmentFee: money(fulfillmentChoice === 'DELIVERY' ? selected.listing?.deliveryFee || 0 : selected.listing?.pickupFee || 0)
      },
      pricingBreakdown: {
        tripDays: Number(selected.quote?.tripDays || 0),
        tripSubtotal: money(selected.quote?.subtotal),
        hostChargeFees: money(Number(trip.quotedFees || 0) - Number(trip.guestTripFee || 0)),
        pickupFee: money(selected.listing?.pickupFee || 0),
        deliveryFee: money(selected.listing?.deliveryFee || 0),
        deliveryAreaChoice: deliveryAreaChoice || null,
        selectedFulfillmentFee: money(fulfillmentChoice === 'DELIVERY' ? selected.listing?.deliveryFee || 0 : selected.listing?.pickupFee || 0),
        guestTripFee: money(trip.guestTripFee),
        fees: money(trip.quotedFees),
        taxes: money(trip.quotedTaxes),
        baseTripTotal: money(trip.quotedTotal),
        additionalServicesTotal: money(normalizedChosenServices.reduce((sum, service) => sum + Number(service.total || 0), 0)),
        guestTotal: money(Number(trip.quotedTotal || 0) + normalizedChosenServices.reduce((sum, service) => sum + Number(service.total || 0), 0)),
        hostGrossRevenue: money(trip.hostGrossRevenue),
        hostServiceFeeRate: money(trip.hostServiceFeeRate),
        hostServiceFee: money(trip.hostServiceFee),
        hostEarnings: money(trip.hostEarnings),
        platformFee: money(trip.platformFee),
        platformRevenue: money(trip.platformRevenue),
        currency: 'USD'
      },
      reservation: trip?.reservation ? {
        id: trip.reservation.id,
        reservationNumber: trip.reservation.reservationNumber,
        status: trip.reservation.status
      } : null,
      additionalServices: normalizedChosenServices,
      nextActions,
      confirmationEmail
    };
  },

  async lookupPublicBooking(input = {}) {
    const reference = String(input?.reference || '').trim();
    const email = String(input?.email || '').trim().toLowerCase();
    const tenantSlug = String(input?.tenantSlug || '').trim();
    if (!reference || !email) throw new Error('reference and email are required');

    let tenantId = null;
    if (tenantSlug) {
      const tenant = await prisma.tenant.findFirst({
        where: { slug: tenantSlug },
        select: { id: true }
      });
      if (!tenant) throw new Error('Selected tenant not found');
      tenantId = tenant.id;
    }

    const customerFilter = {
      email: {
        equals: email,
        mode: 'insensitive'
      }
    };

    let reservation = await prisma.reservation.findFirst({
      where: {
        ...(tenantId ? { tenantId } : {}),
        reservationNumber: reference,
        customer: customerFilter
      },
      include: {
        customer: true,
        pickupLocation: true,
        returnLocation: true,
        vehicle: true,
        vehicleType: true,
        incidents: {
          orderBy: [{ createdAt: 'desc' }],
          take: 10
        }
      }
    });

    let trip = null;
    if (!reservation) {
      trip = await prisma.trip.findFirst({
        where: {
          ...(tenantId ? { tenantId } : {}),
          tripCode: reference,
          guestCustomer: customerFilter
        },
        include: {
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
          hostProfile: { select: publicHostSelect() },
          guestCustomer: true,
          reservation: {
            include: {
              pickupLocation: true,
              returnLocation: true,
              vehicle: true,
              vehicleType: true
            }
          },
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
          hostReview: true,
          incidents: {
            orderBy: [{ createdAt: 'desc' }],
            take: 10
          }
        }
      });
      reservation = trip?.reservation || null;
    } else {
      trip = await prisma.trip.findFirst({
        where: { reservationId: reservation.id },
        include: {
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
          hostProfile: { select: publicHostSelect() },
          guestCustomer: true,
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
          hostReview: true,
          incidents: {
            orderBy: [{ createdAt: 'desc' }],
            take: 10
          }
        }
      });
    }

    if (!reservation && !trip) {
      throw new Error('Booking not found for that reference and email');
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: reservation?.tenantId || trip?.tenantId || tenantId },
      select: { id: true, name: true, slug: true }
    });

    const customer = reservation?.customer || trip?.guestCustomer || null;
    const nextActions = reservation
      ? {
          customerInfo: await ensurePortalRequest('customer-info', reservation),
          ...(await (async () => {
            const [signature, payment] = await Promise.all([
              ensurePortalRequest('signature', reservation),
              ensurePortalRequest('payment', reservation)
            ]);
            return {
              signature,
              payment,
              primaryStep: 'customer-info'
            };
          })())
        }
      : {
          customerInfo: { kind: 'customer-info', link: '', expiresAt: null, emailSent: false, warning: 'No linked reservation workflow found' },
          signature: { kind: 'signature', link: '', expiresAt: null, emailSent: false, warning: 'No linked reservation workflow found' },
          payment: { kind: 'payment', link: '', expiresAt: null, emailSent: false, warning: 'No linked reservation workflow found' },
          primaryStep: 'customer-info'
        };
    const selfServiceConfig = (reservation?.tenantId || trip?.tenantId)
      ? await settingsService.getSelfServiceConfig({ tenantId: reservation?.tenantId || trip?.tenantId }).catch(() => null)
      : null;

    return {
      bookingType: trip ? 'CAR_SHARING' : 'RENTAL',
      tenant: tenant || null,
      customer: customer
        ? {
            id: customer.id,
            firstName: customer.firstName,
            lastName: customer.lastName,
            email: customer.email,
            phone: customer.phone
          }
        : null,
      reservation: reservation
        ? {
            id: reservation.id,
            reservationNumber: reservation.reservationNumber,
            status: reservation.status,
            estimatedTotal: money(reservation.estimatedTotal),
            pickupAt: reservation.pickupAt,
            returnAt: reservation.returnAt,
            incidents: (reservation.incidents || []).map((incident) => ({
              id: incident.id,
              type: incident.type,
              status: incident.status,
              title: incident.title,
              description: incident.description || '',
              amountClaimed: money(incident.amountClaimed),
              amountResolved: money(incident.amountResolved),
              createdAt: incident.createdAt,
              resolvedAt: incident.resolvedAt
            }))
          }
        : null,
      trip: trip
        ? {
            id: trip.id,
            tripCode: trip.tripCode,
            status: trip.status,
            quotedTotal: money(trip.quotedTotal),
            hostGrossRevenue: money(trip.hostGrossRevenue),
            hostServiceFeeRate: money(trip.hostServiceFeeRate),
            hostServiceFee: money(trip.hostServiceFee),
            guestTripFee: money(trip.guestTripFee),
            hostEarnings: money(trip.hostEarnings),
            platformFee: money(trip.platformFee),
            platformRevenue: money(trip.platformRevenue),
            location: trip.listing?.location
              ? {
                  id: trip.listing.location.id,
                  name: trip.listing.location.name,
                  city: trip.listing.location.city,
                  state: trip.listing.location.state
                }
              : null,
            pickupSpot: serializePublicPickupSpot(trip.fulfillmentPlan?.pickupSpot || trip.listing?.pickupSpot),
            searchPlace: serializeCarSharingSearchPlace(trip.fulfillmentPlan?.searchPlace || trip.listing?.pickupSpot?.searchPlace),
            fulfillmentPlan: serializePublicTripFulfillmentPlan(trip.fulfillmentPlan, {
              pickupAt: reservation?.pickupAt || null,
              selfServiceConfig: selfServiceConfig || {},
              serializeSearchPlace: serializeCarSharingSearchPlace,
              serializePickupSpot: serializePublicPickupSpot,
              serializeServiceAreaSearchPlace: serializeCarSharingSearchPlace
            }),
            host: publicHostSummary(trip.hostProfile),
            hostReview: trip.hostReview
              ? {
                  id: trip.hostReview.id,
                  status: trip.hostReview.status,
                  rating: trip.hostReview.rating == null ? null : Number(trip.hostReview.rating),
                  comments: trip.hostReview.comments || '',
                  submittedAt: trip.hostReview.submittedAt || null,
                  action: existingHostReviewAction(trip.hostReview)
                }
              : null,
            incidents: (trip.incidents || []).map((incident) => ({
              id: incident.id,
              type: incident.type,
              status: incident.status,
              title: incident.title,
              description: incident.description || '',
              amountClaimed: money(incident.amountClaimed),
              amountResolved: money(incident.amountResolved),
              createdAt: incident.createdAt,
              resolvedAt: incident.resolvedAt
            }))
          }
        : null,
      issues: trip
        ? (trip.incidents || []).map((incident) => ({
            id: incident.id,
            type: incident.type,
            status: incident.status,
            title: incident.title,
            description: incident.description || '',
            amountClaimed: money(incident.amountClaimed),
            amountResolved: money(incident.amountResolved),
            createdAt: incident.createdAt,
            resolvedAt: incident.resolvedAt
          }))
        : (reservation?.incidents || []).map((incident) => ({
            id: incident.id,
            type: incident.type,
            status: incident.status,
            title: incident.title,
            description: incident.description || '',
            amountClaimed: money(incident.amountClaimed),
            amountResolved: money(incident.amountResolved),
            createdAt: incident.createdAt,
            resolvedAt: incident.resolvedAt
          })),
      nextActions
    };
  }
};
