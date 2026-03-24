import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';

function tenantWhereFor(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return {};
  if (user?.tenantId) return { tenantId: user.tenantId };
  return { tenantId: '__never__' };
}

function incidentTenantWhere(user) {
  const tenantScope = tenantWhereFor(user);
  if (!tenantScope.tenantId) return {};
  return {
    OR: [
      { trip: { tenantId: tenantScope.tenantId } },
      { reservation: { tenantId: tenantScope.tenantId } }
    ]
  };
}

function incidentInclude() {
  return {
    trip: {
      include: {
        listing: {
          include: {
            vehicle: true,
            location: true
          }
        },
        hostProfile: true,
        guestCustomer: true,
        reservation: {
          include: {
            rentalAgreement: true
          }
        }
      }
    },
    reservation: {
      include: {
        customer: true,
        pickupLocation: true,
        returnLocation: true,
        rentalAgreement: true
      }
    },
    communications: {
      orderBy: [{ createdAt: 'desc' }]
    }
  };
}

function vehicleSubmissionInclude() {
  return {
    hostProfile: true,
    vehicleType: true,
    preferredLocation: true,
    vehicle: {
      include: {
        vehicleType: true,
        homeLocation: true
      }
    },
    listing: {
      include: {
        vehicle: { include: { vehicleType: true } },
        location: true
      }
    },
    communications: {
      orderBy: [{ createdAt: 'desc' }]
    }
  };
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function safeParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function serializeHistoryEntry(entry) {
  return {
    id: entry.id,
    eventType: entry.eventType,
    eventAt: entry.eventAt,
    actorType: entry.actorType || '',
    actorRefId: entry.actorRefId || '',
    notes: entry.notes || '',
    metadata: safeParse(entry.metadata) || {}
  };
}

function serializeCommunication(entry) {
  return {
    id: entry.id,
    direction: entry.direction,
    channel: entry.channel,
    recipientType: entry.recipientType || '',
    senderType: entry.senderType || '',
    senderRefId: entry.senderRefId || '',
    subject: entry.subject || '',
    message: entry.message || '',
    attachments: safeParse(entry.attachmentsJson) || [],
    publicTokenExpiresAt: entry.publicTokenExpiresAt || null,
    respondedAt: entry.respondedAt || null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

function serializeIncident(incident, history = []) {
  const reservation = incident.reservation || incident.trip?.reservation || null;
  const guestCustomer = incident.trip?.guestCustomer || reservation?.customer || null;
  return {
    id: incident.id,
    type: incident.type,
    status: incident.status,
    title: incident.title,
    description: incident.description || '',
    amountClaimed: money(incident.amountClaimed),
    amountResolved: money(incident.amountResolved),
    evidenceJson: incident.evidenceJson || '',
    resolvedAt: incident.resolvedAt,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    history,
    communications: Array.isArray(incident.communications) ? incident.communications.map(serializeCommunication) : [],
    subjectType: incident.tripId ? 'TRIP' : 'RESERVATION',
    trip: incident.trip ? {
      id: incident.trip.id,
      tripCode: incident.trip.tripCode,
      status: incident.trip.status,
      quotedTotal: money(incident.trip.quotedTotal),
      hostEarnings: money(incident.trip.hostEarnings),
      platformFee: money(incident.trip.platformFee),
      scheduledPickupAt: incident.trip.scheduledPickupAt,
      scheduledReturnAt: incident.trip.scheduledReturnAt,
      hostProfile: incident.trip.hostProfile ? {
        id: incident.trip.hostProfile.id,
        displayName: incident.trip.hostProfile.displayName
      } : null,
      guestCustomer: incident.trip.guestCustomer ? {
        id: incident.trip.guestCustomer.id,
        firstName: incident.trip.guestCustomer.firstName,
        lastName: incident.trip.guestCustomer.lastName,
        email: incident.trip.guestCustomer.email
      } : null,
      listing: incident.trip.listing ? {
        id: incident.trip.listing.id,
        title: incident.trip.listing.title,
        vehicle: incident.trip.listing.vehicle ? {
          year: incident.trip.listing.vehicle.year,
          make: incident.trip.listing.vehicle.make,
          model: incident.trip.listing.vehicle.model
        } : null,
        location: incident.trip.listing.location ? {
          id: incident.trip.listing.location.id,
          name: incident.trip.listing.location.name
        } : null
      } : null,
      reservation: reservation ? {
        id: reservation.id,
        reservationNumber: reservation.reservationNumber,
        status: reservation.status,
        readyForPickupAt: reservation.readyForPickupAt,
        balance: money(reservation.rentalAgreement?.balance)
      } : null
    } : null,
    reservation: reservation ? {
      id: reservation.id,
      reservationNumber: reservation.reservationNumber,
      status: reservation.status,
      pickupAt: reservation.pickupAt,
      returnAt: reservation.returnAt,
      pickupLocation: reservation.pickupLocation ? {
        id: reservation.pickupLocation.id,
        name: reservation.pickupLocation.name
      } : null,
      returnLocation: reservation.returnLocation ? {
        id: reservation.returnLocation.id,
        name: reservation.returnLocation.name
      } : null,
      balance: money(reservation.rentalAgreement?.balance)
    } : null,
    guestCustomer: guestCustomer ? {
      id: guestCustomer.id,
      firstName: guestCustomer.firstName,
      lastName: guestCustomer.lastName,
      email: guestCustomer.email
    } : null
  };
}

function serializeVehicleSubmission(submission) {
  return {
    id: submission.id,
    status: submission.status,
    year: submission.year,
    make: submission.make || '',
    model: submission.model || '',
    color: submission.color || '',
    vin: submission.vin || '',
    plate: submission.plate || '',
    mileage: submission.mileage || 0,
    baseDailyRate: money(submission.baseDailyRate),
    cleaningFee: money(submission.cleaningFee),
    deliveryFee: money(submission.deliveryFee),
    securityDeposit: money(submission.securityDeposit),
    minTripDays: submission.minTripDays || 1,
    maxTripDays: submission.maxTripDays || null,
    shortDescription: submission.shortDescription || '',
    description: submission.description || '',
    tripRules: submission.tripRules || '',
    photos: safeParse(submission.photosJson) || [],
    insuranceDocumentUrl: submission.insuranceDocumentUrl || '',
    registrationDocumentUrl: submission.registrationDocumentUrl || '',
    initialInspectionDocumentUrl: submission.initialInspectionDocumentUrl || '',
    initialInspectionNotes: submission.initialInspectionNotes || '',
    addOns: safeParse(submission.addOnsJson) || [],
    reviewNotes: submission.reviewNotes || '',
    approvedAt: submission.approvedAt || null,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
    vehicleType: submission.vehicleType ? {
      id: submission.vehicleType.id,
      code: submission.vehicleType.code,
      name: submission.vehicleType.name
    } : null,
    preferredLocation: submission.preferredLocation ? {
      id: submission.preferredLocation.id,
      name: submission.preferredLocation.name
    } : null,
    hostProfile: submission.hostProfile ? {
      id: submission.hostProfile.id,
      displayName: submission.hostProfile.displayName,
      email: submission.hostProfile.email || '',
      phone: submission.hostProfile.phone || ''
    } : null,
    vehicle: submission.vehicle ? {
      id: submission.vehicle.id,
      internalNumber: submission.vehicle.internalNumber,
      fleetMode: submission.vehicle.fleetMode
    } : null,
    listing: submission.listing ? {
      id: submission.listing.id,
      title: submission.listing.title,
      status: submission.listing.status
    } : null,
    communications: Array.isArray(submission.communications) ? submission.communications.map(serializeCommunication) : []
  };
}

function issueBaseUrl() {
  return (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function issueResponseLink(token) {
  return token ? `${issueBaseUrl()}/issue-response?token=${encodeURIComponent(token)}` : '';
}

function recipientForIncident(incident, recipientType) {
  const target = String(recipientType || '').trim().toUpperCase();
  if (target === 'HOST') {
    return {
      recipientType: 'HOST',
      name: incident?.trip?.hostProfile?.displayName || 'Host',
      email: String(incident?.trip?.hostProfile?.email || '').trim().toLowerCase()
    };
  }
  return {
    recipientType: 'GUEST',
    name: incident?.trip?.guestCustomer
      ? [incident.trip.guestCustomer.firstName, incident.trip.guestCustomer.lastName].filter(Boolean).join(' ')
      : incident?.reservation?.customer
        ? [incident.reservation.customer.firstName, incident.reservation.customer.lastName].filter(Boolean).join(' ')
        : 'Customer',
    email: String(incident?.trip?.guestCustomer?.email || incident?.reservation?.customer?.email || '').trim().toLowerCase()
  };
}

async function createCommunication(incidentId, payload = {}) {
  return prisma.tripIncidentCommunication.create({
    data: {
      incidentId,
      direction: payload.direction || 'OUTBOUND',
      channel: payload.channel || 'EMAIL',
      recipientType: payload.recipientType || null,
      senderType: payload.senderType || null,
      senderRefId: payload.senderRefId || null,
      subject: payload.subject || null,
      message: payload.message || null,
      attachmentsJson: payload.attachments && payload.attachments.length ? JSON.stringify(payload.attachments) : null,
      publicToken: payload.publicToken || null,
      publicTokenExpiresAt: payload.publicTokenExpiresAt || null,
      respondedAt: payload.respondedAt || null
    }
  });
}

async function sendIssueEmail({ to, subject, lines = [], htmlExtra = '' }) {
  const safeLines = lines.filter(Boolean).map((line) => String(line));
  const text = safeLines.join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">
      ${safeLines.map((line) => `<div>${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>`).join('')}
      ${htmlExtra}
    </div>
  `;
  return sendEmail({ to, subject, text, html });
}

function recipientForVehicleSubmission(submission) {
  return {
    recipientType: 'HOST',
    name: submission?.hostProfile?.displayName || 'Host',
    email: String(submission?.hostProfile?.email || '').trim().toLowerCase()
  };
}

async function createVehicleSubmissionCommunication(submissionId, payload = {}) {
  return prisma.hostVehicleSubmissionCommunication.create({
    data: {
      submissionId,
      direction: payload.direction || 'OUTBOUND',
      channel: payload.channel || 'EMAIL',
      recipientType: payload.recipientType || null,
      senderType: payload.senderType || null,
      senderRefId: payload.senderRefId || null,
      subject: payload.subject || null,
      message: payload.message || null,
      attachmentsJson: payload.attachments && payload.attachments.length ? JSON.stringify(payload.attachments) : null,
      publicToken: payload.publicToken || null,
      publicTokenExpiresAt: payload.publicTokenExpiresAt || null,
      respondedAt: payload.respondedAt || null
    }
  });
}

async function notifyIncidentStatusChange(incident, previousStatus, nextStatus, note = '') {
  const recipients = [
    recipientForIncident(incident, 'GUEST'),
    recipientForIncident(incident, 'HOST')
  ].filter((row) => row.email);

  await Promise.all(recipients.map(async (recipient) => {
    const subject = `Issue Update: ${incident.title}`;
    const message = [
      `Hello ${recipient.name || (recipient.recipientType === 'HOST' ? 'Host' : 'Customer')},`,
      '',
      `The issue "${incident.title}" is now ${nextStatus}.`,
      `Previous status: ${previousStatus}`,
      incident.trip?.tripCode ? `Trip: ${incident.trip.tripCode}` : '',
      (incident.reservation?.reservationNumber || incident.trip?.reservation?.reservationNumber)
        ? `Reservation: ${incident.reservation?.reservationNumber || incident.trip?.reservation?.reservationNumber}`
        : '',
      note ? `Representative note: ${note}` : '',
      '',
      'Customer service is actively tracking this case.'
    ].filter(Boolean);

    try {
      await sendIssueEmail({ to: recipient.email, subject, lines: message });
      await createCommunication(incident.id, {
        direction: 'OUTBOUND',
        channel: 'EMAIL',
        recipientType: recipient.recipientType,
        senderType: 'SYSTEM',
        subject,
        message: message.join('\n')
      });
    } catch {}
  }));

  await createIncidentEvent(incident, 'SYSTEM', null, 'TRIP_INCIDENT_STATUS_NOTIFIED', `Issue status change emailed for ${nextStatus}`, {
    previousStatus,
    nextStatus
  });
}

async function createTimelineEvent(tripId, actorType, actorRefId, eventType, notes, metadata = {}) {
  await prisma.tripTimelineEvent.create({
    data: {
      tripId,
      eventType,
      actorType,
      actorRefId: actorRefId || null,
      notes: notes || null,
      metadata: Object.keys(metadata || {}).length ? JSON.stringify(metadata) : null
    }
  });
}

async function createReservationIncidentAuditEvent(reservationId, actorType, actorRefId, eventType, notes, metadata = {}) {
  if (!reservationId) return;
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { tenantId: true }
  });
  await prisma.auditLog.create({
    data: {
      tenantId: reservation?.tenantId || null,
      reservationId,
      action: 'UPDATE',
      actorUserId: actorType === 'TENANT_USER' ? (actorRefId || null) : null,
      reason: notes || null,
      metadata: JSON.stringify({
        issueHistoryEvent: {
          eventType,
          actorType,
          actorRefId: actorRefId || '',
          notes: notes || '',
          ...metadata
        }
      })
    }
  });
}

async function createIncidentEvent(incident, actorType, actorRefId, eventType, notes, metadata = {}) {
  const baseMetadata = {
    incidentId: incident.id,
    ...metadata
  };
  if (incident.tripId) {
    await createTimelineEvent(incident.tripId, actorType, actorRefId, eventType, notes, baseMetadata);
    return;
  }
  await createReservationIncidentAuditEvent(incident.reservationId, actorType, actorRefId, eventType, notes, baseMetadata);
}

async function flagTripDisputed(tripId) {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { id: true, status: true }
  });
  if (!trip || trip.status === 'DISPUTED') return;
  await prisma.trip.update({
    where: { id: tripId },
    data: { status: 'DISPUTED' }
  });
}

async function maybeResolveTripDispute(tripId) {
  const remaining = await prisma.tripIncident.count({
    where: {
      tripId,
      status: { in: ['OPEN', 'UNDER_REVIEW'] }
    }
  });
  if (remaining > 0) return;
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { id: true, status: true }
  });
  if (trip?.status === 'DISPUTED') {
    await prisma.trip.update({
      where: { id: tripId },
      data: { status: 'COMPLETED' }
    });
  }
}

async function createIncidentForTrip(trip, payload, actor = {}) {
  const type = String(payload?.type || '').trim().toUpperCase();
  const title = String(payload?.title || '').trim();
  if (!type) throw new Error('type is required');
  if (!title) throw new Error('title is required');
  const description = payload?.description ? String(payload.description).trim() : null;
  const amountClaimed = payload?.amountClaimed === '' || payload?.amountClaimed == null
    ? null
    : Number(payload.amountClaimed);

  const incident = await prisma.tripIncident.create({
    data: {
      tripId: trip.id,
      type,
      status: 'OPEN',
      title,
      description,
      amountClaimed: amountClaimed == null ? null : amountClaimed
    },
    include: incidentInclude()
  });

  await flagTripDisputed(trip.id);
  await createIncidentEvent(incident, actor.actorType || 'SYSTEM', actor.actorRefId || null, 'TRIP_INCIDENT_OPENED', title, {
    type,
    source: actor.source || null,
    amountClaimed
  });

  const historyEntry = {
    id: `open-${incident.id}`,
    eventType: 'TRIP_INCIDENT_OPENED',
    eventAt: incident.createdAt,
    actorType: actor.actorType || 'SYSTEM',
    actorRefId: actor.actorRefId || '',
    notes: title,
    metadata: {
      incidentId: incident.id,
      type,
      source: actor.source || null,
      amountClaimed: amountClaimed == null ? null : money(amountClaimed)
    }
  };

  return serializeIncident(incident, [historyEntry]);
}

async function createIncidentForReservation(reservation, payload, actor = {}) {
  const type = String(payload?.type || '').trim().toUpperCase();
  const title = String(payload?.title || '').trim();
  if (!type) throw new Error('type is required');
  if (!title) throw new Error('title is required');
  const description = payload?.description ? String(payload.description).trim() : null;
  const amountClaimed = payload?.amountClaimed === '' || payload?.amountClaimed == null
    ? null
    : Number(payload.amountClaimed);

  const incident = await prisma.tripIncident.create({
    data: {
      reservationId: reservation.id,
      type,
      status: 'OPEN',
      title,
      description,
      amountClaimed: amountClaimed == null ? null : amountClaimed
    },
    include: incidentInclude()
  });

  await createIncidentEvent(incident, actor.actorType || 'SYSTEM', actor.actorRefId || null, 'TRIP_INCIDENT_OPENED', title, {
    type,
    source: actor.source || null,
    amountClaimed
  });

  const historyEntry = {
    id: `open-${incident.id}`,
    eventType: 'TRIP_INCIDENT_OPENED',
    eventAt: incident.createdAt,
    actorType: actor.actorType || 'SYSTEM',
    actorRefId: actor.actorRefId || '',
    notes: title,
    metadata: {
      incidentId: incident.id,
      type,
      source: actor.source || null,
      amountClaimed: amountClaimed == null ? null : money(amountClaimed)
    }
  };

  return serializeIncident(incident, [historyEntry]);
}

async function attachHistory(incidents) {
  if (!incidents.length) return incidents.map((incident) => serializeIncident(incident, []));

  const tripIds = [...new Set(incidents.map((incident) => incident.tripId).filter(Boolean))];
  const reservationIds = [...new Set(incidents.map((incident) => incident.reservationId || incident.trip?.reservation?.id).filter(Boolean))];
  const timeline = await prisma.tripTimelineEvent.findMany({
    where: {
      tripId: { in: tripIds },
      eventType: {
        in: [
          'TRIP_INCIDENT_OPENED',
          'TRIP_INCIDENT_UPDATED',
          'TRIP_INCIDENT_STATUS_NOTIFIED',
          'TRIP_INCIDENT_INFO_REQUESTED',
          'TRIP_INCIDENT_REPLY_SUBMITTED'
        ]
      }
    },
    orderBy: [{ eventAt: 'desc' }]
  });
  const auditLogs = reservationIds.length
    ? await prisma.auditLog.findMany({
        where: {
          reservationId: { in: reservationIds }
        },
        orderBy: [{ createdAt: 'desc' }]
      })
    : [];

  const historyByIncidentId = new Map();
  for (const event of timeline) {
    const metadata = safeParse(event.metadata) || {};
    const incidentId = metadata?.incidentId;
    if (!incidentId) continue;
    if (!historyByIncidentId.has(incidentId)) historyByIncidentId.set(incidentId, []);
    historyByIncidentId.get(incidentId).push(serializeHistoryEntry(event));
  }
  for (const audit of auditLogs) {
    const metadata = safeParse(audit.metadata) || {};
    const issueHistory = metadata?.issueHistoryEvent;
    const incidentId = issueHistory?.incidentId;
    if (!incidentId) continue;
    if (!historyByIncidentId.has(incidentId)) historyByIncidentId.set(incidentId, []);
    historyByIncidentId.get(incidentId).push({
      id: audit.id,
      eventType: issueHistory.eventType || 'TRIP_INCIDENT_UPDATED',
      eventAt: audit.createdAt,
      actorType: issueHistory.actorType || '',
      actorRefId: issueHistory.actorRefId || '',
      notes: issueHistory.notes || audit.reason || '',
      metadata: issueHistory
    });
  }

  return incidents.map((incident) => serializeIncident(incident, historyByIncidentId.get(incident.id) || []));
}

async function notifyVehicleSubmissionApproved(submission) {
  const recipient = recipientForVehicleSubmission(submission);
  if (!recipient.email) return;
  const subject = `Vehicle Approved: ${[submission.year, submission.make, submission.model].filter(Boolean).join(' ') || 'Your vehicle'}`;
  const lines = [
    `Hello ${recipient.name},`,
    '',
    'Your vehicle submission was approved and is now active in your host portal.',
    `Vehicle: ${[submission.year, submission.make, submission.model].filter(Boolean).join(' ') || '-'}`,
    submission.listing?.title ? `Listing: ${submission.listing.title}` : '',
    submission.vehicle?.internalNumber ? `Fleet Number: ${submission.vehicle.internalNumber}` : '',
    '',
    'You can now manage pricing, availability, and host-only add-ons from your host app.'
  ].filter(Boolean);

  try {
    await sendIssueEmail({ to: recipient.email, subject, lines });
    await createVehicleSubmissionCommunication(submission.id, {
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      recipientType: 'HOST',
      senderType: 'SYSTEM',
      subject,
      message: lines.join('\n')
    });
  } catch {}
}

export const issueCenterService = {
  notifyHostVehicleSubmissionApproved: notifyVehicleSubmissionApproved,

  async getDashboard(user, input = {}) {
    const tenantScope = tenantWhereFor(user);
    const incidentScope = incidentTenantWhere(user);
    const search = input?.q ? String(input.q).trim() : '';
    const searchFilter = search ? {
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { trip: { tripCode: { contains: search, mode: 'insensitive' } } },
        { trip: { reservation: { reservationNumber: { contains: search, mode: 'insensitive' } } } },
        { reservation: { reservationNumber: { contains: search, mode: 'insensitive' } } },
        { trip: { guestCustomer: { firstName: { contains: search, mode: 'insensitive' } } } },
        { trip: { guestCustomer: { lastName: { contains: search, mode: 'insensitive' } } } },
        { reservation: { customer: { firstName: { contains: search, mode: 'insensitive' } } } },
        { reservation: { customer: { lastName: { contains: search, mode: 'insensitive' } } } },
        { trip: { hostProfile: { displayName: { contains: search, mode: 'insensitive' } } } }
      ]
    } : {};

    const where = {
      ...incidentScope,
      ...(input?.status ? { status: String(input.status).toUpperCase() } : {}),
      ...(input?.type ? { type: String(input.type).toUpperCase() } : {}),
      ...searchFilter
    };

    const incidents = await prisma.tripIncident.findMany({
      where,
      include: incidentInclude(),
      orderBy: [{ createdAt: 'desc' }],
      take: 100
    });

    const submissionWhere = {
      tenantId: tenantScope.tenantId || undefined,
      ...(
        search
          ? {
              OR: [
                { make: { contains: search, mode: 'insensitive' } },
                { model: { contains: search, mode: 'insensitive' } },
                { plate: { contains: search, mode: 'insensitive' } },
                { vin: { contains: search, mode: 'insensitive' } },
                { hostProfile: { displayName: { contains: search, mode: 'insensitive' } } }
              ]
            }
          : {}
      )
    };

    const vehicleSubmissions = await prisma.hostVehicleSubmission.findMany({
      where: submissionWhere,
      include: vehicleSubmissionInclude(),
      orderBy: [{ createdAt: 'desc' }],
      take: 100
    });

    const [openCount, reviewCount, resolvedCount, closedCount, submissionPendingCount] = await Promise.all([
      prisma.tripIncident.count({ where: { ...incidentScope, status: 'OPEN' } }),
      prisma.tripIncident.count({ where: { ...incidentScope, status: 'UNDER_REVIEW' } }),
      prisma.tripIncident.count({ where: { ...incidentScope, status: 'RESOLVED' } }),
      prisma.tripIncident.count({ where: { ...incidentScope, status: 'CLOSED' } }),
      prisma.hostVehicleSubmission.count({
        where: {
          tenantId: tenantScope.tenantId || undefined,
          status: { in: ['PENDING_REVIEW', 'PENDING_INFO'] }
        }
      })
    ]);

    return {
      metrics: {
        open: openCount,
        underReview: reviewCount,
        resolved: resolvedCount,
        closed: closedCount,
        total: openCount + reviewCount + resolvedCount + closedCount,
        vehicleApprovalsPending: submissionPendingCount
      },
      incidents: await attachHistory(incidents),
      vehicleSubmissions: vehicleSubmissions.map(serializeVehicleSubmission)
    };
  },

  async updateIncident(user, id, payload = {}) {
    const current = await prisma.tripIncident.findFirst({
      where: {
        id,
        ...incidentTenantWhere(user)
      },
      include: incidentInclude()
    });
    if (!current) throw new Error('Incident not found');

    const nextStatus = payload?.status ? String(payload.status).trim().toUpperCase() : current.status;
    const nextTitle = payload?.title ? String(payload.title).trim() : current.title;
    if (!nextTitle) throw new Error('title is required');

    const updated = await prisma.tripIncident.update({
      where: { id },
      data: {
        status: nextStatus,
        title: nextTitle,
        description: Object.prototype.hasOwnProperty.call(payload, 'description')
          ? (payload.description ? String(payload.description).trim() : null)
          : current.description,
        amountResolved: Object.prototype.hasOwnProperty.call(payload, 'amountResolved')
          ? (payload.amountResolved === '' || payload.amountResolved == null ? null : Number(payload.amountResolved))
          : current.amountResolved,
        resolvedAt: ['RESOLVED', 'CLOSED'].includes(nextStatus) ? (current.resolvedAt || new Date()) : null
      },
      include: incidentInclude()
    });

    await createIncidentEvent(
      updated,
      'TENANT_USER',
      user?.id || user?.sub || null,
      'TRIP_INCIDENT_UPDATED',
      payload?.note ? String(payload.note).trim() : `Incident moved to ${nextStatus}`,
      {
        previousStatus: current.status,
        nextStatus,
        amountResolved: updated.amountResolved == null ? null : money(updated.amountResolved)
      }
    );

    if (current.status !== nextStatus) {
      await notifyIncidentStatusChange(updated, current.status, nextStatus, payload?.note ? String(payload.note).trim() : '');
    }

    if (current.tripId && ['RESOLVED', 'CLOSED'].includes(nextStatus)) {
      await maybeResolveTripDispute(current.tripId);
    } else if (current.tripId) {
      await flagTripDisputed(current.tripId);
    }

    return (await attachHistory([updated]))[0];
  },

  async requestMoreInfo(user, id, payload = {}) {
    const incident = await prisma.tripIncident.findFirst({
      where: {
        id,
        ...incidentTenantWhere(user)
      },
      include: incidentInclude()
    });
    if (!incident) throw new Error('Incident not found');

    const recipient = recipientForIncident(incident, payload?.recipientType || 'GUEST');
    if (!recipient.email) {
      throw new Error(`${recipient.recipientType === 'HOST' ? 'Host' : 'Guest'} email is not available for this issue`);
    }

    const note = String(payload?.note || '').trim();
    if (!note) throw new Error('note is required');

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 5);
    const link = issueResponseLink(token);
    const subject = `More information needed for issue: ${incident.title}`;
    const message = [
      `Hello ${recipient.name || (recipient.recipientType === 'HOST' ? 'Host' : 'Customer')},`,
      '',
      'Customer service needs more information to continue processing this issue.',
      `Issue: ${incident.title}`,
      incident.trip?.tripCode ? `Trip: ${incident.trip.tripCode}` : '',
      (incident.reservation?.reservationNumber || incident.trip?.reservation?.reservationNumber)
        ? `Reservation: ${incident.reservation?.reservationNumber || incident.trip?.reservation?.reservationNumber}`
        : '',
      '',
      `Representative note: ${note}`,
      '',
      `Reply here: ${link}`,
      `This link expires on ${expiresAt.toLocaleString()}.`
    ];

    await sendIssueEmail({
      to: recipient.email,
      subject,
      lines: message,
      htmlExtra: `<div style="margin-top:16px"><a href="${link}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#7c3aed;color:#fff;text-decoration:none;font-weight:700">Reply To Issue</a></div>`
    });

    await createCommunication(incident.id, {
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      recipientType: recipient.recipientType,
      senderType: 'TENANT_USER',
      senderRefId: user?.id || user?.sub || null,
      subject,
      message: note,
      publicToken: token,
      publicTokenExpiresAt: expiresAt
    });

    await createIncidentEvent(
      incident,
      'TENANT_USER',
      user?.id || user?.sub || null,
      'TRIP_INCIDENT_INFO_REQUESTED',
      `Requested more information from ${recipient.recipientType.toLowerCase()}`,
      {
        recipientType: recipient.recipientType,
        link,
        expiresAt: expiresAt.toISOString()
      }
    );

    return {
      ok: true,
      recipientType: recipient.recipientType,
      email: recipient.email,
      link,
      expiresAt
    };
  },

  async requestVehicleSubmissionInfo(user, id, payload = {}) {
    const tenantScope = tenantWhereFor(user);
    const submission = await prisma.hostVehicleSubmission.findFirst({
      where: {
        id,
        ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {})
      },
      include: vehicleSubmissionInclude()
    });
    if (!submission) throw new Error('Vehicle submission not found');

    const recipient = recipientForVehicleSubmission(submission);
    if (!recipient.email) throw new Error('Host email is not available for this vehicle submission');

    const note = String(payload?.note || '').trim();
    if (!note) throw new Error('note is required');

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 5);
    const link = issueResponseLink(token);
    const subject = `More information needed for vehicle approval`;
    const message = [
      `Hello ${recipient.name},`,
      '',
      'Customer service needs more information before approving your vehicle submission.',
      `Vehicle: ${[submission.year, submission.make, submission.model].filter(Boolean).join(' ') || '-'}`,
      '',
      `Representative note: ${note}`,
      '',
      `Reply here: ${link}`,
      `This link expires on ${expiresAt.toLocaleString()}.`
    ];

    await sendIssueEmail({
      to: recipient.email,
      subject,
      lines: message,
      htmlExtra: `<div style="margin-top:16px"><a href="${link}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#7c3aed;color:#fff;text-decoration:none;font-weight:700">Reply To Vehicle Review</a></div>`
    });

    await prisma.hostVehicleSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'PENDING_INFO',
        reviewNotes: note
      }
    });

    await createVehicleSubmissionCommunication(submission.id, {
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      recipientType: 'HOST',
      senderType: 'TENANT_USER',
      senderRefId: user?.id || user?.sub || null,
      subject,
      message: note,
      publicToken: token,
      publicTokenExpiresAt: expiresAt
    });

    return {
      ok: true,
      recipientType: 'HOST',
      email: recipient.email,
      link,
      expiresAt
    };
  },

  async getPublicResponsePrompt(token) {
    const incidentCommunication = await prisma.tripIncidentCommunication.findFirst({
      where: {
        publicToken: String(token || '').trim(),
        publicTokenExpiresAt: { gt: new Date() }
      },
      include: {
        incident: {
          include: incidentInclude()
        }
      }
    });
    if (incidentCommunication?.incident) {
      const incident = incidentCommunication.incident;
      return {
        caseType: 'TRIP_INCIDENT',
        incident: serializeIncident(incident, (await attachHistory([incident]))[0]?.history || []),
        request: serializeCommunication(incidentCommunication),
        responseLink: issueResponseLink(incidentCommunication.publicToken)
      };
    }

    const submissionCommunication = await prisma.hostVehicleSubmissionCommunication.findFirst({
      where: {
        publicToken: String(token || '').trim(),
        publicTokenExpiresAt: { gt: new Date() }
      },
      include: {
        submission: {
          include: vehicleSubmissionInclude()
        }
      }
    });
    if (!submissionCommunication?.submission) throw new Error('Invalid or expired response link');

    return {
      caseType: 'HOST_VEHICLE_SUBMISSION',
      submission: serializeVehicleSubmission(submissionCommunication.submission),
      request: serializeCommunication(submissionCommunication),
      responseLink: issueResponseLink(submissionCommunication.publicToken)
    };
  },

  async submitPublicResponse(token, payload = {}) {
    const incidentCommunication = await prisma.tripIncidentCommunication.findFirst({
      where: {
        publicToken: String(token || '').trim(),
        publicTokenExpiresAt: { gt: new Date() }
      },
      include: {
        incident: {
          include: incidentInclude()
        }
      }
    });
    if (incidentCommunication?.incident) {
      const communication = incidentCommunication;
      const note = String(payload?.message || '').trim();
      if (!note) throw new Error('message is required');
      const attachments = Array.isArray(payload?.attachments)
        ? payload.attachments
            .map((item) => ({
              name: String(item?.name || 'document').trim(),
              dataUrl: String(item?.dataUrl || '').trim()
            }))
            .filter((item) => item.dataUrl)
            .slice(0, 6)
        : [];

      const recipientType = String(communication.recipientType || '').toUpperCase() === 'HOST' ? 'HOST' : 'GUEST';
      const senderType = recipientType === 'HOST' ? 'HOST' : 'GUEST';

      await createCommunication(communication.incidentId, {
        direction: 'INBOUND',
        channel: 'PORTAL',
        recipientType,
        senderType,
        senderRefId: senderType === 'HOST'
          ? communication.incident.trip?.hostProfile?.id || null
          : communication.incident.trip?.guestCustomer?.id || communication.incident.reservation?.customer?.id || null,
        subject: `Issue reply from ${recipientType.toLowerCase()}`,
        message: note,
        attachments
      });

      await prisma.tripIncidentCommunication.update({
        where: { id: communication.id },
        data: {
          respondedAt: new Date()
        }
      });

      await createIncidentEvent(
        communication.incident,
        senderType,
        senderType === 'HOST'
          ? communication.incident.trip?.hostProfile?.id || null
          : communication.incident.trip?.guestCustomer?.id || communication.incident.reservation?.customer?.id || null,
        'TRIP_INCIDENT_REPLY_SUBMITTED',
        note,
        {
          recipientType,
          attachmentCount: attachments.length
        }
      );

      const refreshed = await prisma.tripIncident.findUnique({
        where: { id: communication.incidentId },
        include: incidentInclude()
      });

      return refreshed ? (await attachHistory([refreshed]))[0] : null;
    }

    const submissionCommunication = await prisma.hostVehicleSubmissionCommunication.findFirst({
      where: {
        publicToken: String(token || '').trim(),
        publicTokenExpiresAt: { gt: new Date() }
      },
      include: {
        submission: {
          include: vehicleSubmissionInclude()
        }
      }
    });
    if (!submissionCommunication?.submission) throw new Error('Invalid or expired response link');

    const note = String(payload?.message || '').trim();
    if (!note) throw new Error('message is required');
    const attachments = Array.isArray(payload?.attachments)
      ? payload.attachments
          .map((item) => ({
            name: String(item?.name || 'document').trim(),
            dataUrl: String(item?.dataUrl || '').trim()
          }))
          .filter((item) => item.dataUrl)
          .slice(0, 6)
      : [];

    await createVehicleSubmissionCommunication(submissionCommunication.submissionId, {
      direction: 'INBOUND',
      channel: 'PORTAL',
      recipientType: 'HOST',
      senderType: 'HOST',
      senderRefId: submissionCommunication.submission.hostProfileId,
      subject: 'Vehicle approval reply from host',
      message: note,
      attachments
    });

    await prisma.hostVehicleSubmissionCommunication.update({
      where: { id: submissionCommunication.id },
      data: {
        respondedAt: new Date()
      }
    });

    await prisma.hostVehicleSubmission.update({
      where: { id: submissionCommunication.submissionId },
      data: {
        status: 'PENDING_REVIEW'
      }
    });

    return serializeVehicleSubmission(await prisma.hostVehicleSubmission.findUnique({
      where: { id: submissionCommunication.submissionId },
      include: vehicleSubmissionInclude()
    }));
  },

  async createGuestIncident(input = {}) {
    const reference = input?.reference ? String(input.reference).trim() : '';
    const email = input?.email ? String(input.email).trim().toLowerCase() : '';
    if (!reference) throw new Error('reference is required');
    if (!email) throw new Error('email is required');

    const customerFilter = {
      email: {
        equals: email,
        mode: 'insensitive'
      }
    };

    let trip = await prisma.trip.findFirst({
      where: {
        tripCode: reference,
        guestCustomer: customerFilter
      },
      include: incidentInclude().trip.include
    });

    if (!trip) {
      const reservation = await prisma.reservation.findFirst({
        where: {
          reservationNumber: reference,
          customer: customerFilter
        },
        include: incidentInclude().reservation.include
      });

      if (reservation?.id) {
        trip = await prisma.trip.findFirst({
          where: {
            reservationId: reservation.id
          },
          include: incidentInclude().trip.include
        });

        if (!trip) {
          return createIncidentForReservation(reservation, input, {
            actorType: 'GUEST',
            actorRefId: reservation.customerId,
            source: 'guest-app'
          });
        }
      }
    }

    if (!trip) throw new Error('Booking not found for that reference and email');

    return createIncidentForTrip(trip, input, {
      actorType: 'GUEST',
      actorRefId: trip.guestCustomerId,
      source: 'guest-app'
    });
  },

  async createIncidentForHost(user, tripId, payload = {}) {
    const role = String(user?.role || '').toUpperCase();
    const trip = await prisma.trip.findFirst({
      where: role === 'SUPER_ADMIN'
        ? { id: tripId }
        : role === 'ADMIN' || role === 'OPS'
          ? { id: tripId, ...(user?.tenantId ? { tenantId: user.tenantId } : {}) }
          : { id: tripId, hostProfile: { userId: user?.id || user?.sub || null } },
      include: incidentInclude().trip.include
    });
    if (!trip) throw new Error('Trip not found for this host');

    return createIncidentForTrip(trip, payload, {
      actorType: role === 'ADMIN' || role === 'OPS' || role === 'SUPER_ADMIN' ? 'TENANT_USER' : 'HOST',
      actorRefId: user?.id || user?.sub || null,
      source: 'host-app'
    });
  }
};
