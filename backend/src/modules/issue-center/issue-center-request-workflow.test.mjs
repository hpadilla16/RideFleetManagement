import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIssueRequestWorkflowUpdate } from './issue-center-request-workflow.js';

test('buildIssueRequestWorkflowUpdate pushes intake claims into evidence review', () => {
  const update = buildIssueRequestWorkflowUpdate({ status: 'OPEN', recoveryStage: 'INTAKE' });
  assert.equal(update.status, 'UNDER_REVIEW');
  assert.equal(update.recoveryStage, 'EVIDENCE');
});

test('buildIssueRequestWorkflowUpdate preserves active status when already under review', () => {
  const update = buildIssueRequestWorkflowUpdate({ status: 'UNDER_REVIEW', recoveryStage: 'READY_TO_CHARGE' });
  assert.equal(update.status, 'UNDER_REVIEW');
  assert.equal(update.recoveryStage, 'READY_TO_CHARGE');
});
