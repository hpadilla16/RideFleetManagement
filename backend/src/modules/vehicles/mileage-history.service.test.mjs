import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordMileageEntry, recordMileageEntrySafe } from './mileage-history.service.js';

// Fake DB client capturing the calls recordMileageEntry makes. No Prisma, no DB.
function fakeClient({ vehicleTenantId = 'tnt-1' } = {}) {
  const calls = [];
  return {
    calls,
    vehicle: {
      findUnique: async (args) => { calls.push({ op: 'vehicle.findUnique', args }); return { tenantId: vehicleTenantId }; },
      update: async (args) => { calls.push({ op: 'vehicle.update', args }); return {}; }
    },
    vehicleMileageEntry: {
      create: async (args) => { calls.push({ op: 'entry.create', args }); return { id: 'entry-1', ...args.data }; }
    }
  };
}

describe('recordMileageEntry', () => {
  it('creates the entry AND mirrors onto the vehicle ("last entry wins")', async () => {
    const db = fakeClient();
    await recordMileageEntry(db, {
      vehicleId: 'veh-1', tenantId: 'tnt-1', mileage: 42000, source: 'CHECKIN',
      reservationNumber: 'RES-9'
    });
    const ops = db.calls.map((c) => c.op);
    assert.deepEqual(ops, ['entry.create', 'vehicle.update']);
    const created = db.calls[0].args.data;
    assert.equal(created.mileage, 42000);
    assert.equal(created.source, 'CHECKIN');
    const mirror = db.calls[1].args.data;
    assert.equal(mirror.mileage, 42000);
    assert.equal(mirror.lastOdometerSource, 'CHECKIN_RES-9');
  });

  it('looks up tenantId only when it was not provided', async () => {
    const withTenant = fakeClient();
    await recordMileageEntry(withTenant, { vehicleId: 'v', tenantId: null, mileage: 1, source: 'MANUAL' });
    assert.ok(!withTenant.calls.some((c) => c.op === 'vehicle.findUnique'), 'null tenantId must NOT trigger a lookup');

    const noTenant = fakeClient({ vehicleTenantId: 'tnt-x' });
    await recordMileageEntry(noTenant, { vehicleId: 'v', mileage: 1, source: 'MANUAL' });
    assert.ok(noTenant.calls.some((c) => c.op === 'vehicle.findUnique'), 'missing tenantId must trigger a lookup');
    assert.equal(noTenant.calls.find((c) => c.op === 'entry.create').args.data.tenantId, 'tnt-x');
  });

  it('skips the vehicle mirror when updateVehicle=false (backfill path)', async () => {
    const db = fakeClient();
    await recordMileageEntry(db, { vehicleId: 'v', tenantId: 't', mileage: 5, source: 'IMPORT', updateVehicle: false });
    assert.deepEqual(db.calls.map((c) => c.op), ['entry.create']);
  });

  it('rejects an invalid source', async () => {
    const db = fakeClient();
    await assert.rejects(() => recordMileageEntry(db, { vehicleId: 'v', tenantId: 't', mileage: 5, source: 'BOGUS' }), /invalid source/);
  });

  it('rejects a non-numeric / negative mileage', async () => {
    const db = fakeClient();
    await assert.rejects(() => recordMileageEntry(db, { vehicleId: 'v', tenantId: 't', mileage: 'abc', source: 'MANUAL' }), /finite number/);
    await assert.rejects(() => recordMileageEntry(db, { vehicleId: 'v', tenantId: 't', mileage: -1, source: 'MANUAL' }), /cannot be negative/);
  });

  it('rejects when vehicleId is missing', async () => {
    const db = fakeClient();
    await assert.rejects(() => recordMileageEntry(db, { mileage: 5, source: 'MANUAL' }), /vehicleId is required/);
  });

  it('source tag has no reservation suffix when reservationNumber is absent', async () => {
    const db = fakeClient();
    await recordMileageEntry(db, { vehicleId: 'v', tenantId: 't', mileage: 7, source: 'MANUAL' });
    assert.equal(db.calls.find((c) => c.op === 'vehicle.update').args.data.lastOdometerSource, 'MANUAL');
  });
});

describe('recordMileageEntrySafe', () => {
  it('swallows errors and returns null instead of throwing', async () => {
    const throwing = { vehicleMileageEntry: { create: async () => { throw new Error('boom'); } } };
    const result = await recordMileageEntrySafe(throwing, { vehicleId: 'v', tenantId: 't', mileage: 5, source: 'CHECKIN' });
    assert.equal(result, null);
  });
});
