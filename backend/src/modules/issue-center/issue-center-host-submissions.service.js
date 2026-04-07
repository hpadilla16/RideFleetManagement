import { prisma } from '../../lib/prisma.js';
import { normalizeIssueResponseAttachments } from './issue-center-attachments.js';
import {
  createPublicReplyToken,
  createVehicleSubmissionCommunication,
  issueResponseLink,
  recipientForVehicleSubmission,
  sendIssueEmail,
  serializeCommunication,
  serializeVehicleSubmission,
  tenantWhereFor,
  vehicleSubmissionInclude,
  notifyVehicleSubmissionApproved
} from './issue-center-core.js';

export const issueCenterHostSubmissionsService = {
  notifyHostVehicleSubmissionApproved: notifyVehicleSubmissionApproved,

  async getDashboard(user, input = {}) {
    const tenantScope = tenantWhereFor(user);
    const search = input?.q ? String(input.q).trim() : '';

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

    const submissionPendingCount = await prisma.hostVehicleSubmission.count({
      where: {
        tenantId: tenantScope.tenantId || undefined,
        status: { in: ['PENDING_REVIEW', 'PENDING_INFO'] }
      }
    });

    return {
      metrics: {
        vehicleApprovalsPending: submissionPendingCount
      },
      vehicleSubmissions: vehicleSubmissions.map(serializeVehicleSubmission)
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

    const { token, expiresAt, link } = createPublicReplyToken();
    const subject = 'More information needed for vehicle approval';
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
    if (!submissionCommunication?.submission) return null;

    return {
      caseType: 'HOST_VEHICLE_SUBMISSION',
      submission: serializeVehicleSubmission(submissionCommunication.submission),
      request: serializeCommunication(submissionCommunication),
      responseLink: issueResponseLink(submissionCommunication.publicToken)
    };
  },

  async submitPublicResponse(token, payload = {}) {
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
    if (!submissionCommunication?.submission) return null;

    const note = String(payload?.message || '').trim();
    if (!note) throw new Error('message is required');
    const attachments = normalizeIssueResponseAttachments(payload?.attachments);

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
  }
};
