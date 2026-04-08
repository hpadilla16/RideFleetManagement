import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { money } from '../../lib/money.js';
export { money };

export function tenantWhereFor(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return {};
  if (user?.tenantId) return { tenantId: user.tenantId };
  return { tenantId: '__never__' };
}

export function incidentTenantWhere(user) {
  const tenantScope = tenantWhereFor(user);
  if (!tenantScope.tenantId) return {};
  return {
    OR: [
      { trip: { tenantId: tenantScope.tenantId } },
      { reservation: { tenantId: tenantScope.tenantId } }
    ]
  };
}

export function incidentInclude() {
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
            vehicle: {
              select: {
                id: true,
                internalNumber: true,
                year: true,
                make: true,
                model: true,
                plate: true
              }
            },
            rentalAgreement: {
              include: {
                vehicle: {
                  select: {
                    id: true,
                    internalNumber: true,
                    year: true,
                    make: true,
                    model: true,
                    plate: true
                  }
                },
                vehicleSwaps: {
                  orderBy: [{ createdAt: 'asc' }],
                  select: {
                    id: true,
                    createdAt: true
                  }
                },
                inspections: {
                  orderBy: [{ createdAt: 'asc' }],
                  select: {
                    id: true,
                    phase: true,
                    capturedAt: true,
                    exterior: true,
                    interior: true,
                    tires: true,
                    lights: true,
                    windshield: true,
                    fuelLevel: true,
                    odometer: true,
                    damages: true,
                    notes: true,
                    photosJson: true
                  }
                }
              }
            }
          }
        }
      }
    },
    reservation: {
      include: {
        customer: true,
        vehicle: {
          select: {
            id: true,
            internalNumber: true,
            year: true,
            make: true,
            model: true,
            plate: true
          }
        },
        pickupLocation: true,
        returnLocation: true,
        rentalAgreement: {
          include: {
            vehicle: {
              select: {
                id: true,
                internalNumber: true,
                year: true,
                make: true,
                model: true,
                plate: true
              }
            },
            vehicleSwaps: {
              orderBy: [{ createdAt: 'asc' }],
              select: {
                id: true,
                createdAt: true
              }
            },
            inspections: {
              orderBy: [{ createdAt: 'asc' }],
              select: {
                id: true,
                phase: true,
                capturedAt: true,
                exterior: true,
                interior: true,
                tires: true,
                lights: true,
                windshield: true,
                fuelLevel: true,
                odometer: true,
                damages: true,
                notes: true,
                photosJson: true
              }
            }
          }
        }
      }
    },
    ownerUser: {
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true
      }
    },
    communications: {
      orderBy: [{ createdAt: 'desc' }]
    }
  };
}

export function vehicleSubmissionInclude() {
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

export function safeParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function serializeHistoryEntry(entry) {
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

export function serializeCommunication(entry) {
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

export function withIncidentOwnerRelation(data = {}, options = {}) {
  const allowDisconnect = options?.allowDisconnect !== false;
  const next = { ...data };
  if (Object.prototype.hasOwnProperty.call(next, 'ownerUserId')) {
    const ownerUserId = next.ownerUserId ? String(next.ownerUserId).trim() : '';
    delete next.ownerUserId;
    if (ownerUserId) {
      next.ownerUser = { connect: { id: ownerUserId } };
    } else if (allowDisconnect) {
      next.ownerUser = { disconnect: true };
    }
  }
  return next;
}

export function sortHistoryEntriesDesc(rows = []) {
  return [...rows].sort((left, right) => {
    const leftTime = left?.eventAt ? new Date(left.eventAt).getTime() : 0;
    const rightTime = right?.eventAt ? new Date(right.eventAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

export function serializeIncident(incident, history = []) {
  const reservation = incident.reservation || incident.trip?.reservation || null;
  const guestCustomer = incident.trip?.guestCustomer || reservation?.customer || null;
  return {
    id: incident.id,
    type: incident.type,
    status: incident.status,
    priority: incident.priority || 'MEDIUM',
    severity: incident.severity || 'LOW',
    title: incident.title,
    description: incident.description || '',
    dueAt: incident.dueAt || null,
    resolutionCode: incident.resolutionCode || null,
    liabilityDecision: incident.liabilityDecision || 'PENDING',
    chargeDecision: incident.chargeDecision || 'PENDING',
    recoveryStage: incident.recoveryStage || 'INTAKE',
    waiveReason: incident.waiveReason || '',
    customerChargeReady: !!incident.customerChargeReady,
    amountClaimed: money(incident.amountClaimed),
    amountResolved: money(incident.amountResolved),
    evidenceJson: incident.evidenceJson || '',
    resolvedAt: incident.resolvedAt,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    history,
    communications: Array.isArray(incident.communications) ? incident.communications.map(serializeCommunication) : [],
    evidenceChecklist: incident.evidenceChecklist || null,
    evidenceCapture: incident.evidenceCapture || null,
    evidenceRequestDrafts: incident.evidenceRequestDrafts || null,
    recoveryActions: incident.recoveryActions || null,
    inspectionCompare: incident.inspectionCompare || null,
    subjectType: incident.tripId ? 'TRIP' : 'RESERVATION',
    nextBestAction: incident.nextBestAction || null,
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
    } : null,
    operationalContext: incident.operationalContext || null,
    ownerUser: incident.ownerUser ? {
      id: incident.ownerUser.id,
      fullName: incident.ownerUser.fullName,
      email: incident.ownerUser.email,
      role: incident.ownerUser.role
    } : null
  };
}

export function serializeVehicleSubmission(submission) {
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

export function issueBaseUrl() {
  return (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export function issueResponseLink(token) {
  return token ? `${issueBaseUrl()}/issue-response?token=${encodeURIComponent(token)}` : '';
}

export function recipientForIncident(incident, recipientType) {
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

export async function createCommunication(incidentId, payload = {}) {
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

export async function sendIssueEmail({ to, subject, lines = [], htmlExtra = '' }) {
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

export function recipientForVehicleSubmission(submission) {
  return {
    recipientType: 'HOST',
    name: submission?.hostProfile?.displayName || 'Host',
    email: String(submission?.hostProfile?.email || '').trim().toLowerCase()
  };
}

export async function createVehicleSubmissionCommunication(submissionId, payload = {}) {
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

export async function notifyIncidentStatusChange(incident, previousStatus, nextStatus, note = '') {
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

export async function createTimelineEvent(tripId, actorType, actorRefId, eventType, notes, metadata = {}) {
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

export async function createReservationIncidentAuditEvent(reservationId, actorType, actorRefId, eventType, notes, metadata = {}) {
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

export async function createIncidentEvent(incident, actorType, actorRefId, eventType, notes, metadata = {}) {
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

export async function flagTripDisputed(tripId) {
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

export async function maybeResolveTripDispute(tripId) {
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

export async function createIncidentForTrip(trip, payload, actor = {}) {
  const type = String(payload?.type || '').trim().toUpperCase();
  const title = String(payload?.title || '').trim();
  if (!type) throw new Error('type is required');
  if (!title) throw new Error('title is required');
  const description = payload?.description ? String(payload.description).trim() : null;
  const evidenceJson = payload?.evidenceJson
    ? (typeof payload.evidenceJson === 'string' ? payload.evidenceJson : JSON.stringify(payload.evidenceJson))
    : null;
  const amountClaimed = payload?.amountClaimed === '' || payload?.amountClaimed == null
    ? null
    : Number(payload.amountClaimed);

  const incident = await prisma.tripIncident.create({
    data: withIncidentOwnerRelation({
      trip: { connect: { id: trip.id } },
      type,
      status: 'OPEN',
      priority: payload?.priority || 'MEDIUM',
      severity: payload?.severity || 'LOW',
      ownerUserId: payload?.ownerUserId || null,
      dueAt: payload?.dueAt || null,
      title,
      description,
      evidenceJson,
      amountClaimed: amountClaimed == null ? null : amountClaimed
    }, { allowDisconnect: false }),
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

export async function createIncidentForReservation(reservation, payload, actor = {}) {
  const type = String(payload?.type || '').trim().toUpperCase();
  const title = String(payload?.title || '').trim();
  if (!type) throw new Error('type is required');
  if (!title) throw new Error('title is required');
  const description = payload?.description ? String(payload.description).trim() : null;
  const evidenceJson = payload?.evidenceJson
    ? (typeof payload.evidenceJson === 'string' ? payload.evidenceJson : JSON.stringify(payload.evidenceJson))
    : null;
  const amountClaimed = payload?.amountClaimed === '' || payload?.amountClaimed == null
    ? null
    : Number(payload.amountClaimed);

  const incident = await prisma.tripIncident.create({
    data: withIncidentOwnerRelation({
      reservation: { connect: { id: reservation.id } },
      type,
      status: 'OPEN',
      priority: payload?.priority || 'MEDIUM',
      severity: payload?.severity || 'LOW',
      ownerUserId: payload?.ownerUserId || null,
      dueAt: payload?.dueAt || null,
      title,
      description,
      evidenceJson,
      amountClaimed: amountClaimed == null ? null : amountClaimed
    }, { allowDisconnect: false }),
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

export async function findTripForInternalIncident(user, payload = {}) {
  const id = payload?.tripId ? String(payload.tripId).trim() : '';
  const reference = payload?.reference ? String(payload.reference).trim() : '';
  if (!id && !reference) throw new Error('tripId or reference is required');

  const tenantScope = tenantWhereFor(user);
  const where = {
    ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {}),
    ...(id ? { id } : { tripCode: reference })
  };

  const trip = await prisma.trip.findFirst({
    where,
    include: incidentInclude().trip.include
  });
  if (!trip) throw new Error('Trip not found');
  return trip;
}

export async function findReservationForInternalIncident(user, payload = {}) {
  const id = payload?.reservationId ? String(payload.reservationId).trim() : '';
  const reference = payload?.reference ? String(payload.reference).trim() : '';
  if (!id && !reference) throw new Error('reservationId or reference is required');

  const tenantScope = tenantWhereFor(user);
  const where = {
    ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {}),
    ...(id ? { id } : { reservationNumber: reference })
  };

  const reservation = await prisma.reservation.findFirst({
    where,
    include: incidentInclude().reservation.include
  });
  if (!reservation) throw new Error('Reservation not found');
  return reservation;
}

export async function syncTollDisputeStatusForIncident(incident) {
  if (String(incident?.type || '').toUpperCase() !== 'TOLL') return;
  const evidence = safeParse(incident?.evidenceJson) || {};
  const tollTransactionId = evidence?.tollTransactionId ? String(evidence.tollTransactionId) : '';
  if (!tollTransactionId) return;

  const current = await prisma.tollTransaction.findUnique({
    where: { id: tollTransactionId },
    select: {
      id: true,
      reservationId: true,
      reviewNotes: true
    }
  });
  if (!current) return;

  const nextStatus = String(incident.status || '').toUpperCase();
  const resolved = ['RESOLVED', 'CLOSED'].includes(nextStatus);
  const nextReviewNote = [
    String(current.reviewNotes || '').trim(),
    `Issue Center ${incident.id} -> ${nextStatus}`
  ].filter(Boolean).join('\n');

  await prisma.tollTransaction.update({
    where: { id: tollTransactionId },
    data: resolved
      ? {
          status: current.reservationId ? 'MATCHED' : 'NEEDS_REVIEW',
          billingStatus: current.reservationId ? 'PENDING' : 'DISPUTED',
          needsReview: !current.reservationId,
          reviewNotes: nextReviewNote
        }
      : {
          status: 'DISPUTED',
          billingStatus: 'DISPUTED',
          needsReview: true,
          reviewNotes: nextReviewNote
        }
  });
}

export async function attachHistory(incidents) {
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

  return incidents.map((incident) => serializeIncident(incident, sortHistoryEntriesDesc(historyByIncidentId.get(incident.id) || [])));
}

export async function notifyVehicleSubmissionApproved(submission) {
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

export function createPublicReplyToken() {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 5);
  const link = issueResponseLink(token);
  return { token, expiresAt, link };
}
