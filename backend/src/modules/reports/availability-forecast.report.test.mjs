/**
 * Tests for availability-forecast.report.js (Round 26 Hybrid).
 * Run: node --test backend/src/modules/reports/availability-forecast.report.test.mjs
 *
 * Covers the new pieces added on top of Round 24d:
 *   - location filter (homeLocationId + pickupLocationId)
 *   - peakRisk callout list
 *   - computeBookingPace pure function
 *   - lastYear overlay (gated on data presence)
 *   - cellDrillDownHandler
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _availabilityInternal } from './availability-forecast.report.js';
import { reportsV2Router } from './reports-v2.routes.js';

const { computeData, computeBookingPace, cellDrillDownHandler, startOfDay, addDays, isoDay } = _availabilityInternal;

// ---------------------------------------------------------------------------
// Fake prisma helpers
// ---------------------------------------------------------------------------

function makePrisma({ vehicleTypes = [], reservations = [], throwOn = {} } = {}) {
  return {
    vehicleType: {
      async findMany({ where, select }) {
        if (throwOn.vehicleType) throw new Error('vehicleType throw');
        // Filter by tenantId
        let rows = vehicleTypes.filter((vt) => !where?.tenantId || vt.tenantId === where.tenantId);
        // Project vehicles sub-select (which carries the location filter)
        const vehicleWhere = select?.vehicles?.where || {};
        return rows.map((vt) => ({
          id: vt.id, code: vt.code, name: vt.name,
          vehicles: (vt.vehicles || []).filter((v) => {
            if (vehicleWhere.status?.not && v.status === vehicleWhere.status.not) return false;
            if (vehicleWhere.status?.notIn && vehicleWhere.status.notIn.includes(v.status)) return false;
            if (vehicleWhere.homeLocationId && v.homeLocationId !== vehicleWhere.homeLocationId) return false;
            return true;
          }).map((v) => ({ id: v.id })),
        }));
      },
      async findFirst({ where }) {
        return vehicleTypes.find((vt) => vt.id === where.id && vt.tenantId === where.tenantId) || null;
      },
    },
    reservation: {
      async findMany({ where }) {
        if (throwOn.reservation) throw new Error('reservation throw');
        return reservations.filter((r) => {
          if (where.tenantId && r.tenantId !== where.tenantId) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          if (where.pickupLocationId && r.pickupLocationId !== where.pickupLocationId) return false;
          if (where.vehicleTypeId?.not !== undefined && r.vehicleTypeId === where.vehicleTypeId.not) return false;
          if (typeof where.vehicleTypeId === 'string' && r.vehicleTypeId !== where.vehicleTypeId) return false;
          // Widened attribution clause: booked class OR assigned vehicle.
          if (Array.isArray(where.OR)) {
            const ok = where.OR.some((cond) => {
              if (cond.vehicleTypeId?.not === null) return r.vehicleTypeId != null;
              if (cond.vehicleId?.not === null) return r.vehicleId != null;
              return false;
            });
            if (!ok) return false;
          }
          if (where.pickupAt?.lt && new Date(r.pickupAt) >= where.pickupAt.lt) return false;
          if (where.returnAt?.gt && new Date(r.returnAt) <= where.returnAt.gt) return false;
          return true;
        }).map((r) => ({
          id: r.id,
          reservationNumber: r.reservationNumber || `RES-${r.id}`,
          status: r.status,
          pickupAt: r.pickupAt,
          returnAt: r.returnAt,
          createdAt: r.createdAt,
          vehicleTypeId: r.vehicleTypeId,
          vehicleId: r.vehicleId || null,
          customer: r.customer || null,
          vehicle: r.vehicle || null,
          pickupLocation: r.pickupLocation || null,
        }));
      },
    },
  };
}

// Build a vehicle type with N vehicles at a given location
function vt({ id, code, name, tenantId, capacity, location = null }) {
  const vehicles = [];
  for (let i = 0; i < capacity; i++) {
    vehicles.push({ id: `${id}-v${i}`, status: 'AVAILABLE', homeLocationId: location });
  }
  return { id, code, name, tenantId, vehicles };
}

// Build a confirmed reservation. `typeId` is the BOOKED class; pass
// `vehicleId` (+ `assignedTypeId`, defaults to typeId) to simulate an
// assigned unit — that's what drives the assigned-vehicle type attribution.
function res({ id, typeId, tenantId, pickup, ret, location = null, status = 'CONFIRMED', created = null, vehicleId = null, assignedTypeId = null }) {
  return {
    id, tenantId, vehicleTypeId: typeId ?? null,
    status,
    pickupAt: new Date(pickup),
    returnAt: new Date(ret),
    createdAt: created ? new Date(created) : new Date(new Date(pickup).getTime() - 7 * 86400000),
    pickupLocationId: location,
    vehicleId,
    vehicle: vehicleId ? { vehicleTypeId: assignedTypeId ?? typeId ?? null } : null,
  };
}

// ---------------------------------------------------------------------------
// computeBookingPace — pure function
// ---------------------------------------------------------------------------

test('computeBookingPace: empty input returns zeros', () => {
  const out = computeBookingPace([], [new Date('2026-06-01')], 10);
  assert.equal(out.sampleSize, 0);
  assert.equal(out.pct.length, out.binsDaysOut.length);
  assert.ok(out.pct.every((v) => v === 0));
});

test('computeBookingPace: at lead 0, every booking counts', () => {
  // 1 day, capacity 4, 2 reservations covering the day
  const day = startOfDay(new Date('2026-06-01'));
  const reservations = [
    res({ id: 'a', typeId: 'T', tenantId: 't1', pickup: '2026-06-01', ret: '2026-06-02', created: '2026-05-25' }),
    res({ id: 'b', typeId: 'T', tenantId: 't1', pickup: '2026-06-01', ret: '2026-06-02', created: '2026-05-30' }),
  ];
  const out = computeBookingPace(reservations, [day], 4);
  // At T=0 (any lead time >= 0), all bookings count → 2/4 = 0.5
  assert.equal(out.pct[0], 0.5);
  // At T=7, only the one created 7 days out counts → 1/4 = 0.25
  assert.equal(out.pct[7], 0.25);
  // At T=20, none → 0
  assert.equal(out.pct[20], 0);
});

test('computeBookingPace: respects fleet capacity (averages over days)', () => {
  const days = [
    startOfDay(new Date('2026-06-01')),
    startOfDay(new Date('2026-06-02')),
  ];
  // 1 reservation spanning both days, capacity 10, lead 5
  const reservations = [
    res({ id: 'a', typeId: 'T', tenantId: 't1', pickup: '2026-06-01', ret: '2026-06-03', created: '2026-05-27' }),
  ];
  const out = computeBookingPace(reservations, days, 10);
  // Each day has 1 booking at lead >= 0 → 1/10 per day, avg = 0.1
  assert.equal(Math.round(out.pct[0] * 1000) / 1000, 0.1);
  // Lead 5: the reservation's lead is exactly 5 days from pickup (June 1 - May 27)
  // For day index 0 (June 1), pickup is June 1, lead = 5. At T=5: counted. → 1/10.
  // For day index 1 (June 2), pickup of the reservation is still June 1, so the
  // lead at day-of-pickup is still 5. The booking touches June 2 too. → counted.
  // So avg at T=5 should be 0.1 as well.
  assert.equal(Math.round(out.pct[5] * 1000) / 1000, 0.1);
});

// ---------------------------------------------------------------------------
// computeData smoke test — basic shape
// ---------------------------------------------------------------------------

test('computeData rejects without tenantId', async () => {
  await assert.rejects(
    () => computeData({ from: '2026-06-01', to: '2026-06-03' }, {}),
    (err) => /tenantId/.test(err.message),
  );
});

test('computeData returns shape with all hybrid sections', async () => {
  const prisma = makePrisma({
    vehicleTypes: [
      vt({ id: 'T1', code: 'ECO', name: 'Economy', tenantId: 't1', capacity: 4 }),
      vt({ id: 'T2', code: 'SUV', name: 'SUV',     tenantId: 't1', capacity: 2 }),
    ],
    reservations: [
      res({ id: 'a', typeId: 'T2', tenantId: 't1', pickup: '2026-06-02', ret: '2026-06-04' }),
      res({ id: 'b', typeId: 'T2', tenantId: 't1', pickup: '2026-06-02', ret: '2026-06-04' }),
    ],
  });
  const out = await computeData({
    tenantId: 't1', from: '2026-06-01', to: '2026-06-05', query: {},
  }, { prisma });

  // All sections present
  assert.ok(Array.isArray(out.days));
  assert.ok(out.fleet);
  assert.ok(Array.isArray(out.types));
  assert.ok(Array.isArray(out.peakRisk));
  assert.ok(out.bookingPace);
  // soldOutByMonth runs but returns empty (default monthsBack=12 — fake prisma has no historical reservations)
  assert.ok(Array.isArray(out.soldOutByMonth));
  assert.equal(out.lastYear, null);
  assert.equal(out.filters.locationId, null);

  // Capacity is summed across types
  assert.equal(out.fleet.capacity, 6);
});

test('computeData: peakRisk surfaces sold-out SUV days', async () => {
  const prisma = makePrisma({
    vehicleTypes: [
      vt({ id: 'T1', code: 'ECO', name: 'Economy', tenantId: 't1', capacity: 10 }),
      vt({ id: 'T2', code: 'SUV', name: 'SUV',     tenantId: 't1', capacity: 2 }),
    ],
    reservations: [
      // Both SUVs taken on June 2-3
      res({ id: 'a', typeId: 'T2', tenantId: 't1', pickup: '2026-06-02', ret: '2026-06-04' }),
      res({ id: 'b', typeId: 'T2', tenantId: 't1', pickup: '2026-06-02', ret: '2026-06-04' }),
    ],
  });
  const out = await computeData({
    tenantId: 't1', from: '2026-06-01', to: '2026-06-05', query: {},
  }, { prisma });

  // 2 days where SUV is at 0/2 (< 20%) — June 2 and June 3
  assert.equal(out.peakRisk.length, 2);
  assert.ok(out.peakRisk.every((pr) => pr.atRiskTypes.some((t) => t.code === 'SUV' && t.available === 0)));
});

test('computeData: location filter narrows capacity AND demand', async () => {
  const prisma = makePrisma({
    vehicleTypes: [{
      id: 'T1', code: 'ECO', name: 'Economy', tenantId: 't1',
      vehicles: [
        { id: 'v1', status: 'AVAILABLE', homeLocationId: 'L1' },
        { id: 'v2', status: 'AVAILABLE', homeLocationId: 'L1' },
        { id: 'v3', status: 'AVAILABLE', homeLocationId: 'L2' },
      ],
    }],
    // Mid-day pickup/return so the wall-clock day matches the tenant-TZ
    // bucket (computeData anchors days on PR midnight; '2026-06-01' alone
    // parses as UTC midnight which lands at 8 PM May 31 PR).
    reservations: [
      res({ id: 'r1', typeId: 'T1', tenantId: 't1', pickup: '2026-06-01T14:00:00Z', ret: '2026-06-02T14:00:00Z', location: 'L1' }),
      res({ id: 'r2', typeId: 'T1', tenantId: 't1', pickup: '2026-06-01T14:00:00Z', ret: '2026-06-02T14:00:00Z', location: 'L2' }),
    ],
  });

  const allLocs = await computeData({
    tenantId: 't1', from: '2026-06-01', to: '2026-06-01', query: {},
  }, { prisma });
  assert.equal(allLocs.fleet.capacity, 3);
  assert.equal(allLocs.fleet.reservedByDay[0], 2);

  const locL1 = await computeData({
    tenantId: 't1', from: '2026-06-01', to: '2026-06-01', query: { locationId: 'L1' },
  }, { prisma });
  assert.equal(locL1.fleet.capacity, 2); // only L1 vehicles
  assert.equal(locL1.fleet.reservedByDay[0], 1); // only L1 reservation
  assert.equal(locL1.filters.locationId, 'L1');
});

// ---------------------------------------------------------------------------
// 2026-07-02 regression — FJAR Wrangler bug (prod case)
//
// Reality: Wrangler capacity 3 = UNIT-025 IN_MAINTENANCE + UNIT-032
// CHECKED_OUT + UNIT-054 CHECKED_OUT → 0 available. The report said 2 because
// (a) capacity counted the unit in the shop and (b) TL-ZE40790963BA was
// booked under a different class but ASSIGNED Wrangler UNIT-032, and the
// grid grouped by booked class.
// ---------------------------------------------------------------------------

// Wrangler type with prod-like statuses; CAR is the booked class of the
// cross-class reservation. Mid-day pickup/return like the location test so
// wall-clock days match the tenant-TZ buckets.
function fjarFixture() {
  return {
    vehicleTypes: [
      {
        id: 'TW', code: 'WRANGLER', name: 'Jeep Wrangler', tenantId: 't1',
        vehicles: [
          { id: 'UNIT-025', status: 'IN_MAINTENANCE', homeLocationId: null },
          { id: 'UNIT-032', status: 'CHECKED_OUT',    homeLocationId: null },
          { id: 'UNIT-054', status: 'CHECKED_OUT',    homeLocationId: null },
        ],
      },
      vt({ id: 'TC', code: 'CAR', name: 'Compact Car', tenantId: 't1', capacity: 2 }),
    ],
    reservations: [
      // Booked under CAR class, but assigned Wrangler UNIT-032 → must count as Wrangler.
      res({ id: 'tl-963', typeId: 'TC', assignedTypeId: 'TW', vehicleId: 'UNIT-032', tenantId: 't1', status: 'CHECKED_OUT', pickup: '2026-07-01T14:00:00Z', ret: '2026-07-05T14:00:00Z' }),
      // Booked AND assigned Wrangler.
      res({ id: 'r-054', typeId: 'TW', vehicleId: 'UNIT-054', tenantId: 't1', status: 'CHECKED_OUT', pickup: '2026-07-01T14:00:00Z', ret: '2026-07-05T14:00:00Z' }),
    ],
  };
}

test('FJAR case: maintenance unit out of capacity + assigned-vehicle attribution → Wrangler 0 available', async () => {
  const prisma = makePrisma(fjarFixture());
  const out = await computeData({
    tenantId: 't1', from: '2026-07-02', to: '2026-07-02', query: {},
  }, { prisma });

  const wrangler = out.types.find((t) => t.id === 'TW');
  const car = out.types.find((t) => t.id === 'TC');

  // Root cause B: UNIT-025 (IN_MAINTENANCE) is not rentable capacity.
  assert.equal(wrangler.capacity, 2);
  // Root cause A: both checked-out units count as Wrangler demand, even the
  // one booked under the CAR class.
  assert.equal(wrangler.reservedByDay[0], 2);
  assert.equal(wrangler.availableByDay[0], 0);
  // The cross-class reservation must NOT also sit under its booked class.
  assert.equal(car.capacity, 2);
  assert.equal(car.reservedByDay[0], 0);
  assert.equal(car.availableByDay[0], 2);
  // Fleet totals line up: capacity 4 (2 Wrangler + 2 Car), 2 reserved.
  assert.equal(out.fleet.capacity, 4);
  assert.equal(out.fleet.reservedByDay[0], 2);
});

test('unassigned reservation still counts under its booked class', async () => {
  const fixture = fjarFixture();
  fixture.reservations = [
    res({ id: 'u1', typeId: 'TW', tenantId: 't1', pickup: '2026-07-02T14:00:00Z', ret: '2026-07-03T14:00:00Z' }),
  ];
  const prisma = makePrisma(fixture);
  const out = await computeData({
    tenantId: 't1', from: '2026-07-02', to: '2026-07-02', query: {},
  }, { prisma });
  const wrangler = out.types.find((t) => t.id === 'TW');
  const car = out.types.find((t) => t.id === 'TC');
  assert.equal(wrangler.reservedByDay[0], 1);
  assert.equal(car.reservedByDay[0], 0);
});

test('a single cross-class assigned reservation is never double-counted', async () => {
  const fixture = fjarFixture();
  fixture.reservations = [
    res({ id: 'x1', typeId: 'TC', assignedTypeId: 'TW', vehicleId: 'UNIT-032', tenantId: 't1', status: 'CHECKED_OUT', pickup: '2026-07-02T14:00:00Z', ret: '2026-07-03T14:00:00Z' }),
  ];
  const prisma = makePrisma(fixture);
  const out = await computeData({
    tenantId: 't1', from: '2026-07-02', to: '2026-07-02', query: {},
  }, { prisma });
  const wrangler = out.types.find((t) => t.id === 'TW');
  const car = out.types.find((t) => t.id === 'TC');
  // Attribution REPLACES the booked class: 1 total, under Wrangler only.
  assert.equal(wrangler.reservedByDay[0], 1);
  assert.equal(car.reservedByDay[0], 0);
  assert.equal(out.fleet.reservedByDay[0], 1);
});

test('assigned reservation with NULL booked class still counts (widened where)', async () => {
  const fixture = fjarFixture();
  fixture.reservations = [
    res({ id: 'n1', typeId: null, assignedTypeId: 'TW', vehicleId: 'UNIT-054', tenantId: 't1', status: 'CHECKED_OUT', pickup: '2026-07-02T14:00:00Z', ret: '2026-07-03T14:00:00Z' }),
  ];
  const prisma = makePrisma(fixture);
  const out = await computeData({
    tenantId: 't1', from: '2026-07-02', to: '2026-07-02', query: {},
  }, { prisma });
  const wrangler = out.types.find((t) => t.id === 'TW');
  assert.equal(wrangler.reservedByDay[0], 1);
});

test('computeData: lastYear is null unless compareLastYear=true', async () => {
  const prisma = makePrisma({
    vehicleTypes: [vt({ id: 'T1', code: 'ECO', name: 'Economy', tenantId: 't1', capacity: 5 })],
    reservations: [],
  });
  const skipLY = await computeData({
    tenantId: 't1', from: '2026-06-01', to: '2026-06-05', query: {},
  }, { prisma });
  assert.equal(skipLY.lastYear, null);

  const withLY = await computeData({
    tenantId: 't1', from: '2026-06-01', to: '2026-06-05', query: { compareLastYear: 'true' },
  }, { prisma });
  assert.ok(withLY.lastYear);
  assert.equal(withLY.lastYear.hasData, false); // no LY reservations in fixture
  assert.equal(withLY.lastYear.utilizationByDay, null);
});

test('computeData: lastYear hasData=true when LY reservations exist', async () => {
  const prisma = makePrisma({
    vehicleTypes: [vt({ id: 'T1', code: 'ECO', name: 'Economy', tenantId: 't1', capacity: 5 })],
    reservations: [
      // LY same window (~365 days back from June 1, 2026 = ~June 2, 2025)
      res({ id: 'ly1', typeId: 'T1', tenantId: 't1', pickup: '2025-06-02', ret: '2025-06-04', created: '2025-05-20' }),
    ],
  });
  const out = await computeData({
    tenantId: 't1', from: '2026-06-01', to: '2026-06-05', query: { compareLastYear: '1' },
  }, { prisma });
  assert.ok(out.lastYear);
  assert.equal(out.lastYear.hasData, true);
  assert.equal(out.lastYear.sampleSize, 1);
  assert.ok(Array.isArray(out.lastYear.utilizationByDay));
});

// ---------------------------------------------------------------------------
// cellDrillDownHandler
// ---------------------------------------------------------------------------

test('cellDrillDownHandler: 400 when type+day missing', async () => {
  const status = { code: null };
  const body = { json: null };
  const res = {
    status(c) { status.code = c; return this; },
    json(b) { body.json = b; return this; },
  };
  // We can't easily mock resolveDefaultPrisma from outside, so this also tests
  // the early-return path before prisma is touched.
  await cellDrillDownHandler({ query: {} }, res, { tenantId: 't1' });
  assert.equal(status.code, 400);
  assert.match(body.json.error, /type and day/);
});

test('cellDrillDownHandler: 400 when day is not a valid ISO date', async () => {
  const status = { code: null };
  const body = { json: null };
  const res = {
    status(c) { status.code = c; return this; },
    json(b) { body.json = b; return this; },
  };
  await cellDrillDownHandler({ query: { type: 'T1', day: 'not-a-date' } }, res, { tenantId: 't1' });
  assert.equal(status.code, 400);
  assert.match(body.json.error, /ISO date/);
});

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

test('addDays + isoDay round-trip', () => {
  const start = startOfDay(new Date('2026-06-01'));
  assert.equal(isoDay(addDays(start, 0)), '2026-06-01');
  assert.equal(isoDay(addDays(start, 7)), '2026-06-08');
});

// ---------------------------------------------------------------------------
// registerReport sub-route wiring — verifies importing this report module
// actually mounts /availability-forecast/cell on the shared router.
// ---------------------------------------------------------------------------

test('registerReport mounts the /cell sub-route on reportsV2Router', () => {
  const layers = reportsV2Router.stack || [];
  const cellRoute = layers.find((l) =>
    l.route && l.route.path === '/availability-forecast/cell'
  );
  assert.ok(cellRoute, '/availability-forecast/cell should be registered');
  // Should accept GET
  assert.ok(cellRoute.route.methods.get, '/cell should accept GET');
});

test('registerReport also mounts the standard data + pdf + excel routes', () => {
  const layers = reportsV2Router.stack || [];
  const paths = new Set(layers.filter((l) => l.route).map((l) => l.route.path));
  assert.ok(paths.has('/availability-forecast'),       'data route');
  assert.ok(paths.has('/availability-forecast/pdf'),   'pdf route');
  assert.ok(paths.has('/availability-forecast/excel'), 'excel route');
});
