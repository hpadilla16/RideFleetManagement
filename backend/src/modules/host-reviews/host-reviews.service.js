import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { money } from '../../lib/money.js';

function reviewBaseUrl() {
  return (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function reviewLink(token) {
  return token ? `${reviewBaseUrl()}/host-review?token=${encodeURIComponent(token)}` : '';
}

function ratingNumber(value) {
  return Number(Number(value || 0).toFixed(2));
}

function parsePhotoList(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6) : [];
  } catch {
    return [];
  }
}

function serializeHostCard(hostProfile, extra = {}) {
  if (!hostProfile) return null;
  return {
    id: hostProfile.id,
    displayName: hostProfile.displayName,
    averageRating: ratingNumber(hostProfile.averageRating),
    reviewCount: Number(hostProfile.reviewCount || 0),
    latestReviewAt: hostProfile.latestReviewAt || null,
    createdAt: hostProfile.createdAt || null,
    ...extra
  };
}

function serializeReview(review) {
  return {
    id: review.id,
    status: review.status,
    rating: review.rating == null ? null : Number(review.rating),
    comments: review.comments || '',
    reviewerName: review.reviewerName || '',
    submittedAt: review.submittedAt || null,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt
  };
}

async function refreshHostAggregate(hostProfileId) {
  const aggregate = await prisma.hostReview.aggregate({
    where: {
      hostProfileId,
      status: 'SUBMITTED',
      rating: { not: null }
    },
    _avg: { rating: true },
    _count: { _all: true },
    _max: { submittedAt: true }
  });

  await prisma.hostProfile.update({
    where: { id: hostProfileId },
    data: {
      averageRating: aggregate._count._all ? Number(aggregate._avg.rating || 0) : 0,
      reviewCount: aggregate._count._all || 0,
      latestReviewAt: aggregate._max.submittedAt || null
    }
  });
}

async function loadReviewByToken(token, { allowSubmitted = true } = {}) {
  if (!token) throw new Error('token required');
  const review = await prisma.hostReview.findFirst({
    where: {
      publicToken: String(token).trim()
    },
    include: {
      hostProfile: true,
      trip: {
        include: {
          listing: {
            include: {
              vehicle: true,
              location: true
            }
          },
          guestCustomer: true,
          reservation: true
        }
      }
    }
  });
  if (!review) throw new Error('Invalid review token');
  if (review.status !== 'SUBMITTED') {
    const expiresAt = review.publicTokenExpiresAt ? new Date(review.publicTokenExpiresAt) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new Error('Review token expired');
    }
  } else if (!allowSubmitted) {
    throw new Error('Review already submitted');
  }
  return review;
}

export const hostReviewsService = {
  async issueGuestReviewRequestForTrip(tripId) {
    if (!tripId) throw new Error('tripId required');
    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        hostProfile: true,
        guestCustomer: true,
        reservation: true,
        listing: {
          include: {
            vehicle: true,
            location: true
          }
        }
      }
    });
    if (!trip) throw new Error('Trip not found');
    if (String(trip.status || '').toUpperCase() !== 'COMPLETED') {
      return { issued: false, warning: 'Trip is not completed yet' };
    }
    if (!trip.guestCustomer?.email || !trip.hostProfile) {
      return { issued: false, warning: 'Missing guest email or host profile for review request' };
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

    const existing = await prisma.hostReview.findUnique({
      where: { tripId: trip.id }
    });

    let review;
    if (existing?.status === 'SUBMITTED') {
      return {
        issued: false,
        review: serializeReview(existing),
        host: serializeHostCard(trip.hostProfile)
      };
    }

    if (existing) {
      review = await prisma.hostReview.update({
        where: { id: existing.id },
        data: {
          status: 'REQUESTED',
          publicToken: token,
          publicTokenExpiresAt: expiresAt,
          requestedAt: new Date()
        }
      });
    } else {
      review = await prisma.hostReview.create({
        data: {
          tripId: trip.id,
          hostProfileId: trip.hostProfileId,
          guestCustomerId: trip.guestCustomerId || null,
          reservationId: trip.reservationId || null,
          status: 'REQUESTED',
          publicToken: token,
          publicTokenExpiresAt: expiresAt,
          requestedAt: new Date()
        }
      });
    }

    await prisma.tripTimelineEvent.create({
      data: {
        tripId: trip.id,
        eventType: 'HOST_REVIEW_REQUESTED',
        actorType: 'SYSTEM',
        notes: `Guest review request sent for host ${trip.hostProfile.displayName}`,
        metadata: JSON.stringify({
          hostProfileId: trip.hostProfile.id,
          reviewId: review.id,
          guestCustomerId: trip.guestCustomerId || null
        })
      }
    });

    let emailSent = false;
    let warning = null;
    try {
      const link = reviewLink(token);
      const guestName = [trip.guestCustomer.firstName, trip.guestCustomer.lastName].filter(Boolean).join(' ').trim() || 'Guest';
      const hostName = trip.hostProfile.displayName || 'your host';
      const subject = `How was your trip with ${hostName}?`;
      const text = [
        `Hi ${guestName},`,
        '',
        `Your trip ${trip.tripCode} has been completed.`,
        `Please rate your host ${hostName} and share a short comment about your experience.`,
        '',
        `Leave your review here: ${link}`,
        '',
        'Thanks for helping us improve the marketplace.'
      ].join('\n');
      const html = [
        `<p>Hi ${guestName},</p>`,
        `<p>Your trip <strong>${trip.tripCode}</strong> has been completed.</p>`,
        `<p>Please rate your host <strong>${hostName}</strong> and share a short comment about your experience.</p>`,
        `<p><a href="${link}">Leave your host review</a></p>`,
        `<p>Thanks for helping us improve the marketplace.</p>`
      ].join('');
      await sendEmail({
        to: trip.guestCustomer.email,
        subject,
        text,
        html
      });
      emailSent = true;
    } catch (error) {
      warning = `Unable to send host review email: ${String(error?.message || error)}`;
    }

    return {
      issued: true,
      emailSent,
      warning,
      review: serializeReview(review),
      host: serializeHostCard(trip.hostProfile),
      link: reviewLink(token)
    };
  },

  async getPublicHostProfile(hostProfileId) {
    const hostProfile = await prisma.hostProfile.findFirst({
      where: {
        id: String(hostProfileId || '').trim(),
        status: 'ACTIVE'
      },
      include: {
        listings: {
          where: { status: 'PUBLISHED' },
          include: {
            vehicle: true,
            location: true
          },
          orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
          take: 6
        },
        reviews: {
          where: { status: 'SUBMITTED' },
          orderBy: [{ submittedAt: 'desc' }],
          take: 12
        },
        _count: {
          select: {
            trips: true,
            listings: true
          }
        }
      }
    });
    if (!hostProfile) throw new Error('Host profile not found');

    const completedTrips = await prisma.trip.count({
      where: {
        hostProfileId: hostProfile.id,
        status: 'COMPLETED'
      }
    });

    return {
      host: serializeHostCard(hostProfile, {
        completedTrips,
        activeListings: (hostProfile.listings || []).length
      }),
      listings: (hostProfile.listings || []).map((listing) => ({
        id: listing.id,
        title: listing.title,
        baseDailyRate: money(listing.baseDailyRate),
        primaryImageUrl: parsePhotoList(listing.photosJson)[0] || '',
        imageUrls: parsePhotoList(listing.photosJson),
        vehicle: listing.vehicle
          ? {
              year: listing.vehicle.year,
              make: listing.vehicle.make,
              model: listing.vehicle.model
            }
          : null,
        location: listing.location
          ? {
              id: listing.location.id,
              name: listing.location.name
            }
          : null
      })),
      reviews: (hostProfile.reviews || [])
        .filter((review) => review.rating != null)
        .map(serializeReview)
    };
  },

  async getPublicReviewPrompt(token) {
    const review = await loadReviewByToken(token);
    return {
      review: serializeReview(review),
      host: serializeHostCard(review.hostProfile),
      trip: review.trip
        ? {
            id: review.trip.id,
            tripCode: review.trip.tripCode,
            status: review.trip.status,
            scheduledPickupAt: review.trip.scheduledPickupAt,
            scheduledReturnAt: review.trip.scheduledReturnAt,
            listingTitle: review.trip.listing?.title || '',
            vehicleLabel: [review.trip.listing?.vehicle?.year, review.trip.listing?.vehicle?.make, review.trip.listing?.vehicle?.model].filter(Boolean).join(' '),
            locationName: review.trip.listing?.location?.name || ''
          }
        : null
    };
  },

  async submitPublicReview(token, payload = {}) {
    const review = await loadReviewByToken(token, { allowSubmitted: false });
    const rating = Number(payload?.rating || 0);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new Error('rating must be an integer from 1 to 5');
    }
    const comments = payload?.comments ? String(payload.comments).trim() : null;
    const reviewerName = review.trip?.guestCustomer
      ? [review.trip.guestCustomer.firstName, review.trip.guestCustomer.lastName].filter(Boolean).join(' ').trim()
      : 'Guest';

    const updated = await prisma.hostReview.update({
      where: { id: review.id },
      data: {
        status: 'SUBMITTED',
        rating,
        comments,
        reviewerName,
        submittedAt: new Date()
      },
      include: {
        hostProfile: true,
        trip: {
          include: {
            listing: {
              include: {
                vehicle: true,
                location: true
              }
            },
            guestCustomer: true,
            reservation: true
          }
        }
      }
    });

    await prisma.tripTimelineEvent.create({
      data: {
        tripId: updated.tripId,
        eventType: 'HOST_REVIEW_SUBMITTED',
        actorType: 'GUEST',
        actorRefId: updated.guestCustomerId || null,
        notes: comments || `Guest submitted a ${rating}/5 host review`,
        metadata: JSON.stringify({
          reviewId: updated.id,
          rating
        })
      }
    });

    await refreshHostAggregate(updated.hostProfileId);
    const refreshedHost = await prisma.hostProfile.findUnique({ where: { id: updated.hostProfileId } });

    return {
      ok: true,
      review: serializeReview(updated),
      host: serializeHostCard(refreshedHost)
    };
  }
};
