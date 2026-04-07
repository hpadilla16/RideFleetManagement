import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDamageTriage,
  buildInspectionIntelligence,
  buildTelematicsSummary,
  buildTurnReadyScore
} from './vehicle-intelligence.service.js';

test('buildDamageTriage marks high-risk inspection damage when safety keywords are present', () => {
  const triage = buildDamageTriage({
    damages: 'Customer reported cracked windshield and vehicle was towed after accident.',
    notes: 'Unsafe to drive back out',
    windshield: 'DAMAGED',
    photoCoverage: { required: 8, captured: 8 }
  });

  assert.equal(triage.severity, 'HIGH');
  assert.equal(triage.reviewNeeded, true);
  assert.ok(triage.keywords.includes('cracked') || triage.keywords.includes('crack'));
});

test('buildInspectionIntelligence embeds damage triage into latest inspection summary', () => {
  const inspection = buildInspectionIntelligence({
    checkin: {
      phase: 'CHECKIN',
      at: '2026-04-06T12:00:00.000Z',
      exterior: 'GOOD',
      interior: 'GOOD',
      tires: 'GOOD',
      lights: 'GOOD',
      windshield: 'GOOD',
      damages: 'minor scratch on rear bumper',
      notes: '',
      photos: {
        front: '1',
        rear: '1',
        left: '1',
        right: '1',
        frontSeat: '1',
        rearSeat: '1',
        dashboard: '1',
        trunk: '1'
      }
    }
  });

  assert.equal(inspection.damageReported, true);
  assert.equal(inspection.damageTriage.severity, 'MEDIUM');
});

test('buildTurnReadyScore blocks dispatch when damage triage is high-risk', () => {
  const turnReady = buildTurnReadyScore({
    inspection: {
      status: 'ATTENTION',
      damageReported: true,
      damageTriage: {
        severity: 'HIGH'
      },
      photoCoverage: { required: 8, captured: 8 },
      conditionAttentionCount: 2
    },
    telematics: {
      status: 'ONLINE'
    }
  });

  assert.equal(turnReady.status, 'BLOCKED');
  assert.ok(turnReady.score < 65);
});

test('buildTelematicsSummary classifies low fuel and missing GPS from latest signal', () => {
  const telematics = buildTelematicsSummary({
    device: {
      provider: 'GENERIC',
      externalDeviceId: 'dev-1',
      label: 'Tracker 1',
      lastSeenAt: new Date().toISOString()
    },
    event: {
      eventAt: new Date().toISOString(),
      fuelPct: 12,
      odometer: null,
      latitude: null,
      longitude: null,
      batteryPct: 18,
      speedMph: 0,
      engineOn: false
    }
  });

  assert.equal(telematics.status, 'ONLINE');
  assert.equal(telematics.fuelStatus, 'CRITICAL');
  assert.equal(telematics.gpsStatus, 'MISSING');
  assert.equal(telematics.odometerStatus, 'MISSING');
  assert.equal(telematics.batteryStatus, 'LOW');
  assert.ok(telematics.alerts.length >= 3);
});

test('buildTurnReadyScore penalizes telematics fuel and GPS issues', () => {
  const turnReady = buildTurnReadyScore({
    inspection: {
      status: 'READY',
      damageReported: false,
      damageTriage: { severity: 'NONE' },
      photoCoverage: { required: 8, captured: 8 },
      conditionAttentionCount: 0
    },
    telematics: {
      status: 'ONLINE',
      fuelStatus: 'CRITICAL',
      gpsStatus: 'MISSING',
      odometerStatus: 'MISSING',
      batteryStatus: 'LOW'
    }
  });

  assert.ok(turnReady.score < 80);
  assert.notEqual(turnReady.status, 'READY');
});

test('buildTelematicsSummary stays neutral when telematics feature is disabled', () => {
  const telematics = buildTelematicsSummary({
    featureEnabled: false
  });

  assert.equal(telematics.status, 'DISABLED');
  assert.equal(telematics.summary, 'Telematics is disabled for this tenant.');
});
