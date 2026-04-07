import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentEvidenceRequestActions, buildIncidentEvidenceRequestDrafts, buildIncidentEvidenceRequestNote } from './issue-center-evidence-request.js';

test('buildIncidentEvidenceRequestNote lists missing required evidence slots', () => {
  const note = buildIncidentEvidenceRequestNote({
    evidenceCapture: {
      slots: [
        { label: 'Damage photos', guidance: 'Attach clear photos of the affected area.', required: true, ready: false },
        { label: 'Liability decision', guidance: 'Confirm who should be responsible for this damage.', required: true, ready: false }
      ]
    }
  }, 'GUEST');

  assert.match(note, /Damage photos/i);
  assert.match(note, /Liability decision/i);
  assert.match(note, /reply directly through the issue link/i);
});

test('buildIncidentEvidenceRequestDrafts returns guest and host notes', () => {
  const drafts = buildIncidentEvidenceRequestDrafts({
    evidenceCapture: {
      slots: [
        { label: 'Toll transaction', guidance: 'Confirm the toll reference or context.', required: true, ready: false }
      ]
    }
  });

  assert.match(drafts.guestNote, /Toll transaction/i);
  assert.match(drafts.hostNote, /Toll transaction/i);
});

test('buildIncidentEvidenceRequestActions returns quick actions for requestable slots only', () => {
  const actions = buildIncidentEvidenceRequestActions({
    evidenceCapture: {
      slots: [
        { key: 'damagePhotos', label: 'Damage photos', guidance: 'Attach clear photos.', required: true, ready: false },
        { key: 'liabilityDecision', label: 'Liability decision', guidance: 'Set liability.', required: true, ready: false }
      ]
    }
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].label, 'Request Damage Photos');
  assert.equal(actions[0].recipientType, 'GUEST');
  assert.match(actions[0].note, /Damage photos/i);
});
