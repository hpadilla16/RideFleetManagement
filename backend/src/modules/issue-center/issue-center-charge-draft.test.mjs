import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentChargeDraft } from './issue-center-charge-draft.js';

test('buildIncidentChargeDraft prefers resolved amount and builds an issue-center charge row', () => {
  const draft = buildIncidentChargeDraft({
    id: 'inc_1',
    title: 'Wheel damage',
    type: 'DAMAGE',
    amountClaimed: 120,
    amountResolved: 95
  });

  assert.equal(draft.amount, 95);
  assert.equal(draft.charge.code, 'ISSUE_CLAIM');
  assert.equal(draft.charge.source, 'ISSUE_CENTER');
  assert.equal(draft.charge.sourceRefId, 'inc_1');
});

test('buildIncidentChargeDraft rejects zero amount claims', () => {
  assert.throws(() => buildIncidentChargeDraft({ id: 'inc_2', amountClaimed: 0 }), /greater than 0/i);
});
