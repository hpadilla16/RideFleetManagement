import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INCIDENT_CHARGE_DECISIONS,
  INCIDENT_LIABILITY_DECISIONS,
  INCIDENT_PRIORITIES,
  INCIDENT_RECOVERY_STAGES,
  INCIDENT_RESOLUTION_CODES,
  INCIDENT_SEVERITIES,
  normalizeIncidentWorkflowFields
} from './issue-center-claims-fields.js';

test('normalizeIncidentWorkflowFields normalizes claim workflow fields', () => {
  const result = normalizeIncidentWorkflowFields({
    priority: 'urgent',
    severity: 'critical',
    dueAt: '2026-04-08T12:30:00.000Z',
    ownerUserId: ' user_123 ',
    resolutionCode: 'goodwill',
    liabilityDecision: 'customer',
    chargeDecision: 'charge_customer',
    recoveryStage: 'ready_to_charge',
    waiveReason: ' courtesy ',
    customerChargeReady: 1
  });

  assert.equal(result.priority, 'URGENT');
  assert.equal(result.severity, 'CRITICAL');
  assert.equal(result.ownerUserId, 'user_123');
  assert.equal(result.resolutionCode, 'GOODWILL');
  assert.equal(result.liabilityDecision, 'CUSTOMER');
  assert.equal(result.chargeDecision, 'CHARGE_CUSTOMER');
  assert.equal(result.recoveryStage, 'READY_TO_CHARGE');
  assert.equal(result.waiveReason, 'courtesy');
  assert.equal(result.customerChargeReady, true);
  assert.ok(result.dueAt instanceof Date);
});

test('normalizeIncidentWorkflowFields rejects invalid enums and dates', () => {
  assert.throws(() => normalizeIncidentWorkflowFields({ priority: 'rush' }), /priority must be one of/i);
  assert.throws(() => normalizeIncidentWorkflowFields({ severity: 'bad' }), /severity must be one of/i);
  assert.throws(() => normalizeIncidentWorkflowFields({ resolutionCode: 'x' }), /resolutionCode must be one of/i);
  assert.throws(() => normalizeIncidentWorkflowFields({ liabilityDecision: 'x' }), /liabilityDecision must be one of/i);
  assert.throws(() => normalizeIncidentWorkflowFields({ chargeDecision: 'x' }), /chargeDecision must be one of/i);
  assert.throws(() => normalizeIncidentWorkflowFields({ recoveryStage: 'x' }), /recoveryStage must be one of/i);
  assert.throws(() => normalizeIncidentWorkflowFields({ dueAt: 'not-a-date' }), /dueAt must be a valid date/i);
});

test('claim workflow enum catalogs stay non-empty', () => {
  assert.ok(INCIDENT_PRIORITIES.length > 0);
  assert.ok(INCIDENT_SEVERITIES.length > 0);
  assert.ok(INCIDENT_RESOLUTION_CODES.length > 0);
  assert.ok(INCIDENT_LIABILITY_DECISIONS.length > 0);
  assert.ok(INCIDENT_CHARGE_DECISIONS.length > 0);
  assert.ok(INCIDENT_RECOVERY_STAGES.length > 0);
});
