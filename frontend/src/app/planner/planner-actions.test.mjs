import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutoAssignCandidates,
  buildClearAssignmentCandidates,
  buildPlannerRangePayload
} from './planner-action-helpers.mjs';

test('buildClearAssignmentCandidates only returns ASSIGNABLE (NEW/CONFIRMED) assigned reservations in range', () => {
  const rangeStart = new Date('2026-04-06T00:00:00.000Z');
  const rangeEnd = new Date('2026-04-10T00:00:00.000Z');
  const reservations = [
    { id: 'res_1', vehicleId: 'veh_1', status: 'CONFIRMED', pickupAt: '2026-04-07T10:00:00.000Z', returnAt: '2026-04-08T10:00:00.000Z' },
    { id: 'res_2', vehicleId: 'veh_2', status: 'CHECKED_OUT', pickupAt: '2026-04-07T10:00:00.000Z', returnAt: '2026-04-08T10:00:00.000Z' },
    { id: 'res_3', vehicleId: null, status: 'CONFIRMED', pickupAt: '2026-04-07T10:00:00.000Z', returnAt: '2026-04-08T10:00:00.000Z' },
    { id: 'res_4', vehicleId: 'veh_4', status: 'CONFIRMED', pickupAt: '2026-04-12T10:00:00.000Z', returnAt: '2026-04-13T10:00:00.000Z' },
    // Assignable-mirror regression (QA MAJOR 2026-07-14): these are "movable"
    // by the old predicate but the /assign endpoint 409s them (LOCKED_STATUS) —
    // offering them made the bulk clear abort partway on real data.
    { id: 'res_5', vehicleId: 'veh_5', status: 'CHECKED_IN', pickupAt: '2026-04-07T10:00:00.000Z', returnAt: '2026-04-08T10:00:00.000Z' },
    { id: 'res_6', vehicleId: 'veh_6', status: 'PENDING_FRANCHISE_IMPORT', pickupAt: '2026-04-07T10:00:00.000Z', returnAt: '2026-04-08T10:00:00.000Z' },
    { id: 'res_7', vehicleId: 'veh_7', status: 'NEW', pickupAt: '2026-04-07T10:00:00.000Z', returnAt: '2026-04-08T10:00:00.000Z' }
  ];

  const candidates = buildClearAssignmentCandidates(reservations, rangeStart, rangeEnd);

  assert.deepEqual(candidates.map((reservation) => reservation.id), ['res_1', 'res_7']);
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
