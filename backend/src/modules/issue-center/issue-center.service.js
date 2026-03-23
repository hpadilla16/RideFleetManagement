import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';

function tenantWhereFor(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return {};
  if (user?.tenantId) return { tenantId: user.tenantId };
  return { tenantId: '__never__' };
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
      reservation: incident.trip.reservation ? {
        id: incident.trip.reservation.id,
        reservationNumber: incident.trip.reservation.reservationNumber,
        status: incident.trip.reservation.status,
        readyForPickupAt: incident.trip.reservation.readyForPickupAt,
        balance: money(incident.trip.reservation.rentalAgreement?.balance)
      } : null
    } : null
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
    name: incident?.trip?.guestCustomer ? [incident.trip.guestCustomer.firstName, incident.trip.guestCustomer.lastName].filter(Boolean).join(' ') : 'Customer',
    email: String(incident?.trip?.guestCustomer?.email || '').trim().toLowerCase()
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
      `Trip: ${incident.trip?.tripCode || '-'}`,
      incident.trip?.reservation?.reservationNumber ? `Reservation: ${incident.trip.reservation.reservationNumber}` : '',
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

  await createTimelineEvent(
    incident.tripId,
    'SYSTEM',
    null,
    'TRIP_INCIDENT_STATUS_NOTIFIED',
    `Issue status change emailed for ${nextStatus}`,
    {
      incidentId: incident.id,
      previousStatus,
      nextStatus
    }
  );
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
  await createTimelineEvent(
    trip.id,
    actor.actorType || 'SYSTEM',
    actor.actorRefId || null,
    'TRIP_INCIDENT_OPENED',
    title,
    {
      incidentId: incident.id,
      type,
      source: actor.source || null,
      amountClaimed
    }
  );

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

  const historyByIncidentId = new Map();
  for (const event of timeline) {
    const metadata = safeParse(event.metadata) || {};
    const incidentId = metadata?.incidentId;
    if (!incidentId) continue;
    if (!historyByIncidentId.has(incidentId)) historyByIncidentId.set(incidentId, []);
    historyByIncidentId.get(incidentId).push(serializeHistoryEntry(event));
  }

  return incidents.map((incident) => serializeIncident(incident, historyByIncidentId.get(incident.id) || []));
}

export const issueCenterService = {
  async getDashboard(user, input = {}) {
    const tenantScope = tenantWhereFor(user);
    const search = input?.q ? String(input.q).trim() : '';
    const searchFilter = search ? {
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { trip: { tripCode: { contains: search, mode: 'insensitive' } } },
        { trip: { reservation: { reservationNumber: { contains: search, mode: 'insensitive' } } } },
        { trip: { guestCustomer: { firstName: { contains: search, mode: 'insensitive' } } } },
        { trip: { guestCustomer: { lastName: { contains: search, mode: 'insensitive' } } } },
        { trip: { hostProfile: { displayName: { contains: search, mode: 'insensitive' } } } }
      ]
    } : {};

    const where = {
      trip: {
        ...tenantScope
      },
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

    const [openCount, reviewCount, resolvedCount, closedCount] = await Promise.all([
      prisma.tripIncident.count({ where: { trip: { ...tenantScope }, status: 'OPEN' } }),
      prisma.tripIncident.count({ where: { trip: { ...tenantScope }, status: 'UNDER_REVIEW' } }),
      prisma.tripIncident.count({ where: { trip: { ...tenantScope }, status: 'RESOLVED' } }),
      prisma.tripIncident.count({ where: { trip: { ...tenantScope }, status: 'CLOSED' } })
    ]);

    return {
      metrics: {
        open: openCount,
        underReview: reviewCount,
        resolved: resolvedCount,
        closed: closedCount,
        total: openCount + reviewCount + resolvedCount + closedCount
      },
      incidents: await attachHistory(incidents)
    };
  },

  async updateIncident(user, id, payload = {}) {
    const tenantScope = tenantWhereFor(user);
    const current = await prisma.tripIncident.findFirst({
      where: {
        id,
        trip: tenantScope
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

    await createTimelineEvent(
      current.tripId,
      'TENANT_USER',
      user?.id || user?.sub || null,
      'TRIP_INCIDENT_UPDATED',
      payload?.note ? String(payload.note).trim() : `Incident moved to ${nextStatus}`,
      {
        incidentId: updated.id,
        previousStatus: current.status,
        nextStatus,
        amountResolved: updated.amountResolved == null ? null : money(updated.amountResolved)
      }
    );

    if (current.status !== nextStatus) {
      await notifyIncidentStatusChange(updated, current.status, nextStatus, payload?.note ? String(payload.note).trim() : '');
    }

    if (['RESOLVED', 'CLOSED'].includes(nextStatus)) {
      await maybeResolveTripDispute(current.tripId);
    } else {
      await flagTripDisputed(current.tripId);
    }

    return (await attachHistory([updated]))[0];
  },

  async requestMoreInfo(user, id, payload = {}) {
    const tenantScope = tenantWhereFor(user);
    const incident = await prisma.tripIncident.findFirst({
      where: {
        id,
        trip: tenantScope
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
      `Trip: ${incident.trip?.tripCode || '-'}`,
      incident.trip?.reservation?.reservationNumber ? `Reservation: ${incident.trip.reservation.reservationNumber}` : '',
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

    await createTimelineEvent(
      incident.tripId,
      'TENANT_USER',
      user?.id || user?.sub || null,
      'TRIP_INCIDENT_INFO_REQUESTED',
      `Requested more information from ${recipient.recipientType.toLowerCase()}`,
      {
        incidentId: incident.id,
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

  async getPublicResponsePrompt(token) {
    const communication = await prisma.tripIncidentCommunication.findFirst({
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
    if (!communication?.incident) throw new Error('Invalid or expired response link');

    const incident = communication.incident;
    return {
      incident: serializeIncident(incident, (await attachHistory([incident]))[0]?.history || []),
      request: serializeCommunication(communication),
      responseLink: issueResponseLink(communication.publicToken)
    };
  },

  async submitPublicResponse(token, payload = {}) {
    const communication = await prisma.tripIncidentCommunication.findFirst({
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
    if (!communication?.incident) throw new Error('Invalid or expired response link');

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
        : communication.incident.trip?.guestCustomer?.id || null,
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

    await createTimelineEvent(
      communication.incident.tripId,
      senderType,
      senderType === 'HOST'
        ? communication.incident.trip?.hostProfile?.id || null
        : communication.incident.trip?.guestCustomer?.id || null,
      'TRIP_INCIDENT_REPLY_SUBMITTED',
      note,
      {
        incidentId: communication.incidentId,
        recipientType,
        attachmentCount: attachments.length
      }
    );

    const refreshed = await prisma.tripIncident.findUnique({
      where: { id: communication.incidentId },
      include: incidentInclude()
    });

    return refreshed ? (await attachHistory([refreshed]))[0] : null;
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
        select: { id: true }
      });

      if (reservation?.id) {
        trip = await prisma.trip.findFirst({
          where: {
            reservationId: reservation.id
          },
          include: incidentInclude().trip.include
        });
      }
    }

    if (!trip) throw new Error('Car sharing trip not found for that reference and email');

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
