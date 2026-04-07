import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentEvidenceCapture } from './issue-center-evidence-capture.js';

test('buildIncidentEvidenceCapture marks damage claims partial when photos and liability are still missing', () => {
  const capture = buildIncidentEvidenceCapture({
    type: 'DAMAGE',
    liabilityDecision: 'PENDING',
    communications: [],
    operationalContext: {
      swapCount: 0,
      inspection: {
        latestAt: '2026-04-07T12:00:00.000Z',
        summary: 'Inspection exists.',
        photoCoverage: { captured: 0 },
        damageTriage: { severity: 'HIGH', recommendedAction: 'Review before release.' }
      }
    }
  });

  assert.equal(capture.status, 'PARTIAL');
  assert.equal(capture.missingCount, 2);
  assert.equal(capture.slots.find((entry) => entry.key === 'inspectionRecord')?.status, 'READY');
  assert.equal(capture.slots.find((entry) => entry.key === 'damagePhotos')?.status, 'MISSING');
  assert.equal(capture.slots.find((entry) => entry.key === 'liabilityDecision')?.status, 'MISSING');
});

test('buildIncidentEvidenceCapture marks toll responsibility window ready when swap confirmation exists', () => {
  const capture = buildIncidentEvidenceCapture({
    type: 'TOLL',
    liabilityDecision: 'CUSTOMER',
    chargeDecision: 'PENDING',
    evidenceJson: JSON.stringify({
      source: 'tolls-module',
      tollTransactionId: 'txn_1',
      tollTransactionAt: '2026-04-06T15:00:00.000Z',
      tollLocation: 'PR-22',
      responsibilityWindowConfirmedAt: '2026-04-07T18:00:00.000Z'
    }),
    communications: [{ attachments: [{ name: 'reply.png' }], recipientType: 'GUEST' }],
    operationalContext: {
      swapCount: 2
    }
  });

  assert.equal(capture.status, 'READY');
  assert.equal(capture.slots.find((entry) => entry.key === 'tollTransaction')?.status, 'READY');
  assert.equal(capture.slots.find((entry) => entry.key === 'responsibilityWindow')?.status, 'READY');
  assert.match(capture.slots.find((entry) => entry.key === 'customerContext')?.sourceLabels.join(' '), /Customer Reply/i);
});
