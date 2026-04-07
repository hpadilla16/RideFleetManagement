import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateShortage,
  normalizePlannerDateRange
} from './planner.service.js';

test('normalizePlannerDateRange rejects invalid ranges', () => {
  assert.throws(() => normalizePlannerDateRange({
    start: '2026-04-07T00:00:00.000Z',
    end: '2026-04-06T00:00:00.000Z'
  }), /end must be later than start/i);
});

test('calculateShortage returns peak shortage by date, type, and location', () => {
  const start = new Date('2026-04-06T00:00:00.000Z');
  const end = new Date('2026-04-09T00:00:00.000Z');
  const reservations = [
    {
      id: 'res-1',
      status: 'CONFIRMED',
      pickupAt: '2026-04-06T10:00:00.000Z',
      returnAt: '2026-04-08T10:00:00.000Z',
      vehicleTypeId: 'vt-suv',
      pickupLocationId: 'loc-sju',
      returnLocationId: 'loc-sju'
    },
    {
      id: 'res-2',
      status: 'CONFIRMED',
      pickupAt: '2026-04-06T12:00:00.000Z',
      returnAt: '2026-04-08T11:00:00.000Z',
      vehicleTypeId: 'vt-suv',
      pickupLocationId: 'loc-sju',
      returnLocationId: 'loc-sju'
    }
  ];
  const vehicles = [
    {
      id: 'veh-1',
      vehicleTypeId: 'vt-suv',
      homeLocationId: 'loc-sju',
      status: 'READY',
      availabilityBlocks: []
    }
  ];

  const result = calculateShortage({ start, end, reservations, vehicles });

  assert.equal(result.totalCarsNeeded, 1);
  assert.deepEqual(result.byDate, [
    { date: '2026-04-06', carsNeeded: 1 },
    { date: '2026-04-07', carsNeeded: 1 }
  ]);
  assert.deepEqual(result.byVehicleType, [
    { vehicleTypeId: 'vt-suv', carsNeeded: 1 }
  ]);
  assert.deepEqual(result.byLocation, [
    { locationId: 'loc-sju', carsNeeded: 1 }
  ]);
});

