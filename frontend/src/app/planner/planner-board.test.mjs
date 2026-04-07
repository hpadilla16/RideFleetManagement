import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildItemsByTrack,
  buildLockedReservationIds,
  buildPlannerFocusItems,
  buildPlannerFocusOptions,
  buildPlannerFocusSummary,
  buildPlannerOpsBoard,
  buildTrackRows,
  buildVehicleTracks,
  filterPlannerVehicles
} from './planner-board-helpers.mjs';

test('buildVehicleTracks keeps unassigned lane first and sorts vehicles by type and label', () => {
  const filteredVehicles = filterPlannerVehicles([
    { id: 'veh_2', internalNumber: '200', make: 'Toyota', model: 'Corolla', vehicleTypeId: 'vt_sedan', homeLocationId: 'loc_1', vehicleType: { name: 'Sedan', code: 'SDN' } },
    { id: 'veh_1', internalNumber: '101', make: 'Jeep', model: 'Wrangler', vehicleTypeId: 'vt_suv', homeLocationId: 'loc_1', vehicleType: { name: 'SUV', code: 'SUV' } }
  ], '', '');

  const tracks = buildVehicleTracks(filteredVehicles);

  assert.equal(tracks[0].id, '__unassigned__');
  assert.equal(tracks[1].id, 'veh_2');
  assert.equal(tracks[2].id, 'veh_1');
});

test('buildTrackRows creates vehicle-type group headers and track rows', () => {
  const tracks = buildVehicleTracks([
    { id: 'veh_1', internalNumber: '101', vehicleTypeId: 'vt_suv', vehicleType: { name: 'SUV', code: 'SUV' } },
    { id: 'veh_2', internalNumber: '102', vehicleTypeId: 'vt_suv', vehicleType: { name: 'SUV', code: 'SUV' } }
  ]);

  const rows = buildTrackRows(tracks);

  assert.equal(rows[0].kind, 'track');
  assert.equal(rows[1].kind, 'group');
  assert.equal(rows[1].count, 2);
  assert.equal(rows[2].vehicle.id, 'veh_1');
  assert.equal(rows[3].vehicle.id, 'veh_2');
});

test('buildItemsByTrack assigns overlapping reservations and blocks into separate lanes', () => {
  const rangeStart = new Date('2026-04-07T00:00:00.000Z');
  const rangeEnd = new Date('2026-04-10T00:00:00.000Z');
  const vehicleTracks = buildVehicleTracks([
    {
      id: 'veh_1',
      internalNumber: '101',
      vehicleTypeId: 'vt_suv',
      vehicleType: { name: 'SUV', code: 'SUV' },
      availabilityBlocks: [
        {
          id: 'blk_1',
          blockedFrom: '2026-04-08T09:00:00.000Z',
          availableFrom: '2026-04-08T11:00:00.000Z'
        }
      ]
    }
  ]);
  const vehicles = [
    {
      id: 'veh_1',
      internalNumber: '101',
      vehicleTypeId: 'vt_suv',
      vehicleType: { name: 'SUV', code: 'SUV' },
      availabilityBlocks: [
        {
          id: 'blk_1',
          blockedFrom: '2026-04-08T09:00:00.000Z',
          availableFrom: '2026-04-08T11:00:00.000Z'
        }
      ]
    }
  ];
  const reservations = [
    {
      id: 'res_1',
      reservationNumber: 'R-1',
      vehicleId: 'veh_1',
      pickupAt: '2026-04-08T08:00:00.000Z',
      returnAt: '2026-04-08T12:00:00.000Z'
    }
  ];

  const itemsByTrack = buildItemsByTrack({
    vehicleTracks,
    reservations,
    vehicles,
    rangeStart,
    rangeEnd,
    dayCount: 3
  });
  const track = itemsByTrack.get('veh_1');

  assert.equal(track.items.length, 2);
  assert.equal(track.lanes, 2);
  assert.notEqual(track.items[0].lane, track.items[1].lane);
});

test('buildPlannerOpsBoard summarizes holds, shortages and next work queues', () => {
  const reservations = [
    {
      id: 'res_1',
      reservationNumber: 'R-1',
      status: 'CONFIRMED',
      pickupAt: new Date().toISOString(),
      returnAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      customer: { firstName: 'Ana', lastName: 'Perez' }
    },
    {
      id: 'res_2',
      reservationNumber: 'R-2',
      status: 'CHECKED_OUT',
      pickupAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      returnAt: new Date().toISOString(),
      vehicleId: 'veh_1',
      customer: { firstName: 'Luis', lastName: 'Diaz' }
    }
  ];
  const vehicles = [
    {
      id: 'veh_1',
      availabilityBlocks: [
        {
          id: 'blk_1',
          blockType: 'WASH_HOLD',
          blockedFrom: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          availableFrom: new Date(Date.now() + 60 * 60 * 1000).toISOString()
        }
      ],
      operationalSignals: {
        turnReady: { status: 'BLOCKED' },
        inspection: { status: 'ATTENTION' },
        telematics: { status: 'OFFLINE' }
      }
    }
  ];

  const lockedReservationIds = buildLockedReservationIds(reservations);
  const opsBoard = buildPlannerOpsBoard({
    reservations,
    vehicles,
    lockedReservationIds,
    overbookedReservationIds: ['res_3'],
    plannerMaintenancePlan: { recommendations: [{ id: 'm1' }] },
    plannerWashPlan: { violations: [{ id: 'w1' }] }
  });

  assert.equal(opsBoard.checkedOut, 1);
  assert.equal(opsBoard.washHolds, 1);
  assert.equal(opsBoard.turnReadyBlocked, 1);
  assert.equal(opsBoard.inspectionAttention, 1);
  assert.equal(opsBoard.telematicsAttention, 1);
  assert.equal(opsBoard.overbooked, 1);
  assert.equal(opsBoard.maintenanceRecommendations, 1);
  assert.equal(opsBoard.washViolations, 1);
  assert.equal(opsBoard.nextItems.length >= 2, true);
});

test('planner focus helpers filter queue counts and summaries correctly', () => {
  const plannerOpsBoard = {
    nextItems: [
      { id: '1', focus: 'PICKUPS' },
      { id: '2', focus: 'PICKUPS' },
      { id: '3', focus: 'RETURNS' }
    ]
  };

  const options = buildPlannerFocusOptions(plannerOpsBoard);
  const pickupItems = buildPlannerFocusItems('PICKUPS', plannerOpsBoard);
  const summary = buildPlannerFocusSummary('RETURNS');

  assert.equal(options.find((option) => option.id === 'ALL').count, 3);
  assert.equal(options.find((option) => option.id === 'PICKUPS').count, 2);
  assert.equal(pickupItems.length, 2);
  assert.match(summary, /return work visible/i);
});
