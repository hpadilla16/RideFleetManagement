import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { reservationsService } from './reservations.service.js';

// Verifies that listPage:
//   1. Runs exactly TWO prisma calls (count + findMany), not the 5+ it ran
//      before this PR (count + findMany + 4 hydrateReservationListRows queries).
//   2. Returns rows with relations populated from the select (no separate
//      batch fetch path).
//   3. Surfaces the underage alert correctly using customer.dateOfBirth +
//      pickupLocation.locationConfig — both of which the previous select
//      did not expose, silently breaking the alert in list view.
//
// Approach: monkey-patch prisma.reservation.{count,findMany} to count calls
// and return canned rows. We assert no extra prisma.{customer,vehicle,...}
// findMany happens.

describe('reservationsService.listPage — query count + underage alert', () => {
  let countCalls;
  let findManyCalls;
  let extraFetchCalls;
  let origCount;
  let origFindMany;
  let origCustomerFindMany;
  let origVehicleFindMany;
  let origVehicleTypeFindMany;
  let origLocationFindMany;

  beforeEach(() => {
    countCalls = 0;
    findManyCalls = 0;
    extraFetchCalls = 0;
    origCount = prisma.reservation.count;
    origFindMany = prisma.reservation.findMany;
    origCustomerFindMany = prisma.customer.findMany;
    origVehicleFindMany = prisma.vehicle.findMany;
    origVehicleTypeFindMany = prisma.vehicleType.findMany;
    origLocationFindMany = prisma.location.findMany;

    prisma.reservation.count = async () => { countCalls += 1; return 1; };
    prisma.reservation.findMany = async () => {
      findManyCalls += 1;
      return [
        {
          id: 'res-1',
          tenantId: 'tenant-1',
          reservationNumber: 'R001',
          status: 'NEW',
          pickupAt: new Date('2026-05-01T10:00:00Z'),
          returnAt: new Date('2026-05-03T10:00:00Z'),
          pickupLocationId: 'loc-1',
          returnLocationId: 'loc-1',
          customerId: 'cust-1',
          vehicleId: null,
          vehicleTypeId: 'vt-1',
          customer: {
            id: 'cust-1',
            firstName: 'Test',
            lastName: 'Driver',
            email: 't@x.com',
            phone: '555',
            dateOfBirth: new Date('2008-01-01T00:00:00Z') // 18 yrs old on pickupAt
          },
          pickupLocation: {
            id: 'loc-1',
            name: 'Main',
            code: 'MAIN',
            // underageAlertEnabled w/ threshold 21
            locationConfig: JSON.stringify({ underageAlertEnabled: true, underageAlertAge: 21 })
          },
          returnLocation: { id: 'loc-1', name: 'Main', code: 'MAIN' },
          vehicleType: { id: 'vt-1', code: 'A', name: 'Compact' },
          vehicle: null,
          franchise: null,
          rentalAgreement: null
        }
      ];
    };

    // Track that NO extra batch fetch happens for relations
    prisma.customer.findMany = async () => { extraFetchCalls += 1; return []; };
    prisma.vehicle.findMany = async () => { extraFetchCalls += 1; return []; };
    prisma.vehicleType.findMany = async () => { extraFetchCalls += 1; return []; };
    prisma.location.findMany = async () => { extraFetchCalls += 1; return []; };
  });

  afterEach(() => {
    prisma.reservation.count = origCount;
    prisma.reservation.findMany = origFindMany;
    prisma.customer.findMany = origCustomerFindMany;
    prisma.vehicle.findMany = origVehicleFindMany;
    prisma.vehicleType.findMany = origVehicleTypeFindMany;
    prisma.location.findMany = origLocationFindMany;
  });

  it('runs exactly count + findMany (no redundant hydrate batch)', async () => {
    const out = await reservationsService.listPage({}, { tenantId: 'tenant-1' });
    assert.equal(countCalls, 1);
    assert.equal(findManyCalls, 1);
    assert.equal(extraFetchCalls, 0, 'no extra customer/vehicle/location fetch should fire');
    assert.equal(out.total, 1);
    assert.equal(out.rows.length, 1);
  });

  it('preserves relation shape from the select', async () => {
    const out = await reservationsService.listPage({}, { tenantId: 'tenant-1' });
    const row = out.rows[0];
    assert.equal(row.customer?.id, 'cust-1');
    assert.equal(row.pickupLocation?.code, 'MAIN');
    assert.equal(row.vehicleType?.name, 'Compact');
  });

  it('surfaces underageAlert=true when customer is below threshold', async () => {
    const out = await reservationsService.listPage({}, { tenantId: 'tenant-1' });
    const row = out.rows[0];
    assert.equal(row.underageAlert, true, 'expected underage alert to be true for 18yo with threshold 21');
    assert.equal(row.underageAlertAge, 18);
    assert.equal(row.underageAlertThreshold, 21);
    assert.match(row.underageAlertText || '', /UNDERAGE ALERT/);
  });
});

// Codex bot finding (PR #16): the previous hydrate function re-fetched
// vehicle / vehicleType / location with `where: { tenantId: scope.tenantId }`,
// nulling out any drifted cross-tenant relation. With hydrate gone, the
// nested findMany select follows raw FKs without scope-checking, so a
// drifted row could leak another tenant's record. maskCrossTenantRelations
// restores that defense in memory.
describe('reservationsService.listPage — cross-tenant relation masking', () => {
  let origCount;
  let origFindMany;
  let origCustomerFindMany;

  beforeEach(() => {
    origCount = prisma.reservation.count;
    origFindMany = prisma.reservation.findMany;
    origCustomerFindMany = prisma.customer.findMany;
    prisma.reservation.count = async () => 1;
    prisma.customer.findMany = async () => [];
  });

  afterEach(() => {
    prisma.reservation.count = origCount;
    prisma.reservation.findMany = origFindMany;
    prisma.customer.findMany = origCustomerFindMany;
  });

  function rowWithDrift({ vehicleTenant = 'tenant-1', vehicleTypeTenant = 'tenant-1', pickupTenant = 'tenant-1', returnTenant = 'tenant-1' } = {}) {
    return {
      id: 'res-1',
      tenantId: 'tenant-1',
      reservationNumber: 'R001',
      pickupAt: new Date('2026-05-01T10:00:00Z'),
      returnAt: new Date('2026-05-03T10:00:00Z'),
      pickupLocationId: 'loc-1',
      returnLocationId: 'loc-2',
      customerId: 'cust-1',
      vehicleId: 'veh-1',
      vehicleTypeId: 'vt-1',
      customer: { id: 'cust-1', firstName: 'A', lastName: 'B', dateOfBirth: null },
      vehicle: { id: 'veh-1', plate: 'X', tenantId: vehicleTenant },
      vehicleType: { id: 'vt-1', name: 'Compact', tenantId: vehicleTypeTenant },
      pickupLocation: { id: 'loc-1', name: 'L1', code: 'L1', locationConfig: null, tenantId: pickupTenant },
      returnLocation: { id: 'loc-2', name: 'L2', code: 'L2', tenantId: returnTenant },
      franchise: null,
      rentalAgreement: null
    };
  }

  it('nulls out a vehicle whose tenantId differs from the reservation', async () => {
    prisma.reservation.findMany = async () => [rowWithDrift({ vehicleTenant: 'OTHER-TENANT' })];
    const out = await reservationsService.listPage({}, { tenantId: 'tenant-1' });
    assert.equal(out.rows[0].vehicle, null, 'cross-tenant vehicle should be masked');
    assert.notEqual(out.rows[0].vehicleType, null);
    assert.notEqual(out.rows[0].pickupLocation, null);
    assert.notEqual(out.rows[0].returnLocation, null);
  });

  it('nulls out vehicleType / pickupLocation / returnLocation when they drift', async () => {
    prisma.reservation.findMany = async () => [
      rowWithDrift({ vehicleTypeTenant: 'OTHER', pickupTenant: 'OTHER', returnTenant: 'OTHER' })
    ];
    const out = await reservationsService.listPage({}, { tenantId: 'tenant-1' });
    const row = out.rows[0];
    assert.equal(row.vehicle?.id, 'veh-1', 'vehicle stays (its tenantId matches)');
    assert.equal(row.vehicleType, null);
    assert.equal(row.pickupLocation, null);
    assert.equal(row.returnLocation, null);
  });

  it('does not mask when scope has no tenantId (SUPER_ADMIN cross-tenant view)', async () => {
    prisma.reservation.findMany = async () => [rowWithDrift({ vehicleTenant: 'OTHER' })];
    const out = await reservationsService.listPage({}, {}); // empty scope
    assert.equal(out.rows[0].vehicle?.id, 'veh-1', 'unmasked in SUPER_ADMIN view');
  });

  it('does not mask when relation tenantId matches reservation tenantId', async () => {
    prisma.reservation.findMany = async () => [rowWithDrift()]; // all tenant-1
    const out = await reservationsService.listPage({}, { tenantId: 'tenant-1' });
    const row = out.rows[0];
    assert.equal(row.vehicle?.id, 'veh-1');
    assert.equal(row.vehicleType?.id, 'vt-1');
    assert.equal(row.pickupLocation?.id, 'loc-1');
    assert.equal(row.returnLocation?.id, 'loc-2');
  });
});
