import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentWorkflowActionUpdate, INCIDENT_WORKFLOW_ACTIONS } from './issue-center-workflow-actions.js';

test('workflow action catalog stays non-empty', () => {
  assert.ok(INCIDENT_WORKFLOW_ACTIONS.length > 0);
});

test('buildIncidentWorkflowActionUpdate marks claim ready to charge', () => {
  const result = buildIncidentWorkflowActionUpdate('MARK_READY_TO_CHARGE', {});
  assert.equal(result.updates.customerChargeReady, true);
  assert.equal(result.updates.recoveryStage, 'READY_TO_CHARGE');
  assert.equal(result.updates.chargeDecision, 'CHARGE_CUSTOMER');
});

test('buildIncidentWorkflowActionUpdate supports waive claim with reason', () => {
  const result = buildIncidentWorkflowActionUpdate('WAIVE_CLAIM', { waiveReason: 'goodwill adjustment' });
  assert.equal(result.updates.chargeDecision, 'WAIVE');
  assert.equal(result.updates.recoveryStage, 'WAIVED');
  assert.equal(result.updates.waiveReason, 'goodwill adjustment');
});
