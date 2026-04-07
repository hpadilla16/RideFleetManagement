import { prisma } from '../../lib/prisma.js';
import { settingsService } from '../settings/settings.service.js';
import { buildVehicleOperationalSignalsMap } from '../vehicles/vehicle-intelligence.service.js';
import { normalizeIssueResponseAttachments } from './issue-center-attachments.js';
import { normalizeIncidentWorkflowFields } from './issue-center-claims-fields.js';
import { buildIncidentEvidenceChecklist } from './issue-center-evidence-checklist.js';
import { buildIncidentEvidenceCapture } from './issue-center-evidence-capture.js';
import { buildIncidentEvidenceRequestDrafts, buildIncidentEvidenceRequestNote } from './issue-center-evidence-request.js';
import { buildIncidentChargeDraft } from './issue-center-charge-draft.js';
import { buildIncidentInspectionCompare } from './issue-center-inspection-compare.js';
import { buildIncidentNextBestAction } from './issue-center-next-best-action.js';
import { buildIncidentClaimsPacket } from './issue-center-packets.js';
import { buildIncidentClaimsPacketHtml } from './issue-center-packet-html.js';
import { buildIncidentRecoveryActions } from './issue-center-recovery-actions.js';
import { buildIssueRequestWorkflowUpdate } from './issue-center-request-workflow.js';
import { buildIncidentWorkflowActionUpdate } from './issue-center-workflow-actions.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';
import { rentalAgreementsService } from '../rental-agreements/rental-agreements.service.js';
import {
  attachHistory,
  createCommunication,
  createIncidentEvent,
  createIncidentForReservation,
  createIncidentForTrip,
  createPublicReplyToken,
  findReservationForInternalIncident,
  findTripForInternalIncident,
  flagTripDisputed,
  incidentInclude,
  incidentTenantWhere,
  money,
  notifyIncidentStatusChange,
  recipientForIncident,
  issueResponseLink,
  sendIssueEmail,
  serializeCommunication,
  syncTollDisputeStatusForIncident,
  tenantWhereFor,
  withIncidentOwnerRelation
} from './issue-center-core.js';

async function resolveAssignableOwnerUserId(user, ownerUserId) {
  const normalized = ownerUserId ? String(ownerUserId).trim() : '';
  if (!normalized) return null;
  const tenantScope = tenantWhereFor(user);
  const owner = await prisma.user.findFirst({
    where: {
      id: normalized,
      isActive: true,
      ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {})
    },
    select: { id: true }
  });
  if (!owner) throw new Error('ownerUserId is not valid for this tenant');
  return owner.id;
}

function resolveIncidentVehicle(incident) {
  const reservation = incident?.reservation || incident?.trip?.reservation || null;
  const agreement = reservation?.rentalAgreement || null;
  const vehicle = agreement?.vehicle || reservation?.vehicle || incident?.trip?.listing?.vehicle || null;
  return {
    vehicle: vehicle
      ? {
          id: vehicle.id,
          internalNumber: vehicle.internalNumber || null,
          year: vehicle.year ?? null,
          make: vehicle.make || null,
          model: vehicle.model || null,
          plate: vehicle.plate || null
        }
      : null,
    swapCount: Array.isArray(agreement?.vehicleSwaps) ? agreement.vehicleSwaps.length : 0
  };
}

async function attachOperationalContext(user, incidents = []) {
  if (!Array.isArray(incidents) || !incidents.length) return incidents;
  const tenantId = user?.tenantId || null;
  let telematicsFeatureEnabled = true;
  if (tenantId) {
    try {
      const telematicsConfig = await settingsService.getTelematicsConfig({ tenantId });
      telematicsFeatureEnabled = telematicsConfig?.ready !== false;
    } catch {
      telematicsFeatureEnabled = true;
    }
  }

  const vehicleIds = [
    ...new Set(
      incidents
        .map((incident) => resolveIncidentVehicle(incident).vehicle?.id || null)
        .filter(Boolean)
    )
  ];
  const signalsByVehicleId = await buildVehicleOperationalSignalsMap(
    vehicleIds,
    tenantId ? { tenantId } : {},
    { telematicsFeatureEnabled }
  );

  return incidents.map((incident) => {
    const { vehicle, swapCount } = resolveIncidentVehicle(incident);
    const signals = vehicle ? signalsByVehicleId.get(vehicle.id) || null : null;
    return {
      ...incident,
      operationalContext: vehicle
        ? {
            vehicle,
            swapCount,
            status: signals?.status || null,
            attentionReasons: signals?.attentionReasons || [],
            inspection: signals?.inspection || null,
            telematics: signals?.telematics || null,
            turnReady: signals?.turnReady || null
          }
        : null,
      evidenceChecklist: null,
      evidenceCapture: null,
      evidenceRequestDrafts: null,
      recoveryActions: null,
      inspectionCompare: null,
      nextBestAction: null
    };
  }).map((incident) => ({
    ...incident,
    evidenceChecklist: buildIncidentEvidenceChecklist(incident),
    evidenceCapture: buildIncidentEvidenceCapture(incident),
    evidenceRequestDrafts: buildIncidentEvidenceRequestDrafts(incident),
    recoveryActions: buildIncidentRecoveryActions(incident),
    inspectionCompare: buildIncidentInspectionCompare(incident),
    nextBestAction: buildIncidentNextBestAction(incident)
  }));
}

export const issueCenterClaimsService = {
  async createInternalIncident(user, payload = {}) {
    const subjectType = String(payload?.subjectType || 'TRIP').trim().toUpperCase();
    if (!['TRIP', 'RESERVATION'].includes(subjectType)) throw new Error('subjectType must be TRIP or RESERVATION');

    if (payload?.amountClaimed !== '' && payload?.amountClaimed != null && !Number.isFinite(Number(payload.amountClaimed))) {
      throw new Error('amountClaimed must be a valid number');
    }

    const actor = {
      actorType: 'TENANT_USER',
      actorRefId: user?.id || user?.sub || null,
      source: 'issue-center'
    };
    const workflowFields = normalizeIncidentWorkflowFields(payload, { allowResolutionCode: false });
    if (Object.prototype.hasOwnProperty.call(workflowFields, 'ownerUserId')) {
      workflowFields.ownerUserId = await resolveAssignableOwnerUserId(user, workflowFields.ownerUserId);
    }
    const incidentPayload = {
      ...payload,
      ...workflowFields
    };

    if (subjectType === 'RESERVATION') {
      const reservation = await findReservationForInternalIncident(user, payload);
      return createIncidentForReservation(reservation, incidentPayload, actor);
    }

    const trip = await findTripForInternalIncident(user, payload);
    return createIncidentForTrip(trip, incidentPayload, actor);
  },

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
      orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
      take: 100
    });

    const dueSoonDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
    const [openCount, reviewCount, resolvedCount, closedCount, urgentCount, dueSoonCount, assignableUsers] = await Promise.all([
      prisma.tripIncident.count({ where: { ...incidentScope, status: 'OPEN' } }),
      prisma.tripIncident.count({ where: { ...incidentScope, status: 'UNDER_REVIEW' } }),
      prisma.tripIncident.count({ where: { ...incidentScope, status: 'RESOLVED' } }),
      prisma.tripIncident.count({ where: { ...incidentScope, status: 'CLOSED' } }),
      prisma.tripIncident.count({ where: { ...incidentScope, priority: 'URGENT', status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
      prisma.tripIncident.count({ where: { ...incidentScope, dueAt: { not: null, lte: dueSoonDate }, status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
      prisma.user.findMany({
        where: {
          isActive: true,
          ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {})
        },
        orderBy: [{ fullName: 'asc' }],
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true
        }
      })
    ]);

    return {
      metrics: {
        open: openCount,
        underReview: reviewCount,
        resolved: resolvedCount,
        closed: closedCount,
        urgent: urgentCount,
        dueSoon: dueSoonCount,
        total: openCount + reviewCount + resolvedCount + closedCount
      },
      incidents: await attachHistory(await attachOperationalContext(user, incidents)),
      teamMembers: assignableUsers
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
    const workflowFields = normalizeIncidentWorkflowFields(payload);
    if (Object.prototype.hasOwnProperty.call(workflowFields, 'ownerUserId')) {
      workflowFields.ownerUserId = await resolveAssignableOwnerUserId(user, workflowFields.ownerUserId);
    }

    const updated = await prisma.tripIncident.update({
      where: { id },
      data: withIncidentOwnerRelation({
        status: nextStatus,
        title: nextTitle,
        ...workflowFields,
        description: Object.prototype.hasOwnProperty.call(payload, 'description')
          ? (payload.description ? String(payload.description).trim() : null)
          : current.description,
        amountResolved: Object.prototype.hasOwnProperty.call(payload, 'amountResolved')
          ? (payload.amountResolved === '' || payload.amountResolved == null ? null : Number(payload.amountResolved))
          : current.amountResolved,
        resolvedAt: ['RESOLVED', 'CLOSED'].includes(nextStatus) ? (current.resolvedAt || new Date()) : null
      }),
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
        amountResolved: updated.amountResolved == null ? null : money(updated.amountResolved),
        priority: updated.priority,
        severity: updated.severity,
        dueAt: updated.dueAt ? updated.dueAt.toISOString() : null,
        resolutionCode: updated.resolutionCode || null,
        ownerUserId: updated.ownerUserId || null,
        liabilityDecision: updated.liabilityDecision || 'PENDING',
        chargeDecision: updated.chargeDecision || 'PENDING',
        recoveryStage: updated.recoveryStage || 'INTAKE',
        customerChargeReady: !!updated.customerChargeReady
      }
    );

    if (current.status !== nextStatus) {
      await notifyIncidentStatusChange(updated, current.status, nextStatus, payload?.note ? String(payload.note).trim() : '');
    }

    if (current.tripId && ['RESOLVED', 'CLOSED'].includes(nextStatus)) {
      const remaining = await prisma.tripIncident.count({
        where: {
          tripId: current.tripId,
          status: { in: ['OPEN', 'UNDER_REVIEW'] }
        }
      });
      if (remaining === 0) {
        const trip = await prisma.trip.findUnique({ where: { id: current.tripId }, select: { status: true } });
        if (trip?.status === 'DISPUTED') {
          await prisma.trip.update({ where: { id: current.tripId }, data: { status: 'COMPLETED' } });
        }
      }
    } else if (current.tripId) {
      await flagTripDisputed(current.tripId);
    }

    await syncTollDisputeStatusForIncident(updated);

    return (await attachHistory(await attachOperationalContext(user, [updated])))[0];
  },

  async applyWorkflowAction(user, id, payload = {}) {
    const current = await prisma.tripIncident.findFirst({
      where: {
        id,
        ...incidentTenantWhere(user)
      },
      include: incidentInclude()
    });
    if (!current) throw new Error('Incident not found');

    const actionPlan = buildIncidentWorkflowActionUpdate(payload?.action, payload);
    return this.updateIncident(user, id, {
      ...actionPlan.updates,
      note: actionPlan.note,
      title: current.title
    });
  },

  async getIncidentPacket(user, id) {
    const incident = await prisma.tripIncident.findFirst({
      where: {
        id,
        ...incidentTenantWhere(user)
      },
      include: incidentInclude()
    });
    if (!incident) throw new Error('Incident not found');

    const hydrated = (await attachHistory(await attachOperationalContext(user, [incident])))[0];
    return buildIncidentClaimsPacket(hydrated);
  },

  async getIncidentPacketPrint(user, id) {
    const incident = await prisma.tripIncident.findFirst({
      where: {
        id,
        ...incidentTenantWhere(user)
      },
      include: incidentInclude()
    });
    if (!incident) throw new Error('Incident not found');

    const hydrated = (await attachHistory(await attachOperationalContext(user, [incident])))[0];
    return buildIncidentClaimsPacketHtml(hydrated);
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
    const hydrated = (await attachOperationalContext(user, [incident]))[0];

    const recipient = recipientForIncident(incident, payload?.recipientType || 'GUEST');
    if (!recipient.email) {
      throw new Error(`${recipient.recipientType === 'HOST' ? 'Host' : 'Guest'} email is not available for this issue`);
    }

    const note = String(payload?.note || '').trim() || buildIncidentEvidenceRequestNote(hydrated, recipient.recipientType);
    if (!note) throw new Error('note is required');
    const requestKey = payload?.requestKey ? String(payload.requestKey).trim() : '';
    const quickActionLabel = payload?.quickActionLabel ? String(payload.quickActionLabel).trim() : '';
    const workflowUpdate = buildIssueRequestWorkflowUpdate(incident);

    const { token, expiresAt, link } = createPublicReplyToken();
    const subject = quickActionLabel
      ? `More information needed: ${quickActionLabel}`
      : `More information needed for issue: ${incident.title}`;
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

    await prisma.tripIncident.update({
      where: { id: incident.id },
      data: {
        status: workflowUpdate.status,
        recoveryStage: workflowUpdate.recoveryStage
      }
    });

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
      quickActionLabel
        ? `${quickActionLabel} sent to ${recipient.recipientType.toLowerCase()}`
        : `Requested more information from ${recipient.recipientType.toLowerCase()}`,
      {
        recipientType: recipient.recipientType,
        requestKey: requestKey || null,
        quickActionLabel: quickActionLabel || null,
        link,
        expiresAt: expiresAt.toISOString(),
        nextStatus: workflowUpdate.status,
        recoveryStage: workflowUpdate.recoveryStage
      }
    );

    return {
      ok: true,
      recipientType: recipient.recipientType,
      email: recipient.email,
      requestKey: requestKey || null,
      quickActionLabel: quickActionLabel || null,
      link,
      expiresAt,
      workflow: workflowUpdate
    };
  },

  async createChargeDraft(user, id, payload = {}) {
    const incident = await prisma.tripIncident.findFirst({
      where: {
        id,
        ...incidentTenantWhere(user)
      },
      include: incidentInclude()
    });
    if (!incident) throw new Error('Incident not found');

    const reservation = incident.reservation || incident.trip?.reservation || null;
    if (!reservation?.id) throw new Error('Reservation is required to create a charge draft');

    const draft = buildIncidentChargeDraft(incident, payload);

    await prisma.$transaction(async (tx) => {
      const existing = await tx.reservationCharge.findFirst({
        where: {
          reservationId: reservation.id,
          source: 'ISSUE_CENTER',
          sourceRefId: incident.id
        },
        orderBy: [{ createdAt: 'asc' }]
      });

      if (existing?.id) {
        await tx.reservationCharge.update({
          where: { id: existing.id },
          data: {
            ...draft.charge
          }
        });
      } else {
        const maxSortOrder = await tx.reservationCharge.aggregate({
          where: { reservationId: reservation.id },
          _max: { sortOrder: true }
        });
        await tx.reservationCharge.create({
          data: {
            reservationId: reservation.id,
            ...draft.charge,
            sortOrder: Number(maxSortOrder?._max?.sortOrder ?? -1) + 1
          }
        });
      }

      await tx.tripIncident.update({
        where: { id: incident.id },
        data: {
          chargeDecision: 'CHARGE_CUSTOMER',
          customerChargeReady: true,
          recoveryStage: 'READY_TO_CHARGE',
          amountResolved: draft.amount
        }
      });
    });

    await reservationPricingService.getPricing(reservation.id, tenantWhereFor(user));

    const refreshedIncident = await prisma.tripIncident.findFirst({
      where: { id: incident.id, ...incidentTenantWhere(user) },
      include: incidentInclude()
    });

    await createIncidentEvent(
      refreshedIncident || incident,
      'TENANT_USER',
      user?.id || user?.sub || null,
      'TRIP_INCIDENT_UPDATED',
      `Created charge draft for ${draft.amount.toFixed(2)}`,
      {
        chargeDraftCreated: true,
        amount: draft.amount,
        reservationId: reservation.id
      }
    );

    return {
      ok: true,
      amount: draft.amount,
      reservationId: reservation.id,
      pricing: await reservationPricingService.getPricing(reservation.id, tenantWhereFor(user))
    };
  },

  async chargeCardOnFile(user, id, payload = {}) {
    const incident = await prisma.tripIncident.findFirst({
      where: {
        id,
        ...incidentTenantWhere(user)
      },
      include: incidentInclude()
    });
    if (!incident) throw new Error('Incident not found');

    const reservation = incident.reservation || incident.trip?.reservation || null;
    if (!reservation?.id) throw new Error('Reservation is required to charge card on file');

    const draft = buildIncidentChargeDraft(incident, payload);
    const agreement = await rentalAgreementsService.startFromReservation(reservation.id, tenantWhereFor(user));
    if (!agreement?.id) throw new Error('No rental agreement exists for this reservation yet');

    const charged = await rentalAgreementsService.chargeCardOnFile(
      agreement.id,
      { amount: draft.amount },
      user?.id || user?.sub || null
    );

    await prisma.tripIncident.update({
      where: { id: incident.id },
      data: {
        chargeDecision: 'CHARGE_CUSTOMER',
        customerChargeReady: true,
        recoveryStage: 'CHARGED',
        resolutionCode: 'CUSTOMER_CHARGED',
        amountResolved: draft.amount,
        status: 'RESOLVED',
        resolvedAt: new Date()
      }
    });

    await createIncidentEvent(
      incident,
      'TENANT_USER',
      user?.id || user?.sub || null,
      'TRIP_INCIDENT_UPDATED',
      `Charged customer card on file for ${draft.amount.toFixed(2)}`,
      {
        cardOnFileCharged: true,
        amount: draft.amount,
        reservationId: reservation.id
      }
    );

    return {
      ok: true,
      amount: draft.amount,
      reservationId: reservation.id,
      chargeResult: charged
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
    if (!incidentCommunication?.incident) return null;
    const incident = incidentCommunication.incident;
    return {
      caseType: 'TRIP_INCIDENT',
      incident: (await attachHistory(await attachOperationalContext(
        { tenantId: incident?.trip?.tenantId || incident?.reservation?.tenantId || null },
        [incident]
      )))[0],
      request: serializeCommunication(incidentCommunication),
      responseLink: issueResponseLink(incidentCommunication.publicToken)
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
    if (!incidentCommunication?.incident) return null;

    const communication = incidentCommunication;
    const note = String(payload?.message || '').trim();
    if (!note) throw new Error('message is required');
    const attachments = normalizeIssueResponseAttachments(payload?.attachments);

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

    return refreshed ? (await attachHistory(await attachOperationalContext(
      { tenantId: refreshed?.trip?.tenantId || refreshed?.reservation?.tenantId || null },
      [refreshed]
    )))[0] : null;
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
  },

  async createTollDisputeIncident(user, input = {}) {
    const reservationId = input?.reservationId ? String(input.reservationId) : '';
    const tollTransactionId = input?.tollTransactionId ? String(input.tollTransactionId) : '';
    if (!reservationId) throw new Error('reservationId is required');
    if (!tollTransactionId) throw new Error('tollTransactionId is required');

    const reservation = await prisma.reservation.findFirst({
      where: {
        id: reservationId,
        ...tenantWhereFor(user)
      },
      include: incidentInclude().reservation.include
    });
    if (!reservation) throw new Error('Reservation not found for toll dispute');

    const existing = await prisma.tripIncident.findFirst({
      where: {
        reservationId,
        type: 'TOLL',
        evidenceJson: {
          contains: tollTransactionId
        }
      },
      include: incidentInclude()
    });
    if (existing) {
      return {
        created: false,
        incident: (await attachHistory([existing]))[0]
      };
    }

    const incident = await createIncidentForReservation(reservation, {
      type: 'TOLL',
      title: String(input.title || 'Toll dispute').trim(),
      description: String(input.description || '').trim() || null,
      amountClaimed: input.amountClaimed == null ? null : Number(input.amountClaimed),
      evidenceJson: {
        source: 'tolls-module',
        tollTransactionId,
        tollAmount: input.amountClaimed == null ? null : money(input.amountClaimed),
        tollLocation: input.location || '',
        tollTransactionAt: input.transactionAt || null
      }
    }, {
      actorType: 'TENANT_USER',
      actorRefId: user?.id || user?.sub || null,
      source: 'tolls-module'
    });

    return {
      created: true,
      incident
    };
  }
};
