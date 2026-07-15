import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptSnapshotTrack,
  adjustCountersForAssignment,
  applyAssignmentToTracks,
  boardRowHeight,
  buildBoardRows,
  buildKpiPills,
  buildLockedReservationIds,
  computeDragLegality,
  computeVirtualWindow,
  evaluateVehicleForReservation,
  ghostPositionForReservation,
  parseAssignConflict,
  reservationMatchesSearch
} from './planner-board-helpers.mjs';

const RANGE_START = new Date('2026-07-14T00:00:00.000Z');

function makeTrack({ id = 'veh_1', typeId = 'vt_suv', status = 'AVAILABLE', homeLocationId = 'loc_1', items = [], laneCount = 1 } = {}) {
  return {
    vehicle: {
      id,
      internalNumber: '101',
      plate: 'JZW-102',
      make: 'Kia',
      model: 'Sportage',
      status,
      vehicleTypeId: typeId,
      homeLocationId,
      vehicleType: { id: typeId, name: 'SUV', code: 'SUV' }
    },
    items,
    laneCount
  };
}

function makeReservationItem(overrides = {}) {
  return {
    kind: 'reservation',
    id: 'res_1',
    reservationNumber: 'RES-1',
    status: 'CONFIRMED',
    pickupAt: '2026-07-15T10:00:00.000Z',
    returnAt: '2026-07-18T10:00:00.000Z',
    vehicleId: null,
    vehicleTypeId: 'vt_suv',
    pickupLocationId: 'loc_1',
    customer: { firstName: 'Maria', lastName: 'Perez' },
    start: 1,
    end: 4,
    span: 3,
    lane: 0,
    ...overrides
  };
}

test('buildLockedReservationIds only locks CHECKED_OUT reservations', () => {
  const locked = buildLockedReservationIds([
    { id: 'a', status: 'CHECKED_OUT' },
    { id: 'b', status: 'CONFIRMED' }
  ]);
  assert.equal(locked.has('a'), true);
  assert.equal(locked.has('b'), false);
});

test('adaptSnapshotTrack accepts laneCount and legacy lanes shapes', () => {
  assert.equal(adaptSnapshotTrack({ vehicle: { id: 'v' }, items: [], laneCount: 3 }).laneCount, 3);
  assert.equal(adaptSnapshotTrack({ vehicle: { id: 'v' }, items: [], lanes: 2 }).laneCount, 2);
  assert.equal(adaptSnapshotTrack({ vehicle: { id: 'v' } }).laneCount, 1);
});

test('buildBoardRows groups tracks by vehicle type with headers and supports search', () => {
  const tracks = [
    makeTrack({ id: 'veh_1' }),
    makeTrack({ id: 'veh_2', typeId: 'vt_sedan' }),
    {
      vehicle: { id: 'veh_3', plate: 'ZZZ-999', vehicleTypeId: 'vt_sedan', vehicleType: { id: 'vt_sedan', name: 'Sedan', code: 'SDN' } },
      items: [makeReservationItem({ id: 'res_9', reservationNumber: 'RES-4471' })],
      laneCount: 1
    }
  ];
  const rows = buildBoardRows({ tracks });
  const groups = rows.filter((row) => row.kind === 'group');
  assert.equal(groups.length, 2);
  assert.equal(rows[0].kind, 'group');

  // Search by reservation number narrows to the vehicle carrying it.
  const searched = buildBoardRows({ tracks, search: '4471' });
  const vehicles = searched.filter((row) => row.kind === 'vehicle');
  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].track.vehicle.id, 'veh_3');
});

test('reservationMatchesSearch matches number, customer and class', () => {
  const reservation = makeReservationItem();
  assert.equal(reservationMatchesSearch(reservation, 'perez'), true);
  assert.equal(reservationMatchesSearch(reservation, 'res-1'), true);
  assert.equal(reservationMatchesSearch(reservation, 'nope'), false);
  assert.equal(reservationMatchesSearch(reservation, ''), true);
});

test('computeVirtualWindow windows rows with padding', () => {
  const heights = Array.from({ length: 100 }, () => 50);
  const window1 = computeVirtualWindow({ heights, scrollTop: 1000, viewportHeight: 500, overscan: 100 });
  assert.equal(window1.totalHeight, 5000);
  assert.ok(window1.start > 0);
  assert.ok(window1.end < 100);
  assert.equal(window1.topPad, window1.start * 50);
  // Every row between start and end covers the viewport plus overscan.
  assert.ok(window1.start * 50 <= 900);
  assert.ok(window1.end * 50 >= 1600);

  const empty = computeVirtualWindow({ heights: [], scrollTop: 0, viewportHeight: 500 });
  assert.equal(empty.totalHeight, 0);
});

test('boardRowHeight grows with lanes', () => {
  assert.equal(boardRowHeight({ kind: 'group' }), 34);
  assert.equal(boardRowHeight({ kind: 'vehicle', track: { laneCount: 1 } }), 48);
  assert.equal(boardRowHeight({ kind: 'vehicle', track: { laneCount: 3 } }), 3 * 36 + 12);
});

test('evaluateVehicleForReservation flags OCCUPIED on raw overlap', () => {
  const track = makeTrack({
    items: [makeReservationItem({ id: 'res_other', pickupAt: '2026-07-16T10:00:00.000Z', returnAt: '2026-07-20T10:00:00.000Z' })]
  });
  const result = evaluateVehicleForReservation({ reservation: makeReservationItem(), track, rules: { minTurnaroundMinutes: 60 } });
  assert.equal(result.legal, false);
  assert.equal(result.reason, 'OCCUPIED');
});

test('evaluateVehicleForReservation flags TURNAROUND when only the buffer overlaps', () => {
  // Other booking ends exactly at pickup — raw ok, buffer not.
  const track = makeTrack({
    items: [makeReservationItem({ id: 'res_other', pickupAt: '2026-07-14T10:00:00.000Z', returnAt: '2026-07-15T10:00:00.000Z' })]
  });
  const result = evaluateVehicleForReservation({ reservation: makeReservationItem(), track, rules: { minTurnaroundMinutes: 240 } });
  assert.equal(result.legal, false);
  assert.equal(result.reason, 'TURNAROUND');
});

test('evaluateVehicleForReservation applies type, location and status gates', () => {
  const reservation = makeReservationItem();
  const mismatch = evaluateVehicleForReservation({
    reservation,
    track: makeTrack({ typeId: 'vt_sedan' }),
    rules: { strictVehicleTypeMatch: true }
  });
  assert.equal(mismatch.reason, 'TYPE_MISMATCH');

  const crossLocation = evaluateVehicleForReservation({
    reservation,
    track: makeTrack({ homeLocationId: 'loc_2' }),
    rules: { allowCrossLocationReassignment: false }
  });
  assert.equal(crossLocation.reason, 'CROSS_LOCATION');

  const lockedStatus = evaluateVehicleForReservation({
    reservation,
    track: makeTrack({ status: 'IN_MAINTENANCE' }),
    rules: {}
  });
  assert.equal(lockedStatus.reason, 'LOCKED_STATUS');

  const legal = evaluateVehicleForReservation({ reservation, track: makeTrack(), rules: { strictVehicleTypeMatch: true, minTurnaroundMinutes: 60 } });
  assert.equal(legal.legal, true);
});

test('computeDragLegality maps every track and skips the dragged reservation itself', () => {
  const reservation = makeReservationItem({ vehicleId: 'veh_1' });
  const tracks = [
    makeTrack({ id: 'veh_1', items: [reservation] }),
    makeTrack({ id: 'veh_2' })
  ];
  const map = computeDragLegality({ reservation, tracks, rules: { minTurnaroundMinutes: 60 } });
  assert.equal(map.veh_1.legal, true); // its own bar does not conflict
  assert.equal(map.veh_2.legal, true);
});

test('ghostPositionForReservation clamps to the visible range', () => {
  const reservation = makeReservationItem({ pickupAt: '2026-07-12T00:00:00.000Z', returnAt: '2026-07-16T00:00:00.000Z' });
  const ghost = ghostPositionForReservation(reservation, RANGE_START, 7);
  assert.equal(ghost.start, 0);
  assert.equal(ghost.span, 2);

  const outside = ghostPositionForReservation(
    makeReservationItem({ pickupAt: '2026-08-01T00:00:00.000Z', returnAt: '2026-08-03T00:00:00.000Z' }),
    RANGE_START,
    7
  );
  assert.equal(outside, null);
});

test('applyAssignmentToTracks moves a reservation between tracks and re-lanes', () => {
  const reservation = makeReservationItem({ vehicleId: 'veh_1' });
  const tracks = [
    makeTrack({ id: 'veh_1', items: [reservation], laneCount: 1 }),
    makeTrack({ id: 'veh_2', items: [], laneCount: 1 })
  ];
  const moved = applyAssignmentToTracks({ tracks, reservation: { ...reservation, vehicleId: 'veh_2' }, vehicleId: 'veh_2', rangeStart: RANGE_START });
  assert.equal(moved[0].items.length, 0);
  assert.equal(moved[1].items.length, 1);
  assert.equal(moved[1].items[0].vehicleId, 'veh_2');

  // Unassign: reservation leaves every track.
  const cleared = applyAssignmentToTracks({ tracks: moved, reservation, vehicleId: null, rangeStart: RANGE_START });
  assert.equal(cleared[1].items.length, 0);
});

test('applyAssignmentToTracks inserts a dock reservation with computed offsets', () => {
  const reservation = makeReservationItem({ vehicleId: null, start: undefined, end: undefined, span: undefined });
  const tracks = [makeTrack({ id: 'veh_1', items: [] })];
  const next = applyAssignmentToTracks({ tracks, reservation, vehicleId: 'veh_1', rangeStart: RANGE_START });
  const item = next[0].items[0];
  assert.equal(item.kind, 'reservation');
  assert.ok(Math.abs(item.start - 1.4166) < 0.01);
  assert.ok(item.span > 2.9);
});

test('adjustCountersForAssignment tracks the unassigned count both ways', () => {
  const counters = { unassignedCount: 3, unassigned: 3 };
  const assigned = adjustCountersForAssignment(counters, null, 'veh_1');
  assert.equal(assigned.unassignedCount, 2);
  assert.equal(assigned.unassigned, 2);
  const unassigned = adjustCountersForAssignment(assigned, 'veh_1', null);
  assert.equal(unassigned.unassignedCount, 3);
  const noChange = adjustCountersForAssignment(assigned, 'veh_1', 'veh_2');
  assert.equal(noChange.unassignedCount, 2);
});

test('buildKpiPills prefers new counter names and falls back to legacy + shortage', () => {
  // REAL snapshot shape: counters.shortageToday is an OBJECT {count, vehicleTypeId,
  // vehicleType} or null — Number(object) was NaN (Innovation MUST-CHANGE 2026-07-14).
  const modern = buildKpiPills({
    unassignedCount: 7, overbookedCount: 2, pickupsToday: 11, returnsToday: 9,
    shortageToday: { count: 3, vehicleTypeId: 'vt-suv', vehicleType: 'SUV' }
  });
  assert.deepEqual(modern, {
    unassigned: 7, overbooked: 2, shortageToday: 3,
    shortageTodayType: 'SUV', shortageTodayTypeId: 'vt-suv',
    pickupsToday: 11, returnsToday: 9
  });

  // Null shortage today → 0, no type.
  const noShort = buildKpiPills({ unassignedCount: 0, overbookedCount: 0, pickupsToday: 1, returnsToday: 1, shortageToday: null });
  assert.equal(noShort.shortageToday, 0);
  assert.equal(noShort.shortageTodayType, null);

  // Legacy numeric shape still accepted (older snapshots).
  const numeric = buildKpiPills({ unassignedCount: 1, overbookedCount: 0, pickupsToday: 0, returnsToday: 0, shortageToday: 3 });
  assert.equal(numeric.shortageToday, 3);

  const legacy = buildKpiPills({ unassigned: 4, overbooked: 1, pickups: 5, returns: 6 }, { totalCarsNeeded: 2 });
  assert.deepEqual(legacy, {
    unassigned: 4, overbooked: 1, shortageToday: 2,
    shortageTodayType: null, shortageTodayTypeId: null,
    pickupsToday: 5, returnsToday: 6
  });
});

test('parseAssignConflict prefers structured fields and falls back to message parsing', () => {
  const structured = new Error('Vehicle class does not match');
  structured.status = 409;
  structured.conflictCode = 'TYPE_MISMATCH';
  structured.conflictDetail = 'SUV required, SEDAN offered';
  const parsedStructured = parseAssignConflict(structured);
  assert.equal(parsedStructured.code, 'TYPE_MISMATCH');
  assert.equal(parsedStructured.detail, 'SUV required, SEDAN offered');

  const error = new Error('/api/planner/assign failed (409): {"code":"TYPE_MISMATCH","detail":"SUV required, SEDAN offered"}');
  error.status = 409;
  const parsed = parseAssignConflict(error);
  assert.equal(parsed.status, 409);
  assert.equal(parsed.code, 'TYPE_MISMATCH');
  assert.equal(parsed.detail, 'SUV required, SEDAN offered');

  const plain = parseAssignConflict(new Error('OCCUPIED'));
  assert.equal(plain.code, 'OCCUPIED');

  const unknown = parseAssignConflict(new Error('boom'));
  assert.equal(unknown.code, null);
});
