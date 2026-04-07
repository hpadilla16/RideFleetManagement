import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentEvidenceChecklist } from './issue-center-evidence-checklist.js';

test('buildIncidentEvidenceChecklist marks toll claims partial when swap review still needs decision', () => {
  const checklist = buildIncidentEvidenceChecklist({
    type: 'TOLL',
    liabilityDecision: 'PENDING',
    chargeDecision: 'PENDING',
    evidenceJson: JSON.stringify({
      tollTransactionId: 'txn_123',
      tollTransactionAt: '2026-04-07T12:00:00.000Z',
      tollLocation: 'Plaza 1'
    }),
    operationalContext: {
      swapCount: 1
    }
  });

  assert.equal(checklist.status, 'PARTIAL');
  assert.ok(checklist.items.find((entry) => entry.key === 'swapReview' && entry.complete === false));
});

test('buildIncidentEvidenceChecklist marks damage claims ready when inspection, photos, triage, and liability are present', () => {
  const checklist = buildIncidentEvidenceChecklist({
    type: 'DAMAGE',
    liabilityDecision: 'CUSTOMER',
    communications: [{ attachments: [{ name: 'photo.jpg' }] }],
    operationalContext: {
      inspection: {
        latestAt: '2026-04-07T10:00:00.000Z',
        summary: 'Inspection complete',
        photoCoverage: { captured: 6 },
        damageTriage: { severity: 'HIGH', summary: 'Review damage' }
      }
    }
  });

  assert.equal(checklist.status, 'READY');
  assert.equal(checklist.missingCount, 0);
});
