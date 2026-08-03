/**
 * Turn-Ready: configurable rules + explainable breakdown.
 *
 * The load-bearing test here is `legacyScore` — a VERBATIM copy of the scorer
 * as it stood before 2026-08-03. The planner assigns vehicles off this number,
 * so "we made the score configurable" must not mean "every score moved". The
 * sweep below drives both implementations over the cross-product of every
 * input that can affect the result and asserts they agree on score, status,
 * reasons and blockers — not just on the total.
 *
 * Everything else tests the new contract: the breakdown adds up, nothing is
 * truncated, and the two new factors stay dormant until a tenant enables them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnReadyScore } from './vehicle-intelligence.service.js';
import {
  DEFAULT_TURN_READY_RULES,
  normalizeTurnReadyRules,
  validateTurnReadyRules,
  parseStoredTurnReadyRules,
} from '../../lib/turn-ready-rules.js';

// ---------------------------------------------------------------------------
// Frozen reference — the pre-2026-08-03 implementation, unchanged.
// ---------------------------------------------------------------------------
function legacyScore({ inspection = null, telematics = null, activeBlock = null }) {
  let score = 100;
  const reasons = [];
  const blockers = [];
  const blockType = String(activeBlock?.blockType || '').toUpperCase();

  if (blockType === 'WASH_HOLD') {
    score -= 35;
    reasons.push('Vehicle is currently inside a planned wash and turnaround buffer.');
  } else if (blockType === 'MAINTENANCE_HOLD') {
    score -= 75;
    blockers.push('Vehicle is blocked for scheduled maintenance right now.');
  } else if (blockType === 'OUT_OF_SERVICE_HOLD') {
    score -= 85;
    blockers.push('Vehicle is marked out of service and should not be dispatched.');
  } else if (blockType === 'MIGRATION_HOLD') {
    score -= 70;
    blockers.push('Vehicle is still protected by a migration hold and is not dispatchable yet.');
  }

  if (inspection?.status === 'NO_DATA') {
    score -= 25;
    reasons.push('No recent inspection is on file for this vehicle.');
  } else if (inspection?.status === 'ATTENTION') {
    score -= 28;
    const missingPhotos = Math.max(0, Number(inspection?.photoCoverage?.required || 0) - Number(inspection?.photoCoverage?.captured || 0));
    if (missingPhotos > 0) {
      score -= Math.min(18, missingPhotos * 3);
      reasons.push(`Latest inspection is missing ${missingPhotos} required photo(s).`);
    }
    if (Number(inspection?.conditionAttentionCount || 0) > 0) {
      score -= Math.min(18, Number(inspection.conditionAttentionCount) * 6);
      reasons.push(`Latest inspection has ${inspection.conditionAttentionCount} condition flag(s) to review.`);
    }
    if (inspection?.damageReported) {
      score -= 16;
      blockers.push('Latest inspection reported damage that still needs review before dispatch.');
    }
    if (String(inspection?.damageTriage?.severity || '').toUpperCase() === 'HIGH') {
      score -= 25;
      blockers.push('Damage triage marked this vehicle as high-risk based on the latest inspection.');
    } else if (String(inspection?.damageTriage?.severity || '').toUpperCase() === 'MEDIUM') {
      score -= 10;
      reasons.push('Damage triage suggests moderate review before the next turn.');
    }
  }

  switch (String(telematics?.status || '').toUpperCase()) {
    case 'NO_DEVICE': score -= 8; reasons.push('No telematics device is linked to this vehicle.'); break;
    case 'NO_SIGNAL': score -= 14; reasons.push('Telematics device is linked but has not reported a signal yet.'); break;
    case 'STALE': score -= 10; reasons.push('Telematics feed has gone stale and should be checked.'); break;
    case 'OFFLINE': score -= 18; reasons.push('Telematics feed appears offline.'); break;
    default: break;
  }

  switch (String(telematics?.fuelStatus || '').toUpperCase()) {
    case 'CRITICAL': score -= 20; reasons.push('Fuel level is critically low for the next assignment.'); break;
    case 'LOW': score -= 10; reasons.push('Fuel level is low and may need attention before dispatch.'); break;
    default: break;
  }

  if (String(telematics?.gpsStatus || '').toUpperCase() === 'MISSING' && ['ONLINE', 'STALE'].includes(String(telematics?.status || '').toUpperCase())) {
    score -= 8;
    reasons.push('Latest telematics update is missing GPS coordinates.');
  }
  if (String(telematics?.odometerStatus || '').toUpperCase() === 'MISSING' && ['ONLINE', 'STALE'].includes(String(telematics?.status || '').toUpperCase())) {
    score -= 6;
    reasons.push('Latest telematics update is missing odometer data.');
  }
  if (String(telematics?.batteryStatus || '').toUpperCase() === 'LOW') {
    score -= 6;
    reasons.push('Telematics battery is low.');
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  const status = blockers.length ? 'BLOCKED'
    : finalScore >= 85 ? 'READY'
      : finalScore >= 65 ? 'WATCH' : 'ATTENTION';
  return {
    score: finalScore,
    status,
    reasons: [...new Set(reasons)].slice(0, 4),
    blockers: [...new Set(blockers)].slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// Input sweep
// ---------------------------------------------------------------------------
const BLOCKS = [null, { blockType: 'WASH_HOLD' }, { blockType: 'MAINTENANCE_HOLD' }, { blockType: 'OUT_OF_SERVICE_HOLD' }, { blockType: 'MIGRATION_HOLD' }];
const INSPECTIONS = [
  null,
  { status: 'READY' },
  { status: 'NO_DATA' },
  { status: 'ATTENTION', photoCoverage: { required: 8, captured: 8 }, conditionAttentionCount: 0, damageReported: false, damageTriage: {} },
  { status: 'ATTENTION', photoCoverage: { required: 8, captured: 2 }, conditionAttentionCount: 4, damageReported: true, damageTriage: { severity: 'HIGH' } },
  { status: 'ATTENTION', photoCoverage: { required: 8, captured: 7 }, conditionAttentionCount: 1, damageReported: false, damageTriage: { severity: 'MEDIUM' } },
];
const TELEMATICS = [
  null,
  { status: 'ONLINE', fuelStatus: 'OK', gpsStatus: 'OK', odometerStatus: 'OK', batteryStatus: 'OK' },
  { status: 'ONLINE', fuelStatus: 'CRITICAL', gpsStatus: 'MISSING', odometerStatus: 'MISSING', batteryStatus: 'LOW' },
  { status: 'STALE', fuelStatus: 'LOW', gpsStatus: 'MISSING', odometerStatus: 'OK', batteryStatus: 'OK' },
  { status: 'OFFLINE', fuelStatus: 'LOW', gpsStatus: 'MISSING', odometerStatus: 'MISSING', batteryStatus: 'LOW' },
  { status: 'NO_DEVICE' },
  { status: 'NO_SIGNAL' },
];

function sweep(fn) {
  for (const activeBlock of BLOCKS) {
    for (const inspection of INSPECTIONS) {
      for (const telematics of TELEMATICS) {
        fn({ inspection, telematics, activeBlock });
      }
    }
  }
}

describe('turn-ready — defaults reproduce the pre-2026-08-03 formula', () => {
  it('agrees with the frozen implementation on every input combination', () => {
    let checked = 0;
    sweep((input) => {
      const legacy = legacyScore(input);
      const next = buildTurnReadyScore(input);
      const where = JSON.stringify(input);
      assert.equal(next.score, legacy.score, `score drifted for ${where}`);
      assert.equal(next.status, legacy.status, `status drifted for ${where}`);
      assert.deepEqual(next.reasons, legacy.reasons, `reasons drifted for ${where}`);
      assert.deepEqual(next.blockers, legacy.blockers, `blockers drifted for ${where}`);
      checked += 1;
    });
    assert.equal(checked, BLOCKS.length * INSPECTIONS.length * TELEMATICS.length);
    assert.ok(checked >= 200, 'sweep should be broad enough to be meaningful');
  });
});

describe('turn-ready — the breakdown adds up', () => {
  it('sums to the score on every input combination', () => {
    sweep((input) => {
      const { score, breakdown } = buildTurnReadyScore(input);
      const total = breakdown.reduce((s, row) => s + row.delta, 0);
      assert.equal(total, score, `breakdown does not sum to the score for ${JSON.stringify(input)}`);
    });
  });

  it('always opens with the 100-point baseline', () => {
    sweep((input) => {
      const { breakdown } = buildTurnReadyScore(input);
      assert.equal(breakdown[0].key, 'baseline');
      assert.equal(breakdown[0].delta, 100);
    });
  });

  it('is never truncated, even when reasons and blockers are', () => {
    // Worst case: an OOS hold, a fully failed inspection and a dead feed. The
    // legacy prose caps at 4 reasons + 3 blockers; the breakdown must keep
    // every line, otherwise the column silently stops adding up.
    const input = {
      activeBlock: { blockType: 'OUT_OF_SERVICE_HOLD' },
      inspection: { status: 'ATTENTION', photoCoverage: { required: 8, captured: 0 }, conditionAttentionCount: 5, damageReported: true, damageTriage: { severity: 'HIGH' } },
      telematics: { status: 'OFFLINE', fuelStatus: 'CRITICAL', gpsStatus: 'MISSING', odometerStatus: 'MISSING', batteryStatus: 'LOW' },
    };
    const out = buildTurnReadyScore(input);
    assert.ok(out.reasons.length <= 4);
    assert.ok(out.blockers.length <= 3);
    const fired = out.breakdown.filter((r) => r.key !== 'baseline' && r.key !== 'clamp');
    assert.ok(fired.length > out.reasons.length + out.blockers.length,
      'breakdown must carry more lines than the capped prose lists');
    assert.equal(out.breakdown.reduce((s, r) => s + r.delta, 0), out.score);
  });

  it('shows the floor as its own line when the clamp fires', () => {
    const out = buildTurnReadyScore({
      activeBlock: { blockType: 'OUT_OF_SERVICE_HOLD' },
      inspection: { status: 'ATTENTION', photoCoverage: { required: 8, captured: 0 }, conditionAttentionCount: 5, damageReported: true, damageTriage: { severity: 'HIGH' } },
      telematics: { status: 'OFFLINE', fuelStatus: 'CRITICAL', gpsStatus: 'MISSING', odometerStatus: 'MISSING', batteryStatus: 'LOW' },
    });
    assert.equal(out.score, 0);
    const clamp = out.breakdown.find((r) => r.key === 'clamp');
    assert.ok(clamp, 'a clamped score must explain the clamp');
    assert.ok(clamp.delta > 0);
  });

  it('carries evidence on the lines that have any', () => {
    const out = buildTurnReadyScore({
      inspection: { status: 'ATTENTION', latestPhase: 'CHECKIN', latestAt: '2026-08-01T10:12:00.000Z', photoCoverage: { required: 8, captured: 5 }, conditionAttentionCount: 0, damageReported: false, damageTriage: {} },
      telematics: null,
      activeBlock: null,
    });
    const photos = out.breakdown.find((r) => r.key === 'inspectionMissingPhotos');
    assert.equal(photos.evidence.type, 'inspection');
    assert.equal(photos.evidence.at, '2026-08-01T10:12:00.000Z');
    assert.equal(photos.evidence.photosCaptured, 5);
  });
});

describe('turn-ready — tenant configuration', () => {
  it('honours custom weights', () => {
    const base = buildTurnReadyScore({ telematics: { status: 'OFFLINE' } });
    const heavier = buildTurnReadyScore({ telematics: { status: 'OFFLINE' } }, { ...DEFAULT_TURN_READY_RULES, telematicsOffline: 40 });
    assert.equal(base.score, 82);
    assert.equal(heavier.score, 60);
    assert.equal(heavier.breakdown.find((r) => r.key === 'telematicsOffline').delta, -40);
  });

  it('honours custom status bands', () => {
    const input = { telematics: { status: 'STALE' } };            // 100 - 10 = 90
    assert.equal(buildTurnReadyScore(input).status, 'READY');
    assert.equal(buildTurnReadyScore(input, { ...DEFAULT_TURN_READY_RULES, readyThreshold: 95 }).status, 'WATCH');
  });

  it('lets a tenant zero a factor out entirely', () => {
    const rules = { ...DEFAULT_TURN_READY_RULES, telematicsNoDevice: 0 };
    const out = buildTurnReadyScore({ telematics: { status: 'NO_DEVICE' } }, rules);
    assert.equal(out.score, 100);
    // The line still shows — "we looked and it cost you nothing" is
    // information; dropping it would make the list look incomplete.
    const row = out.breakdown.find((r) => r.key === 'telematicsNoDevice');
    assert.equal(row.delta, 0);
    assert.equal(row.kind, 'ok');
  });
});

describe('turn-ready — documents factor', () => {
  const documents = { registrationExpiresAt: '2026-08-24T00:00:00.000Z', now: '2026-08-03T00:00:00.000Z' };

  it('is dormant by default', () => {
    const out = buildTurnReadyScore({ documents });
    assert.equal(out.score, 100);
    assert.equal(out.breakdown.some((r) => r.label === 'Documents'), false);
  });

  it('deducts for an expiring registration once enabled', () => {
    const out = buildTurnReadyScore({ documents }, { ...DEFAULT_TURN_READY_RULES, documentsEnabled: true });
    const row = out.breakdown.find((r) => r.key === 'documentsExpiringSoon');
    assert.equal(row.delta, -2);
    assert.match(row.detail, /expires in 21 day/);
    assert.equal(row.evidence.daysRemaining, 21);
    assert.equal(out.score, 98);
  });

  it('deducts harder for an already-expired registration', () => {
    const out = buildTurnReadyScore(
      { documents: { registrationExpiresAt: '2026-07-24T00:00:00.000Z', now: '2026-08-03T00:00:00.000Z' } },
      { ...DEFAULT_TURN_READY_RULES, documentsEnabled: true },
    );
    assert.equal(out.breakdown.find((r) => r.key === 'documentsExpired').delta, -15);
    assert.equal(out.score, 85);
  });

  it('shows a zero-cost line when the registration is comfortably current', () => {
    const out = buildTurnReadyScore(
      { documents: { registrationExpiresAt: '2027-08-03T00:00:00.000Z', now: '2026-08-03T00:00:00.000Z' } },
      { ...DEFAULT_TURN_READY_RULES, documentsEnabled: true },
    );
    const row = out.breakdown.find((r) => r.key === 'documentsOk');
    assert.equal(row.delta, 0);
    assert.equal(out.score, 100);
  });
});

describe('turn-ready — maintenance-due factor', () => {
  it('is dormant by default', () => {
    const out = buildTurnReadyScore({ maintenance: { milesRemaining: -300, serviceType: 'OIL_CHANGE' } });
    assert.equal(out.score, 100);
  });

  it('grades by remaining mileage once enabled', () => {
    const rules = { ...DEFAULT_TURN_READY_RULES, maintenanceDueEnabled: true };
    const soon = buildTurnReadyScore({ maintenance: { milesRemaining: 300, serviceType: 'OIL_CHANGE' } }, rules);
    assert.equal(soon.breakdown.find((r) => r.key === 'maintenanceDueSoon').delta, -3);

    const overdue = buildTurnReadyScore({ maintenance: { milesRemaining: -120, serviceType: 'OIL_CHANGE' } }, rules);
    assert.equal(overdue.breakdown.find((r) => r.key === 'maintenanceOverdue').delta, -12);
    assert.match(overdue.breakdown.find((r) => r.key === 'maintenanceOverdue').detail, /overdue by 120 mi/);

    const fine = buildTurnReadyScore({ maintenance: { milesRemaining: 1200, serviceType: 'OIL_CHANGE' } }, rules);
    assert.equal(fine.breakdown.find((r) => r.key === 'maintenanceOk').delta, 0);
    assert.match(fine.breakdown.find((r) => r.key === 'maintenanceOk').detail, /next service in 1200 mi/);
  });

  it('falls back to days when mileage is unknown', () => {
    const rules = { ...DEFAULT_TURN_READY_RULES, maintenanceDueEnabled: true };
    const out = buildTurnReadyScore({ maintenance: { daysRemaining: 5, serviceType: 'INSPECTION' } }, rules);
    assert.match(out.breakdown.find((r) => r.key === 'maintenanceDueSoon').detail, /next service in 5 day/i);
  });

  it('stays silent when there is no schedule at all', () => {
    const out = buildTurnReadyScore({ maintenance: { milesRemaining: null, daysRemaining: null } }, { ...DEFAULT_TURN_READY_RULES, maintenanceDueEnabled: true });
    assert.equal(out.breakdown.some((r) => r.label === 'Maintenance'), false);
  });
});

describe('turn-ready — rule normalization', () => {
  it('drops unknown keys instead of storing them', () => {
    const out = normalizeTurnReadyRules({ nonsenseKey: 12, fuelLow: 15 });
    assert.equal(out.nonsenseKey, undefined);
    assert.equal(out.fuelLow, 15);
  });

  it('clamps weights into 0..100 so a negative cannot hand out free points', () => {
    assert.equal(normalizeTurnReadyRules({ fuelLow: -30 }).fuelLow, 0);
    assert.equal(normalizeTurnReadyRules({ fuelLow: 500 }).fuelLow, 100);
  });

  it('never lets the watch band sit above the ready band', () => {
    const out = normalizeTurnReadyRules({ readyThreshold: 70, watchThreshold: 90 });
    assert.equal(out.watchThreshold, 70);
  });

  it('rejects bad payloads with a readable message', () => {
    assert.deepEqual(validateTurnReadyRules({}), []);
    assert.match(validateTurnReadyRules({ bogus: 1 })[0], /Unknown turn-ready rule/);
    assert.match(validateTurnReadyRules({ fuelLow: 500 })[0], /between 0 and 100/);
    assert.match(validateTurnReadyRules({ readyThreshold: 60, watchThreshold: 80 })[0], /WATCH would be unreachable/);
  });

  it('falls back to defaults rather than throwing on a corrupt stored row', () => {
    assert.deepEqual(parseStoredTurnReadyRules('{not json'), { ...DEFAULT_TURN_READY_RULES });
    assert.deepEqual(parseStoredTurnReadyRules(null), { ...DEFAULT_TURN_READY_RULES });
    assert.equal(parseStoredTurnReadyRules('{"fuelLow":25}').fuelLow, 25);
  });
});
