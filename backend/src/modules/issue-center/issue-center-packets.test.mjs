import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentClaimsPacket } from './issue-center-packets.js';

test('buildIncidentClaimsPacket summarizes claim context without leaking inline attachment data urls', () => {
  const packet = buildIncidentClaimsPacket({
    id: 'inc_123',
    title: 'Toll dispute',
    type: 'TOLL',
    status: 'UNDER_REVIEW',
    priority: 'HIGH',
    severity: 'MEDIUM',
    description: 'Customer disputed a toll after a swap.',
    amountClaimed: 15.75,
    amountResolved: 0,
    dueAt: '2026-04-08T12:00:00.000Z',
    createdAt: '2026-04-07T10:00:00.000Z',
    subjectType: 'RESERVATION',
    reservation: {
      reservationNumber: 'RES-101',
      status: 'CHECKED_OUT',
      pickupAt: '2026-04-01T14:00:00.000Z',
      returnAt: '2026-04-05T14:00:00.000Z',
      pickupLocation: { name: 'SJU' },
      returnLocation: { name: 'SJU' }
    },
    guestCustomer: {
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com'
    },
    ownerUser: {
      fullName: 'Ops Agent',
      email: 'ops@example.com'
    },
    nextBestAction: {
      label: 'Hold vehicle and review damage',
      detail: 'Damage triage suggests this unit should be reviewed before another dispatch.'
    },
    evidenceChecklist: {
      status: 'PARTIAL',
      completionPct: 75,
      summary: '1 checklist item still needs evidence or review.',
      items: [
        { label: 'Toll transaction linked', complete: true, detail: 'txn_1' },
        { label: 'Swap review', complete: false, detail: '1 swap tied to this claim.' }
      ]
    },
    evidenceCapture: {
      status: 'PARTIAL',
      completionPct: 75,
      summary: '1 required evidence slot still needs capture or verification.',
      slots: [
        { label: 'Toll transaction', status: 'READY', guidance: 'Transaction linked.', sourceLabels: ['Toll Import'] },
        { label: 'Vehicle responsibility window', status: 'MISSING', guidance: 'Confirm swap window.', sourceLabels: ['Manual'] }
      ]
    },
    inspectionCompare: {
      status: 'COMPARE_READY',
      summary: '2 inspection field(s) changed between checkout and check-in.',
      changedCount: 2,
      photoCoverage: { checkout: 2, checkin: 2, common: 2 },
      changes: [
        { label: 'Exterior', before: 'GOOD', after: 'SCRATCHED', changed: true }
      ]
    },
    operationalContext: {
      swapCount: 1,
      vehicle: {
        internalNumber: '105',
        year: 2024,
        make: 'Toyota',
        model: 'Corolla',
        plate: 'ABC123'
      },
      turnReady: {
        status: 'ATTENTION',
        score: 72,
        summary: 'Vehicle needs readiness review before the next assignment.',
        blockers: ['Damage triage marked this vehicle as high-risk based on the latest inspection.']
      },
      inspection: {
        status: 'ATTENTION',
        summary: 'Latest inspection reported damage or condition issues that need review.',
        damageTriage: {
          severity: 'HIGH',
          confidence: 'HIGH',
          recommendedAction: 'Hold unit and route to damage review before the next assignment.'
        }
      },
      telematics: {
        status: 'STALE',
        summary: 'Telematics feed is connected but has not checked in recently.',
        fuelStatus: 'LOW',
        gpsStatus: 'MISSING',
        odometerStatus: 'REPORTED',
        alerts: ['Fuel level is low and may need refueling before the next reservation.']
      }
    },
    evidenceJson: JSON.stringify({
      source: 'tolls-module',
      tollTransactionId: 'txn_1',
      attachments: [
        { name: 'photo.png', dataUrl: 'data:image/png;base64,abc123' }
      ]
    }),
    communications: [
      {
        direction: 'OUTBOUND',
        channel: 'EMAIL',
        recipientType: 'GUEST',
        subject: 'Need more info',
        message: 'Please confirm the dispatched vehicle.',
        createdAt: '2026-04-07T11:00:00.000Z',
        attachments: [{ name: 'proof.png', dataUrl: 'data:image/png;base64,secret' }]
      }
    ],
    history: [
      {
        eventType: 'TRIP_INCIDENT_UPDATED',
        eventAt: '2026-04-07T12:00:00.000Z',
        actorType: 'TENANT_USER',
        actorRefId: 'user_1',
        notes: 'Moved to review',
        metadata: { previousStatus: 'OPEN', nextStatus: 'UNDER_REVIEW' }
      }
    ]
  });

  assert.equal(packet.filename, 'claims-packet-RES-101.txt');
  assert.match(packet.body, /Ride Fleet Claims Packet/);
  assert.match(packet.body, /Toll dispute/);
  assert.match(packet.body, /Reservation Number: RES-101/);
  assert.match(packet.body, /Guest: Jane Doe/);
  assert.match(packet.body, /tollTransactionId: txn_1/);
  assert.match(packet.body, /Operational Context/);
  assert.match(packet.body, /Evidence Checklist/);
  assert.match(packet.body, /Evidence Capture/);
  assert.match(packet.body, /Inspection Compare/);
  assert.match(packet.body, /Exterior: GOOD -> SCRATCHED/);
  assert.match(packet.body, /Vehicle responsibility window: MISSING/);
  assert.match(packet.body, /Checklist Status: PARTIAL/);
  assert.match(packet.body, /Next Best Action: Hold vehicle and review damage/);
  assert.match(packet.body, /Damage Severity: HIGH/);
  assert.match(packet.body, /Telematics Status: STALE/);
  assert.match(packet.body, /\[inline attachment omitted from packet\]/);
  assert.doesNotMatch(packet.body, /data:image\/png;base64/);
});
