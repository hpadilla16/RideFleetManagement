import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentClaimsPacketHtml } from './issue-center-packet-html.js';

test('buildIncidentClaimsPacketHtml renders printable html without leaking inline attachments', () => {
  const packet = buildIncidentClaimsPacketHtml({
    id: 'inc_456',
    title: 'Damage claim after swap',
    type: 'DAMAGE',
    status: 'UNDER_REVIEW',
    priority: 'URGENT',
    severity: 'HIGH',
    description: 'Customer reported wheel damage after a mid-trip swap.',
    createdAt: '2026-04-07T15:00:00.000Z',
    dueAt: '2026-04-08T18:00:00.000Z',
    reservation: {
      reservationNumber: 'RES-202',
      status: 'CHECKED_OUT',
      pickupAt: '2026-04-04T13:00:00.000Z',
      returnAt: '2026-04-08T13:00:00.000Z',
      pickupLocation: { name: 'SJU' },
      returnLocation: { name: 'BQN' }
    },
    nextBestAction: {
      label: 'Request more evidence',
      detail: 'Missing a full wheel photo and signed handoff context.'
    },
    evidenceChecklist: {
      status: 'PARTIAL',
      completionPct: 60,
      summary: '2 checklist items still need evidence or review.',
      items: [
        { label: 'Wheel close-up', complete: false, detail: 'Need a clear photo of the affected wheel.' }
      ]
    },
    evidenceCapture: {
      status: 'PARTIAL',
      completionPct: 50,
      summary: '2 required evidence slots still need capture or verification.',
      slots: [
        { label: 'Damage photos', status: 'MISSING', guidance: 'Capture full wheel photos.', sourceLabels: ['Inspection'] }
      ]
    },
    inspectionCompare: {
      status: 'COMPARE_READY',
      summary: '1 inspection field changed between checkout and check-in.',
      changedCount: 1,
      photoCoverage: { checkout: 2, checkin: 2, common: 2 },
      links: { inspectionReportHref: '/reservations/res_1/inspection-report' },
      changes: [
        { label: 'Exterior', before: 'GOOD', after: 'SCRATCHED', changed: true }
      ]
    },
    operationalContext: {
      swapCount: 1,
      vehicle: {
        internalNumber: '220',
        year: 2025,
        make: 'Kia',
        model: 'Soul',
        plate: 'XYZ999'
      },
      turnReady: {
        status: 'BLOCKED',
        score: 41,
        summary: 'Vehicle is blocked pending damage review.'
      },
      inspection: {
        status: 'ATTENTION',
        summary: 'Latest inspection reported new exterior damage.',
        damageTriage: {
          severity: 'HIGH',
          confidence: 'HIGH',
          recommendedAction: 'Hold unit and review before dispatch.'
        }
      },
      telematics: {
        status: 'CONNECTED',
        summary: 'Recent location and odometer telemetry are available.',
        fuelStatus: 'OK',
        gpsStatus: 'OK',
        odometerStatus: 'REPORTED'
      }
    },
    evidenceJson: JSON.stringify({
      photos: [
        { name: 'wheel.jpg', dataUrl: 'data:image/jpeg;base64,secret' }
      ],
      estimateNumber: 'EST-889'
    }),
    communications: [
      {
        subject: 'Need more photos',
        direction: 'OUTBOUND',
        channel: 'EMAIL',
        recipientType: 'GUEST',
        message: 'Please upload additional photos of the wheel.',
        createdAt: '2026-04-07T16:00:00.000Z',
        attachments: [
          { name: 'example.jpg', dataUrl: 'data:image/jpeg;base64,topsecret' }
        ]
      }
    ],
    history: [
      {
        eventType: 'TRIP_INCIDENT_UPDATED',
        eventAt: '2026-04-07T17:00:00.000Z',
        actorType: 'TENANT_USER',
        notes: 'Moved to evidence review',
        metadata: { previousStatus: 'OPEN', nextStatus: 'UNDER_REVIEW' }
      }
    ]
  });

  assert.equal(packet.filename, 'claims-packet-RES-202.html');
  assert.match(packet.body, /<!doctype html>/i);
  assert.match(packet.body, /Ride Fleet Claims Packet/);
  assert.match(packet.body, /Connected Ops Context/);
  assert.match(packet.body, /Evidence Checklist/);
  assert.match(packet.body, /Evidence Capture/);
  assert.match(packet.body, /Inspection Compare/);
  assert.match(packet.body, /Exterior/);
  assert.match(packet.body, /Damage photos/);
  assert.match(packet.body, /Damage claim after swap/);
  assert.match(packet.body, /\[inline attachment omitted from packet\]/);
  assert.doesNotMatch(packet.body, /data:image\/jpeg;base64/);
});
