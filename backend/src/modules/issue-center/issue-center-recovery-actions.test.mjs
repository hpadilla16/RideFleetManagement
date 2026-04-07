import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentRecoveryActions } from './issue-center-recovery-actions.js';

test('buildIncidentRecoveryActions includes mark ready and payment links for charge-ready claims', () => {
  const actions = buildIncidentRecoveryActions({
    type: 'DAMAGE',
    liabilityDecision: 'CUSTOMER',
    chargeDecision: 'PENDING',
    evidenceCapture: { status: 'READY' },
    reservation: { id: 'res_1' },
    operationalContext: { vehicle: { id: 'veh_1' }, inspection: { damageTriage: { severity: 'LOW' } } }
  });

  assert.ok(actions.some((entry) => entry.key === 'mark-ready-to-charge'));
  assert.ok(actions.some((entry) => entry.key === 'create-charge-draft'));
  assert.ok(actions.some((entry) => entry.key === 'open-reservation-payments'));
  assert.ok(actions.some((entry) => entry.key === 'open-vehicle-profile'));
});

test('buildIncidentRecoveryActions adds toll review for toll claims', () => {
  const actions = buildIncidentRecoveryActions({
    type: 'TOLL',
    liabilityDecision: 'CUSTOMER',
    evidenceCapture: { status: 'PARTIAL' },
    reservation: { id: 'res_2' }
  });

  assert.ok(actions.some((entry) => entry.key === 'open-toll-review'));
});
