import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlannerQuery,
  buildTrackOccupancy,
  createPlannerCopilotConfig,
  createPlannerRulesForm,
  hasTurnReadyAttention,
  scoreVehicleFit,
  startOfDay,
  turnReadyTone
} from './planner-utils.mjs';

test('startOfDay normalizes time to midnight', () => {
  const value = startOfDay('2026-04-06T14:32:11.000Z');
  assert.equal(value.getHours(), 0);
  assert.equal(value.getMinutes(), 0);
  assert.equal(value.getSeconds(), 0);
  assert.equal(value.getMilliseconds(), 0);
});

test('buildPlannerQuery only includes active filters', () => {
  const start = new Date('2026-04-06T00:00:00.000Z');
  const end = new Date('2026-04-13T00:00:00.000Z');
  const query = buildPlannerQuery(start, end, 'loc_1', '');
  assert.match(query, /^\/api\/planner\/snapshot\?/);
  assert.match(query, /locationId=loc_1/);
  assert.doesNotMatch(query, /vehicleTypeId=/);
});

test('buildTrackOccupancy includes reservations and active blocks per vehicle', () => {
  const vehicles = [
    {
      id: 'veh_1',
      availabilityBlocks: [
        {
          id: 'blk_1',
          blockedFrom: '2026-04-07T10:00:00.000Z',
          availableFrom: '2026-04-07T12:00:00.000Z'
        }
      ]
    }
  ];
  const reservations = [
    {
      id: 'res_1',
      vehicleId: 'veh_1',
      status: 'CONFIRMED',
      pickupAt: '2026-04-06T10:00:00.000Z',
      returnAt: '2026-04-06T15:00:00.000Z'
    }
  ];

  const occupancy = buildTrackOccupancy({ vehicles, reservations });
  const intervals = occupancy.get('veh_1');

  assert.equal(intervals.length, 2);
  assert.equal(intervals[0].type, 'reservation');
  assert.equal(intervals[1].type, 'block');
});

test('scoreVehicleFit penalizes cross-location fit', () => {
  const reservation = {
    pickupAt: '2026-04-06T10:00:00.000Z',
    returnAt: '2026-04-07T10:00:00.000Z',
    pickupLocationId: 'loc_pickup',
    returnLocationId: 'loc_return'
  };
  const intervals = [];
  const localVehicleScore = scoreVehicleFit({ homeLocationId: 'loc_pickup' }, reservation, intervals);
  const remoteVehicleScore = scoreVehicleFit({ homeLocationId: 'another_loc' }, reservation, intervals);

  assert.ok(remoteVehicleScore > localVehicleScore);
});

test('createPlannerRulesForm and createPlannerCopilotConfig fill safe defaults', () => {
  const rules = createPlannerRulesForm();
  const copilot = createPlannerCopilotConfig();

  assert.equal(rules.minTurnaroundMinutes, '60');
  assert.equal(rules.assignmentMode, 'STRICT');
  assert.equal(copilot.enabled, false);
  assert.equal(copilot.model, 'gpt-4.1-mini');
  assert.equal(copilot.usage.currentPeriod.totalQueries, 0);
});

test('turn-ready helpers recognize attention and tone safely', () => {
  const vehicle = {
    operationalSignals: {
      turnReady: {
        status: 'BLOCKED',
        score: 22
      }
    }
  };

  assert.equal(hasTurnReadyAttention(vehicle), true);
  assert.equal(turnReadyTone('BLOCKED'), 'warn');
  assert.equal(turnReadyTone('READY'), 'good');
});
