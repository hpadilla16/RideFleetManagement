import { issueCenterClaimsService } from './issue-center-claims.service.js';
import { issueCenterHostSubmissionsService } from './issue-center-host-submissions.service.js';

export const issueCenterService = {
  notifyHostVehicleSubmissionApproved: issueCenterHostSubmissionsService.notifyHostVehicleSubmissionApproved,

  async createInternalIncident(user, payload = {}) {
    return issueCenterClaimsService.createInternalIncident(user, payload);
  },

  async getDashboard(user, input = {}) {
    const [claimsDashboard, hostSubmissionDashboard] = await Promise.all([
      issueCenterClaimsService.getDashboard(user, input),
      issueCenterHostSubmissionsService.getDashboard(user, input)
    ]);

    return {
      metrics: {
        ...(claimsDashboard.metrics || {}),
        ...(hostSubmissionDashboard.metrics || {})
      },
      incidents: claimsDashboard.incidents || [],
      vehicleSubmissions: hostSubmissionDashboard.vehicleSubmissions || [],
      teamMembers: claimsDashboard.teamMembers || []
    };
  },

  async updateIncident(user, id, payload = {}) {
    return issueCenterClaimsService.updateIncident(user, id, payload);
  },

  async applyWorkflowAction(user, id, payload = {}) {
    return issueCenterClaimsService.applyWorkflowAction(user, id, payload);
  },

  async getIncidentPacket(user, id) {
    return issueCenterClaimsService.getIncidentPacket(user, id);
  },

  async getIncidentPacketPrint(user, id) {
    return issueCenterClaimsService.getIncidentPacketPrint(user, id);
  },

  async createChargeDraft(user, id, payload = {}) {
    return issueCenterClaimsService.createChargeDraft(user, id, payload);
  },

  async chargeCardOnFile(user, id, payload = {}) {
    return issueCenterClaimsService.chargeCardOnFile(user, id, payload);
  },

  async requestMoreInfo(user, id, payload = {}) {
    return issueCenterClaimsService.requestMoreInfo(user, id, payload);
  },

  async requestVehicleSubmissionInfo(user, id, payload = {}) {
    return issueCenterHostSubmissionsService.requestVehicleSubmissionInfo(user, id, payload);
  },

  async getPublicResponsePrompt(token) {
    const claimsPrompt = await issueCenterClaimsService.getPublicResponsePrompt(token);
    if (claimsPrompt) return claimsPrompt;

    const hostPrompt = await issueCenterHostSubmissionsService.getPublicResponsePrompt(token);
    if (hostPrompt) return hostPrompt;

    throw new Error('Invalid or expired response link');
  },

  async submitPublicResponse(token, payload = {}) {
    const claimsResponse = await issueCenterClaimsService.submitPublicResponse(token, payload);
    if (claimsResponse) return claimsResponse;

    const hostResponse = await issueCenterHostSubmissionsService.submitPublicResponse(token, payload);
    if (hostResponse) return hostResponse;

    throw new Error('Invalid or expired response link');
  },

  async createGuestIncident(input = {}) {
    return issueCenterClaimsService.createGuestIncident(input);
  },

  async createIncidentForHost(user, tripId, payload = {}) {
    return issueCenterClaimsService.createIncidentForHost(user, tripId, payload);
  },

  async createTollDisputeIncident(user, input = {}) {
    return issueCenterClaimsService.createTollDisputeIncident(user, input);
  }
};
