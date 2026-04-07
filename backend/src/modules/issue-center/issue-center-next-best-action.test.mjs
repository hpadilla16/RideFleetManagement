import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentNextBestAction } from './issue-center-next-best-action.js';

test('buildIncidentNextBestAction prioritizes public replies before other actions', () => {
  const action = buildIncidentNextBestAction({
    status: 'UNDER_REVIEW',
    communications: [
      { publicTokenExpiresAt: '2026-04-09T00:00:00.000Z', respondedAt: null }
    ],
    operationalContext: {
      turnReady: { status: 'BLOCKED', summary: 'blocked' },
      inspection: { damageTriage: { severity: 'HIGH', recommendedAction: 'hold' } }
    }
  });
  assert.equal(action.code, 'WAIT_FOR_PUBLIC_REPLY');
});

test('buildIncidentNextBestAction recommends damage hold for high-severity damage claims', () => {
  const action = buildIncidentNextBestAction({
    type: 'DAMAGE',
    status: 'OPEN',
    communications: [],
    operationalContext: {
      inspection: {
        damageTriage: {
          severity: 'HIGH',
          recommendedAction: 'Hold unit and route to damage review before the next assignment.'
        }
      }
    }
  });
  assert.equal(action.code, 'HOLD_AND_REVIEW_DAMAGE');
});

test('buildIncidentNextBestAction recommends owner assignment when claim is active and unassigned', () => {
  const action = buildIncidentNextBestAction({
    type: 'OTHER',
    status: 'OPEN',
    communications: [],
    ownerUser: null,
    operationalContext: null
  });
  assert.equal(action.code, 'ASSIGN_CASE_OWNER');
});

test('buildIncidentNextBestAction surfaces ready-to-charge workflow when customer charge is approved', () => {
  const action = buildIncidentNextBestAction({
    status: 'UNDER_REVIEW',
    chargeDecision: 'CHARGE_CUSTOMER',
    recoveryStage: 'READY_TO_CHARGE',
    customerChargeReady: true,
    communications: []
  });
  assert.equal(action.code, 'READY_TO_CHARGE_CUSTOMER');
});
