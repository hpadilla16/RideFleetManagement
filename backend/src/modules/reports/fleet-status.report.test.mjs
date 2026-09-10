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
        // The two select shapes used by computeData. The reduced one mirrors
        // the REAL select field for field — when it did not carry
        // registrationExpiresAt, the KPI read undefined for every vehicle and
        // reported a fleet with no registrations at all while the rows below
        // were correct.
        if (select && select.id && select.status && !select.vehicleType) {
          return rows.map((v) => ({
            id: v.id,
            status: v.status,
            ...(select.registrationExpiresAt ? { registrationExpiresAt: v.registrationExpiresAt ?? null } : {}),
            reservations: v.reservations || [],
          }));
        }
        return rows;
      },
    },
  };
}

let _idSeq = 0;
function veh({ id, status, type, location = null, plate = null, reservation = null, tenantId = 't1', mileage = 12000, registrationExpiresAt = null }) {
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
    registrationExpiresAt: registrationExpiresAt ?? null,
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

// ---------------------------------------------------------------------------
// Registration expiry (2026-09-09, Hector: "can we add registration
// expiration date").
//
// The date alone is a column nobody reads. What the report has to answer is
// which plates are already illegal to rent and which are about to be, so the
// cases that matter are the BOUNDARIES — today, and the edge of the warning
// window — and they are compared on whole days in the tenant's timezone.
// ---------------------------------------------------------------------------
const { registrationState, REGISTRATION_SOON_DAYS } = _fleetStatusInternal;

const AS_OF = new Date('2026-09-09T16:00:00Z');
const day = (n) => new Date(AS_OF.getTime() + n * 86400000);

test('registration: a date in the past is EXPIRED and says how long ago', () => {
  const r = registrationState(day(-5), AS_OF, 'UTC');
  assert.equal(r.state, 'EXPIRED');
  assert.equal(r.days, -5);
  assert.match(r.label, /Expired 5d ago/);
});

test('registration: expiring TODAY is expired, not still valid', () => {
  // A registration that lapses today is no good for the whole of today;
  // comparing raw instants would call it valid until the hour it was issued.
  const r = registrationState(new Date('2026-09-09T23:59:00Z'), AS_OF, 'UTC');
  assert.equal(r.state, 'EXPIRED');
  assert.equal(r.days, 0);
  assert.equal(r.label, 'Expires today');
});

test('registration: an hour EARLIER the same day is still today, not yesterday', () => {
  const r = registrationState(new Date('2026-09-09T01:00:00Z'), AS_OF, 'UTC');
  assert.equal(r.days, 0, 'whole days, not elapsed hours');
});

test('registration: the warning window is inclusive at its edge', () => {
  assert.equal(registrationState(day(REGISTRATION_SOON_DAYS), AS_OF, 'UTC').state, 'SOON');
  assert.equal(registrationState(day(REGISTRATION_SOON_DAYS + 1), AS_OF, 'UTC').state, 'OK');
  assert.equal(registrationState(day(1), AS_OF, 'UTC').label, '1d left');
});

test('registration: a far date is OK and shows the plain date', () => {
  const r = registrationState(new Date('2027-06-30T00:00:00Z'), AS_OF, 'UTC');
  assert.equal(r.state, 'OK');
  assert.equal(r.label, '2027-06-30');
  assert.equal(r.iso, '2027-06-30');
});

// ---------------------------------------------------------------------------
// The stored value is a DATE, not an instant (2026-09-10).
//
// Loading Rent & Go's 92 marbetes off their TSD License Expiration Report
// turned this up: all 128 registration rows in production sit at MIDNIGHT UTC,
// and Puerto Rico is UTC-4. Localizing that instant landed on the previous
// day, so every countdown was one day short while the printed date was right
// — a plate expiring today read "Expired 1d ago". Every test above passes
// tz='UTC', which is precisely where the bug cannot show.
// ---------------------------------------------------------------------------
const PR = 'America/Puerto_Rico';

test('registration: midnight UTC is that DAY in Puerto Rico, not the day before', () => {
  // 2026-10-31T00:00 UTC is 2026-10-30 20:00 in PR. The plate is valid through
  // the 31st, and the report used to say 50 days when the answer is 51.
  const r = registrationState(new Date('2026-10-31T00:00:00.000Z'), AS_OF, PR);
  assert.equal(r.iso, '2026-10-31');
  assert.equal(r.days, 52, 'whole days from 2026-09-09 to 2026-10-31');
  assert.equal(r.state, 'OK');
});

test('registration: the label and the countdown can never disagree', () => {
  // The shape of the old bug: the date printed 2026-10-31 while the countdown
  // was measured from 2026-10-30. Whatever day `iso` names is the day the
  // count must be measured to, in every timezone.
  for (const tz of ['UTC', PR, 'America/New_York', 'America/Los_Angeles', 'Europe/London']) {
    for (const stored of ['2026-10-31T00:00:00.000Z', '2026-10-31T12:00:00.000Z', '2026-10-31T23:59:00.000Z']) {
      const r = registrationState(new Date(stored), AS_OF, tz);
      assert.equal(r.iso, '2026-10-31', `${tz} ${stored}`);
      assert.equal(r.days, 52, `${tz} ${stored} — same day, same count`);
    }
  }
});

test('registration: a plate expiring TODAY in PR is expired, not a day gone', () => {
  const r = registrationState(new Date('2026-09-09T00:00:00.000Z'), AS_OF, PR);
  assert.equal(r.days, 0);
  assert.equal(r.label, 'Expires today', 'used to read "Expired 1d ago"');
});

test('registration: yesterday is still one day ago in PR', () => {
  const r = registrationState(new Date('2026-09-08T00:00:00.000Z'), AS_OF, PR);
  assert.equal(r.days, -1);
  assert.match(r.label, /Expired 1d ago/);
});

test('registration: the SOON edge holds in PR, not just in UTC', () => {
  assert.equal(registrationState(new Date('2026-10-09T00:00:00.000Z'), AS_OF, PR).state, 'SOON', '30 days out');
  assert.equal(registrationState(new Date('2026-10-10T00:00:00.000Z'), AS_OF, PR).state, 'OK', '31 days out');
});

test('registration: MISSING is its own state — never quietly "OK"', () => {
  // Most of the fleet has no date recorded. Rendering that as valid would be
  // the report telling somebody a car is legal when nobody has checked.
  for (const bad of [null, undefined, '', 'not a date', new Date('nope')]) {
    const r = registrationState(bad, AS_OF, 'UTC');
    assert.equal(r.state, 'UNKNOWN', `${String(bad)} must not read as OK`);
    assert.equal(r.label, 'Not recorded');
    assert.equal(r.days, null);
  }
});

test('projectVehicle carries the registration state through', () => {
  const v = {
    id: 'v1', internalNumber: '101', plate: 'ABC123', status: 'AVAILABLE',
    mileage: 100, registrationExpiresAt: day(-1), reservations: [],
  };
  const out = projectVehicle(v, AS_OF, 'UTC');
  assert.equal(out.registration.state, 'EXPIRED');
});

test('projectVehicle without a registration date does not throw', () => {
  const out = projectVehicle(
    { id: 'v1', internalNumber: '1', status: 'AVAILABLE', mileage: 0, reservations: [] },
    AS_OF, 'UTC',
  );
  assert.equal(out.registration.state, 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// The KPI must agree with the rows.
//
// It did not, the first time this shipped: the registration counters read a
// field the whole-fleet query never selected, so a tenant with 21 expired
// plates showed "0 expired · 127 not recorded" above a table that listed all
// 21 correctly. A KPI that disagrees with the list under it is worse than no
// KPI, because it is the number somebody reads first.
// ---------------------------------------------------------------------------
test('registration KPIs agree with the rows, filtered or not', async () => {
  const past = new Date(Date.now() - 40 * 86400000);
  const soon = new Date(Date.now() + 10 * 86400000);
  const far  = new Date(Date.now() + 400 * 86400000);
  const prisma = makePrisma({
    vehicles: [
      veh({ status: 'AVAILABLE', type: 'CCAR', location: 'L1', registrationExpiresAt: past }),
      veh({ status: 'ON_RENT',   type: 'CCAR', location: 'L1', registrationExpiresAt: past }),
      veh({ status: 'AVAILABLE', type: 'ICAR', location: 'L2', registrationExpiresAt: soon }),
      veh({ status: 'AVAILABLE', type: 'ICAR', location: 'L2', registrationExpiresAt: far }),
      veh({ status: 'AVAILABLE', type: 'ICAR', location: 'L2' }),               // no date
      veh({ status: 'SOLD',      type: 'ICAR', location: 'L2', registrationExpiresAt: past }), // excluded
    ],
  });

  const all = await computeData({ tenantId: 't1', query: {} }, { prisma });
  assert.equal(all.totals.registrationExpired, 2, 'SOLD is not ours to register');
  assert.equal(all.totals.registrationExpiringSoon, 1);
  assert.equal(all.totals.registrationUnknown, 1);

  const rowsExpired = all.vehicles.filter((v) => v.registration.state === 'EXPIRED' && v.status !== 'SOLD').length;
  assert.equal(rowsExpired, all.totals.registrationExpired, 'the KPI and the table must not disagree');

  // A STATUS filter narrows the list but not the counters: an expired plate
  // does not stop being expired because somebody looked at "Available" only.
  const byStatus = await computeData({ tenantId: 't1', query: { status: 'AVAILABLE' } }, { prisma });
  assert.equal(byStatus.totals.registrationExpired, 2, 'the status filter must not move the KPI');
  assert.ok(byStatus.vehicles.length < all.vehicles.length, 'but the list itself IS filtered');

  // LOCATION is different, and deliberately so: it scopes which fleet the
  // report is about, so the counters follow it. Both expired plates are at L1,
  // so L2 legitimately reports none.
  const byLocation = await computeData({ tenantId: 't1', query: { locationId: 'L2' } }, { prisma });
  assert.equal(byLocation.totals.registrationExpired, 0);
  assert.equal(byLocation.totals.registrationExpiringSoon, 1);
  assert.equal(byLocation.totals.registrationUnknown, 1);
});
