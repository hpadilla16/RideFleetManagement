const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const RESOLUTION_CODES = ['CUSTOMER_CHARGED', 'WAIVED', 'INVALID_REPORT', 'DUPLICATE', 'GOODWILL', 'OTHER'];
const LIABILITY_DECISIONS = ['PENDING', 'CUSTOMER', 'TENANT', 'HOST', 'SHARED', 'WAIVED'];
const CHARGE_DECISIONS = ['PENDING', 'CHARGE_CUSTOMER', 'CHARGE_HOST', 'CHARGE_TENANT', 'WAIVE'];
const RECOVERY_STAGES = ['INTAKE', 'EVIDENCE', 'LIABILITY_REVIEW', 'READY_TO_CHARGE', 'CHARGED', 'WAIVED', 'CLOSED'];

function normalizeEnum(value, allowed, fieldName, fallback = undefined) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toUpperCase();
  if (!allowed.includes(normalized)) {
    throw new Error(`${fieldName} must be one of ${allowed.join(', ')}`);
  }
  return normalized;
}

function normalizeDate(value, fieldName) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date;
}

export function normalizeIncidentWorkflowFields(input = {}, options = {}) {
  const allowResolutionCode = options.allowResolutionCode !== false;
  const data = {};

  if (Object.prototype.hasOwnProperty.call(input, 'priority')) {
    data.priority = normalizeEnum(input.priority, PRIORITIES, 'priority', 'MEDIUM');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'severity')) {
    data.severity = normalizeEnum(input.severity, SEVERITIES, 'severity', 'LOW');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'dueAt')) {
    data.dueAt = normalizeDate(input.dueAt, 'dueAt');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'ownerUserId')) {
    data.ownerUserId = input.ownerUserId ? String(input.ownerUserId).trim() : null;
  }
  if (allowResolutionCode && Object.prototype.hasOwnProperty.call(input, 'resolutionCode')) {
    data.resolutionCode = normalizeEnum(input.resolutionCode, RESOLUTION_CODES, 'resolutionCode', null);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'liabilityDecision')) {
    data.liabilityDecision = normalizeEnum(input.liabilityDecision, LIABILITY_DECISIONS, 'liabilityDecision', 'PENDING');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'chargeDecision')) {
    data.chargeDecision = normalizeEnum(input.chargeDecision, CHARGE_DECISIONS, 'chargeDecision', 'PENDING');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'recoveryStage')) {
    data.recoveryStage = normalizeEnum(input.recoveryStage, RECOVERY_STAGES, 'recoveryStage', 'INTAKE');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'waiveReason')) {
    data.waiveReason = input.waiveReason ? String(input.waiveReason).trim() : null;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'customerChargeReady')) {
    data.customerChargeReady = !!input.customerChargeReady;
  }

  return data;
}

export const INCIDENT_PRIORITIES = PRIORITIES;
export const INCIDENT_SEVERITIES = SEVERITIES;
export const INCIDENT_RESOLUTION_CODES = RESOLUTION_CODES;
export const INCIDENT_LIABILITY_DECISIONS = LIABILITY_DECISIONS;
export const INCIDENT_CHARGE_DECISIONS = CHARGE_DECISIONS;
export const INCIDENT_RECOVERY_STAGES = RECOVERY_STAGES;
