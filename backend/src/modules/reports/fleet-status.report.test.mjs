/**
 * Tests for fleet-status.report.js (Round 29).
 * Run: node --test backend/src/modules/reports/fleet-status.report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _fleetStatusInternal } from './fleet-status.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, projectVehicle, VEHICLE_STATUSES, STATUS_LABEL } = _fleetStatusInternal;

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

function makePrisma({ vehicles = [] } = {}) {
  return {
    vehicle: {
      async findMany({ where, select, orderBy }) {
        let rows = vehicles.filter((v) => {
          if (where.tenantId && v.tenantId !== where.tenantId) return false;
          if (where.homeLocationId && v.homeLocationId !== where.homeLocationId) return false;
          if (where.status && v.status !== where.status) return false;
          return true;
        });
        if (Array.isArray(orderBy)) {
          rows = [...rows].sort((a, b) => (a.plate || '').localeCompare(b.plate || ''));
        }
        // The two select shapes used by computeData: full row OR { id, status }
        if (select && select.id && select.status && !select.reservations) {
          return rows.map((v) => ({ id: v.id, status: v.status }));
        }
        return rows;
      },
    },
  };
}

let _idSeq = 0;
function veh({ id, status, type, location = null, plate = null, reservation = null, tenantId = 't1', mileage = 12000 }) {
  const useId = id || `v${++_idSeq}`;
  return {
    id: useId,
    tenantId,
    status,
    plate: plate || `PL${useId}`,
    internalNumber: useId,
    year: 2024, make: 'Toyota', model: 'Camry', color: 'white', mileage,
    homeLocationId: location,
    vehicleType: typeof type === 'string' ? { id: type, code: type, name: type } : type,
    homeLocation: location ? { id: location, name: `Loc ${location}` } : null,
    reservations: reservation ? [reservation] : [],
  };
}

// ---------------------------------------------------------------------------
// projectVehicle — pure
// ---------------------------------------------------------------------------

test('projectVehicle: builds label from year/make/model and derives statusLabel', () => {
  const out = projectVehicle(veh({ status: 'AVAILABLE', type: 'SUV' }));
  assert.equal(out.label, '2024 Toyota Camry');
  assert.equal(out.statusLabel, 'Available');
  assert.equal(out.currentReservation, null);
});

test('projectVehicle: surfaces active reservation when present', () => {
  const v = veh({
    status: 'ON_RENT',
    type: 'SUV',
    reservation: {
      id: 'rsv1',
      reservationNumber: 'R-1',
      status: 'CHECKED_OUT',
      returnAt: new Date('2026-05-30T15:00:00Z'),
      customer: { firstName: 'Maria', lastName: 'Lopez' },
    },
  });
  const out = projectVehicle(v);
  assert.equal(out.currentReservation.customerName, 'Maria Lopez');
  assert.equal(out.currentReservation.reservationNumber, 'R-1');
  assert.ok(out.currentReservation.returnLabel.includes('May 30'));
});

test('projectVehicle: handles missing optional fields gracefully', () => {
  const out = projectVehicle({
    id: 'v', tenantId: 't1', status: 'AVAILABLE',
    plate: null, internalNumber: 'v',
    year: null, make: null, model: null, color: null, mileage: 0,
    vehicleType: null, homeLocation: null, reservations: [],
  });
  assert.equal(out.label, null);
  assert.equal(out.vehicleType, null);
  assert.equal(out.homeLocation, null);
  assert.equal(out.mileage, 0);
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

test('computeData: returns flat list + totals', async () => {
  const prisma = makePrisma({ vehicles: [
    veh({ status: 'AVAILABLE',      type: 'SUV' }),
    veh({ status: 'ON_RENT',        type: 'SUV' }),
    veh({ status: 'IN_MAINTENANCE', type: 'ECO' }),
  ] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma });
  assert.equal(out.totalCount, 3);
  assert.equal(out.totals.capacity, 3);
  assert.equal(out.totals.AVAILABLE, 1);
  assert.equal(out.totals.ON_RENT, 1);
  assert.equal(out.totals.outOfServiceTotal, 1);
  assert.deepEqual(out.statusOrder, VEHICLE_STATUSES);
  assert.deepEqual(out.statusLabels, STATUS_LABEL);
});

test('computeData: status filter narrows the list but totals stay against full fleet', async () => {
  const prisma = makePrisma({ vehicles: [
    veh({ status: 'AVAILABLE', type: 'SUV' }),
    veh({ status: 'AVAILABLE', type: 'SUV' }),
    veh({ status: 'ON_RENT',   type: 'SUV' }),
    veh({ status: 'ON_RENT',   type: 'SUV' }),
    veh({ status: 'ON_RENT',   type: 'SUV' }),
  ] });
  const out = await computeData({ tenantId: 't1', query: { status: 'ON_RENT' } }, { prisma });
  assert.equal(out.totalCount, 3);                 // filtered list
  assert.equal(out.totals.capacity, 5);            // full fleet
  assert.equal(out.totals.AVAILABLE, 2);
  assert.equal(out.totals.ON_RENT, 3);
  assert.equal(out.filters.status, 'ON_RENT');
});

test('computeData: ignores unknown status filter value', async () => {
  const prisma = makePrisma({ vehicles: [
    veh({ status: 'AVAILABLE', type: 'SUV' }),
    veh({ status: 'ON_RENT',   type: 'SUV' }),
  ] });
  const out = await computeData({ tenantId: 't1', query: { status: 'NOT_A_STATUS' } }, { prisma });
  // Falsy unknown → filter dropped, all vehicles returned
  assert.equal(out.totalCount, 2);
  assert.equal(out.filters.status, null);
});

test('computeData: location filter narrows vehicles AND totals scope', async () => {
  const prisma = makePrisma({ vehicles: [
    veh({ status: 'AVAILABLE', type: 'SUV', location: 'L1' }),
    veh({ status: 'AVAILABLE', type: 'SUV', location: 'L2' }),
    veh({ status: 'ON_RENT',   type: 'SUV', location: 'L1' }),
  ] });
  const out = await computeData({ tenantId: 't1', query: { locationId: 'L1' } }, { prisma });
  assert.equal(out.totalCount, 2);
  // Totals scoped to the location too
  assert.equal(out.totals.capacity, 2);
  assert.equal(out.totals.AVAILABLE, 1);
  assert.equal(out.totals.ON_RENT, 1);
});

test('computeData: empty fleet returns empty vehicles + zero totals', async () => {
  const prisma = makePrisma({ vehicles: [] });
  const out = await computeData({ tenantId: 't1', query: {} }, { prisma });
  assert.equal(out.totalCount, 0);
  assert.equal(out.totals.capacity, 0);
  assert.equal(out.vehicles.length, 0);
});

// ---------------------------------------------------------------------------
// Route mount — note: fleet-status has NO drill-down sub-route, just data/pdf/excel
// ---------------------------------------------------------------------------

test('registerReport mounts standard routes for fleet-status (no sub-routes)', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/fleet-status'),       'data route');
  assert.ok(paths.has('/fleet-status/pdf'),   'pdf route');
  assert.ok(paths.has('/fleet-status/excel'), 'excel route');
});
