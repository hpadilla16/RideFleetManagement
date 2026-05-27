/**
 * Tests for availability.report.js (Round 29).
 * Run: node --test backend/src/modules/reports/availability.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _availabilitySnapshotInternal } from './availability.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, typeDrillDownHandler, aggregateByType, VEHICLE_STATUSES } = _availabilitySnapshotInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ vehicles = [], activeReservations = [] } = {}) {
  return {
    vehicle: {
      async findMany({ where, orderBy }) {
        let rows = vehicles.filter((v) => {
          if (where.tenantId && v.tenantId !== where.tenantId) return false;
          if (where.homeLocationId && v.homeLocationId !== where.homeLocationId) return false;
          if (where.vehicleTypeId && v.vehicleType?.id !== where.vehicleTypeId) return false;
          return true;
        });
        if (Array.isArray(orderBy)) {
          rows = [...rows].sort((a, b) => (a.plate || '').localeCompare(b.plate || ''));
        }
        return rows;
      },
    },
    reservation: {
      async findMany({ where, select }) {
        const out = activeReservations.filter((r) => {
          if (where.tenantId && r.tenantId !== where.tenantId) return false;
          if (typeof where.status === 'string' && r.status !== where.status) return false;
          if (where.vehicleId?.not !== undefined && r.vehicleId == null) return false;
          return true;
        });
        if (!select) return out;
        return out.map((r) => ({ vehicleId: r.vehicleId }));
      },
    },
  };
}

let _idSeq = 0;
function veh({ id, status, type, tenantId = 't1', location = null, plate = null }) {
  const useId = id || `v${++_idSeq}`;
  return {
    id: useId,
    tenantId,
    status,
    plate: plate || `PL${useId}`,
    internalNumber: useId,
    year: 2024, make: 'Toyota', model: 'Camry', color: 'white', mileage: 12000,
    homeLocationId: location,
    vehicleType: typeof type === 'string' ? { id: type, code: type, name: type } : type,
    homeLocation: location ? { id: location, name: `Loc ${location}` } : null,
    reservations: [],
  };
}

// ---------------------------------------------------------------------------
// aggregateByType — pure
// ---------------------------------------------------------------------------

test('aggregateByType: empty input → empty array', () => {
  assert.deepEqual(aggregateByType([]), []);
});

test('aggregateByType: groups by vehicleType.id with full 5-status counts', () => {
  const out = aggregateByType([
    veh({ status: 'AVAILABLE',      type: 'SUV' }),
    veh({ status: 'AVAILABLE',      type: 'SUV' }),
    veh({ status: 'ON_RENT',        type: 'SUV' }),
    veh({ status: 'RESERVED',       type: 'ECO' }),
    veh({ status: 'IN_MAINTENANCE', type: 'ECO' }),
    veh({ status: 'OUT_OF_SERVICE', type: 'SUV' }),
  ]);
  const suv = out.find((t) => t.id === 'SUV');
  assert.equal(suv.capacity, 4);
  assert.equal(suv.counts.AVAILABLE, 2);
  assert.equal(suv.counts.ON_RENT, 1);
  assert.equal(suv.counts.OUT_OF_SERVICE, 1);
  assert.equal(suv.counts.RESERVED, 0);
  assert.equal(suv.counts.IN_MAINTENANCE, 0);

  const eco = out.find((t) => t.id === 'ECO');
  assert.equal(eco.capacity, 2);
  assert.equal(eco.counts.RESERVED, 1);
  assert.equal(eco.counts.IN_MAINTENANCE, 1);
});

test('aggregateByType: sorts by capacity desc', () => {
  const out = aggregateByType([
    veh({ status: 'AVAILABLE', type: 'A' }),
    veh({ status: 'AVAILABLE', type: 'B' }), veh({ status: 'AVAILABLE', type: 'B' }), veh({ status: 'AVAILABLE', type: 'B' }),
    veh({ status: 'AVAILABLE', type: 'C' }), veh({ status: 'AVAILABLE', type: 'C' }),
  ]);
  assert.deepEqual(out.map((t) => t.id), ['B', 'C', 'A']);
});

test('aggregateByType: vehicles without a vehicleType are skipped', () => {
  const out = aggregateByType([
    veh({ status: 'AVAILABLE', type: 'SUV' }),
    veh({ status: 'AVAILABLE', type: null }), // skipped
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].capacity, 1);
});

test('aggregateByType: unknown status folds into OUT_OF_SERVICE', () => {
  const out = aggregateByType([
    veh({ status: 'WEIRD_STATUS', type: 'SUV' }),
  ]);
  assert.equal(out[0].counts.OUT_OF_SERVICE, 1);
});

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

test('computeData rejects without tenantId', async () => {
  await assert.rejects(
    () => computeData({ query: {} }, {}),
    (err) => /tenantId/.test(err.message),
  );
});

test('computeData: returns full hybrid shape with totals + per-type rows', async () => {
  const prisma = makePrisma({ vehicles: [
    veh({ status: 'AVAILABLE',      type: 'SUV' }),
    veh({ status: 'AVAILABLE',      type: 'SUV' }),
    veh({ status: 'ON_RENT',        type: 'SUV' }),
    veh({ status: 'RESERVED',       type: 'ECO' }),
    veh({ status: 'IN_MAINTENANCE', type: 'ECO' }),
    veh({ status: 'OUT_OF_SERVICE', type: 'SUV' }),
  ] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma });

  assert.equal(out.totals.capacity, 6);
  assert.equal(out.totals.AVAILABLE, 2);
  assert.equal(out.totals.ON_RENT, 1);
  assert.equal(out.totals.RESERVED, 1);
  assert.equal(out.totals.IN_MAINTENANCE, 1);
  assert.equal(out.totals.OUT_OF_SERVICE, 1);
  // outOfServiceTotal = IN_MAINTENANCE + OUT_OF_SERVICE
  assert.equal(out.totals.outOfServiceTotal, 2);
  // availablePct = 2/6
  assert.ok(Math.abs(out.totals.availablePct - 2 / 6) < 0.001);

  assert.equal(out.types.length, 2);
  assert.deepEqual(out.statusOrder, VEHICLE_STATUSES);
});

test('computeData: location filter narrows by homeLocationId', async () => {
  const prisma = makePrisma({ vehicles: [
    veh({ status: 'AVAILABLE', type: 'SUV', location: 'L1' }),
    veh({ status: 'AVAILABLE', type: 'SUV', location: 'L1' }),
    veh({ status: 'AVAILABLE', type: 'SUV', location: 'L2' }),
  ] });
  const all = await computeData({ tenantId: 't1', query: {} }, { prisma });
  assert.equal(all.totals.capacity, 3);

  const onlyL1 = await computeData({ tenantId: 't1', query: { locationId: 'L1' } }, { prisma });
  assert.equal(onlyL1.totals.capacity, 2);
  assert.equal(onlyL1.filters.locationId, 'L1');
});

test('computeData: empty fleet returns sensible zeros', async () => {
  const prisma = makePrisma({ vehicles: [] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma });
  assert.equal(out.totals.capacity, 0);
  assert.equal(out.totals.availablePct, 0);
  assert.equal(out.totals.onRentPct, 0);
  assert.equal(out.types.length, 0);
});

// ---------------------------------------------------------------------------
// typeDrillDownHandler
// ---------------------------------------------------------------------------

test('typeDrillDownHandler: 400 when type missing', async () => {
  let statusCode = null, body = null;
  const r = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await typeDrillDownHandler({ query: {} }, r, { tenantId: 't1' });
  assert.equal(statusCode, 400);
  assert.match(body.error, /type query param/);
});

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

test('registerReport mounts the standard + /type routes for availability', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/availability'),       'data route');
  assert.ok(paths.has('/availability/pdf'),   'pdf route');
  assert.ok(paths.has('/availability/excel'), 'excel route');
  assert.ok(paths.has('/availability/type'),  '/type drill-down sub-route');
});
