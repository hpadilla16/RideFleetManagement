import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentInspectionCompare } from './issue-center-inspection-compare.js';

test('buildIncidentInspectionCompare summarizes checkout vs checkin changes', () => {
  const compare = buildIncidentInspectionCompare({
    reservation: {
      id: 'res_1',
      rentalAgreement: {
        inspections: [
          {
            phase: 'CHECKOUT',
            capturedAt: '2026-04-07T10:00:00.000Z',
            exterior: 'GOOD',
            fuelLevel: 'FULL',
            photosJson: JSON.stringify({ front: 'checkout-front.jpg', rear: 'checkout-rear.jpg' })
          },
          {
            phase: 'CHECKIN',
            capturedAt: '2026-04-08T10:00:00.000Z',
            exterior: 'SCRATCHED',
            fuelLevel: 'HALF',
            photosJson: JSON.stringify({ front: 'checkin-front.jpg', rear: 'checkin-rear.jpg' })
          }
        ]
      }
    }
  });

  assert.equal(compare.status, 'COMPARE_READY');
  assert.equal(compare.changedCount, 2);
  assert.equal(compare.photoCoverage.common, 2);
  assert.ok(compare.previews.length > 0);
  assert.match(compare.summary, /changed/i);
});

test('buildIncidentInspectionCompare handles missing data cleanly', () => {
  const compare = buildIncidentInspectionCompare({});
  assert.equal(compare.status, 'NO_DATA');
  assert.equal(compare.changedCount, undefined);
});
