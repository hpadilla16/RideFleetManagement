import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferVehicleStatusForReservationStatus,
  syncVehicleStatusForReservation,
  LOCKED_VEHICLE_STATUSES,
} from './vehicle-status-sync.js';

/**
 * Minimal Prisma-client shim. Seed reservations + vehicles, then assert what
 * vehicle.update was called with. Records every update for inspection.
 */
function makeClient({ reservations = {}, vehicles = {} } = {}) {
  const updates = [];
  return {
    updates,
    reservation: {
      async findUnique({ where: { id } }) {
        return reservations[id] ? { vehicleId: reservations[id].vehicleId ?? null } : null;
      },
    },
    vehicle: {
      async findUnique({ where: { id } }) {
        const v = vehicles[id];
        if (!v) return null;
        return { id, status: v.status, internalNumber: v.internalNumber ?? null, plate: v.plate ?? null };
      },
      async update({ where: { id }, data }) {
        updates.push({ id, data });
        if (vehicles[id]) vehicles[id].status = data.status;
        return { id, ...data };
      },
    },
  };
}

test('mapping: only CHECKED_OUT is ON_RENT, everything else AVAILABLE', () => {
  assert.equal(inferVehicleStatusForReservationStatus('CHECKED_OUT'), 'ON_RENT');
  for (const s of ['NEW', 'CONFIRMED', 'PENDING_FRANCHISE_IMPORT', 'CHECKED_IN', 'CHECKED_IN_UNPAID', 'CANCELLED', 'NO_SHOW']) {
    assert.equal(inferVehicleStatusForReservationStatus(s), 'AVAILABLE', `${s} should map to AVAILABLE`);
  }
});

test('mapping: unknown status carries no opinion (null)', () => {
  assert.equal(inferVehicleStatusForReservationStatus('SOMETHING_ELSE'), null);
  assert.equal(inferVehicleStatusForReservationStatus(undefined), null);
});

test('checkout flips AVAILABLE -> ON_RENT', async () => {
  const client = makeClient({ vehicles: { v1: { status: 'AVAILABLE', internalNumber: 'UNIT-1', plate: 'AAA111' } } });
  const r = await syncVehicleStatusForReservation(client, { vehicleId: 'v1', toStatus: 'CHECKED_OUT' });
  assert.deepEqual(r, { from: 'AVAILABLE', to: 'ON_RENT', vehicleId: 'v1', internalNumber: 'UNIT-1', plate: 'AAA111' });
  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0].data.status, 'ON_RENT');
});

test('checkin (unpaid) frees the car: ON_RENT -> AVAILABLE', async () => {
  const client = makeClient({ vehicles: { v1: { status: 'ON_RENT' } } });
  const r = await syncVehicleStatusForReservation(client, { vehicleId: 'v1', toStatus: 'CHECKED_IN_UNPAID' });
  assert.equal(r.to, 'AVAILABLE');
  assert.equal(client.updates[0].data.status, 'AVAILABLE');
});

test('resolves vehicle from reservationId when vehicleId not given', async () => {
  const client = makeClient({
    reservations: { res1: { vehicleId: 'v9' } },
    vehicles: { v9: { status: 'AVAILABLE' } },
  });
  const r = await syncVehicleStatusForReservation(client, { reservationId: 'res1', toStatus: 'CHECKED_OUT' });
  assert.equal(r.to, 'ON_RENT');
  assert.equal(client.updates[0].id, 'v9');
});

test('never overwrites a locked vehicle (maintenance / OOS / sold)', async () => {
  for (const locked of LOCKED_VEHICLE_STATUSES) {
    const client = makeClient({ vehicles: { v1: { status: locked } } });
    const r = await syncVehicleStatusForReservation(client, { vehicleId: 'v1', toStatus: 'CHECKED_OUT' });
    assert.deepEqual(r, { skipped: true, reason: `vehicle is ${locked}`, vehicleId: 'v1' });
    assert.equal(client.updates.length, 0, `${locked} must not be written`);
  }
});

test('noop when already at target (no write)', async () => {
  const client = makeClient({ vehicles: { v1: { status: 'ON_RENT' } } });
  const r = await syncVehicleStatusForReservation(client, { vehicleId: 'v1', toStatus: 'CHECKED_OUT' });
  assert.deepEqual(r, { noop: true, status: 'ON_RENT', vehicleId: 'v1' });
  assert.equal(client.updates.length, 0);
});

test('returns null when reservation has no vehicle', async () => {
  const client = makeClient({ reservations: { res1: { vehicleId: null } } });
  const r = await syncVehicleStatusForReservation(client, { reservationId: 'res1', toStatus: 'CHECKED_OUT' });
  assert.equal(r, null);
  assert.equal(client.updates.length, 0);
});

test('returns null for a status with no vehicle opinion', async () => {
  const client = makeClient({ vehicles: { v1: { status: 'AVAILABLE' } } });
  const r = await syncVehicleStatusForReservation(client, { vehicleId: 'v1', toStatus: 'WAT' });
  assert.equal(r, null);
  assert.equal(client.updates.length, 0);
});
