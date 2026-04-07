import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutoAssignCandidates,
  buildClearAssignmentCandidates,
  buildDropMovePlan,
  buildPlannerRangePayload,
  buildVehicleClearUpdates
} from './planner-action-helpers.mjs';

test('buildDropMovePlan calculates new pickup, return and target vehicle patch', () => {
  const originalPickup = new Date(2026, 3, 7, 10, 0, 0);
  const originalReturn = new Date(2026, 3, 8, 10, 0, 0);
  const expectedPickup = new Date(2026, 3, 8, 10, 0, 0);
  const expectedReturn = new Date(2026, 3, 9, 10, 0, 0);
  const reservation = {
    id: 'res_1',
    reservationNumber: 'R-1',
    pickupAt: originalPickup.toISOString(),
    returnAt: originalReturn.toISOString()
  };
  const rangeStart = new Date(2026, 3, 6, 0, 0, 0);
  const vehicleTracks = [{ id: 'veh_1', internalNumber: '101' }];

  const plan = buildDropMovePlan({
    reservation,
    trackVehicleId: 'veh_1',
    dayIndexRaw: '2',
    rangeStart,
    vehicleTracks
  });

  assert.equal(plan.targetVehicleLabel, '101');
  assert.equal(plan.patch.vehicleId, 'veh_1');
  assert.equal(plan.newPickup.toISOString(), expectedPickup.toISOString());
  assert.equal(plan.newReturn.toISOString(), expectedReturn.toISOString());
});

test('buildDropMovePlan honors pointer offset to shift start day inside the target cell', () => {
  const originalPickup = new Date(2026, 3, 7, 10, 0, 0);
  const originalReturn = new Date(2026, 3, 8, 10, 0, 0);
  const expectedPickup = new Date(2026, 3, 6, 10, 0, 0);
  const reservation = {
    id: 'res_1',
    reservationNumber: 'R-1',
    pickupAt: originalPickup.toISOString(),
    returnAt: originalReturn.toISOString()
  };
  const rangeStart = new Date(2026, 3, 6, 0, 0, 0);

  const plan = buildDropMovePlan({
    reservation,
    trackVehicleId: '__unassigned__',
    dayIndexRaw: 1,
    dropMetrics: { pointerOffsetWithinCellPx: 5 },
    dragMeta: { grabOffsetPx: 70 },
    rangeStart,
    vehicleTracks: []
  });

  assert.equal(plan.targetVehicleLabel, 'Unassigned');
  assert.equal(plan.patch.vehicleId, null);
  assert.equal(plan.newPickup.toISOString(), expectedPickup.toISOString());
});

test('buildClearAssignmentCandidates only returns movable assigned reservations in range', () => {
  const rangeStart = new Date('2026-04-06T00:00:00.000Z');
  const rangeEnd = new Date('2026-04-10T00:00:00.000Z');
  const reservations = [
    { id: 'res_1', vehicleId: 'veh_1', status: 'CONFIRMED', pickupAt: '2026-04-07T10:00:00.000Z', returnAt: '2026-04-08T10:00:00.000Z' },
    { id: 'res_2', vehicleId: 'veh_2', status: 'CHECKED_OUT', pickupAt: '2026-04-07T10:00:00.000Z', returnAt: '2026-04-08T10:00:00.000Z' },
    { id: 'res_3', vehicleId: null, status: 'CONFIRMED', pickupAt: '2026-04-07T10:00:00.000Z', returnAt: '2026-04-08T10:00:00.000Z' },
    { id: 'res_4', vehicleId: 'veh_4', status: 'CONFIRMED', pickupAt: '2026-04-12T10:00:00.000Z', returnAt: '2026-04-13T10:00:00.000Z' }
  ];

  const candidates = buildClearAssignmentCandidates(reservations, rangeStart, rangeEnd);

  assert.deepEqual(candidates.map((reservation) => reservation.id), ['res_1']);
  assert.deepEqual(buildVehicleClearUpdates(candidates), [{ id: 'res_1', patch: { vehicleId: null } }]);
});

test('buildAutoAssignCandidates only returns movable unassigned reservations', () => {
  const reservations = [
    { id: 'res_1', vehicleId: null, status: 'CONFIRMED' },
    { id: 'res_2', vehicleId: null, status: 'CHECKED_OUT' },
    { id: 'res_3', vehicleId: 'veh_3', status: 'NEW' }
  ];

  const candidates = buildAutoAssignCandidates(reservations);

  assert.deepEqual(candidates.map((reservation) => reservation.id), ['res_1']);
});

test('buildPlannerRangePayload serializes visible planner filters and extras', () => {
  const payload = buildPlannerRangePayload({
    rangeStart: new Date('2026-04-06T00:00:00.000Z'),
    rangeEnd: new Date('2026-04-13T00:00:00.000Z'),
    filterLocationId: 'loc_1',
    filterVehicleTypeId: '',
    extra: { durationMinutes: 120 }
  });

  assert.equal(payload.locationId, 'loc_1');
  assert.equal(payload.vehicleTypeId, null);
  assert.equal(payload.durationMinutes, 120);
  assert.equal(payload.start, '2026-04-06T00:00:00.000Z');
});
