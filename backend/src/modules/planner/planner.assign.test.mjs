/**
 * DB-backed tests for the planner board backend (2026-07-14 reimagining).
 * Requires DATABASE_URL.
 *
 * Covers:
 *  - plannerActionsService.assignVehicle — the transactional single-assignment
 *    path (POST /api/planner/assign) that replaces the frontend's direct
 *    PATCH /api/reservations/:id drag-drop: happy path, OCCUPIED conflict,
 *    TURNAROUND buffer conflict (PlannerRuleSet.minTurnaroundMinutes),
 *    CHECKED_OUT lock, TYPE_MISMATCH + force override, unassign, audit rows.
 *  - plannerRecommendationService.suggestForReservation — ranked, reasoned,
 *    read-only (no PlannerScenario persisted), capped at 5.
 *  - plannerService.getSnapshot counters — the 5 header KPIs
 *    (unassignedCount, overbookedCount, pickupsToday, returnsToday,
 *    shortageToday) without dropping the legacy counters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { plannerActionsService } from './planner.actions.service.js';
import { plannerRecommendationService } from './planner.recommendation.service.js';
import { plannerService } from './planner.service.js';

const prisma = new PrismaClient();
const TAG = `PLA-${Date.now()}`;

const ids = {
  tenant: null,
  location: null,
  vtA: null,
  vtB: null,
  vtC: null,
  v1: null,
  v2: null,
  v3: null,
  v4: null,
  customer: null,
  reservations: []
};

function day(offsetDays, hour = 10, minute = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setHours(hour, minute, 0, 0);
  return date;
}

test.after(async () => {
  if (ids.reservations.length) {
    await prisma.auditLog.deleteMany({ where: { reservationId: { in: ids.reservations } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { id: { in: ids.reservations } } }).catch(() => {});
  }
  if (ids.tenant) await prisma.plannerScenario.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  for (const key of ['v1', 'v2', 'v3', 'v4', 'v5']) {
    if (ids[key]) await prisma.vehicle.delete({ where: { id: ids[key] } }).catch(() => {});
  }
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  for (const key of ['vtA', 'vtB', 'vtC']) {
    if (ids[key]) await prisma.vehicleType.delete({ where: { id: ids[key] } }).catch(() => {});
  }
  if (ids.tenant) await prisma.plannerRuleSet.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.location2) await prisma.location.delete({ where: { id: ids.location2 } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

async function createReservation(data) {
  const row = await prisma.reservation.create({ data });
  ids.reservations.push(row.id);
  return row;
}

const res = {};
let scope = null;

test('setup', async () => {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = t.id;
  scope = { tenantId: t.id };
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: t.id } });
  ids.location = loc.id;
  const vtA = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `A-${TAG}`.slice(0, 10), name: 'SUV' } });
  ids.vtA = vtA.id;
  const vtB = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `B-${TAG}`.slice(0, 10), name: 'Sedan' } });
  ids.vtB = vtB.id;
  const vtC = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `C-${TAG}`.slice(0, 10), name: 'Van' } });
  ids.vtC = vtC.id;
  await prisma.plannerRuleSet.create({
    data: {
      tenantId: t.id,
      minTurnaroundMinutes: 60,
      strictVehicleTypeMatch: true,
      allowCrossLocationReassignment: false
    }
  });
  const mkVehicle = async (key, n, vehicleTypeId) => {
    const row = await prisma.vehicle.create({
      data: {
        tenantId: t.id,
        internalNumber: `${n}-${TAG}`.slice(0, 18),
        plate: `${n}${TAG.slice(-6)}`,
        status: 'AVAILABLE',
        vehicleTypeId,
        homeLocationId: loc.id
      }
    });
    ids[key] = row.id;
  };
  await mkVehicle('v1', 'V1', vtA.id);
  await mkVehicle('v2', 'V2', vtA.id);
  await mkVehicle('v3', 'V3', vtA.id);
  await mkVehicle('v4', 'V4', vtB.id);
  const cust = await prisma.customer.create({ data: { firstName: 'Board', lastName: 'Planner', phone: '7875550188', email: `c-${TAG}@x.com`, tenantId: t.id } });
  ids.customer = cust.id;

  const base = {
    tenantId: t.id,
    customerId: cust.id,
    pickupLocationId: loc.id,
    returnLocationId: loc.id,
    dailyRate: 0
  };
  // Target of the assign tests: unassigned NEW, +10d 10:00 → +12d 10:00.
  res.r1 = await createReservation({ ...base, reservationNumber: `R1-${TAG}`, vehicleTypeId: vtA.id, status: 'NEW', pickupAt: day(10, 10), returnAt: day(12, 10) });
  // Occupies V1 across R1's window → OCCUPIED.
  res.r2 = await createReservation({ ...base, reservationNumber: `R2-${TAG}`, vehicleTypeId: vtA.id, vehicleId: ids.v1, status: 'CONFIRMED', pickupAt: day(10, 9), returnAt: day(11, 9) });
  // Returns V2 30 min before R1's pickup — clear raw window, but inside the
  // 60-minute turnaround buffer → TURNAROUND.
  res.r3 = await createReservation({ ...base, reservationNumber: `R3-${TAG}`, vehicleTypeId: vtA.id, vehicleId: ids.v2, status: 'CONFIRMED', pickupAt: day(9, 10), returnAt: day(10, 9, 30) });
  // Locked by check-out.
  res.r4 = await createReservation({ ...base, reservationNumber: `R4-${TAG}`, vehicleTypeId: vtA.id, status: 'CHECKED_OUT', pickupAt: day(10, 10), returnAt: day(12, 10) });
  // Suggest target in a far, clean window.
  res.r5 = await createReservation({ ...base, reservationNumber: `R5-${TAG}`, vehicleTypeId: vtA.id, status: 'NEW', pickupAt: day(20, 10), returnAt: day(21, 10) });
  // Counters fixture: a vt-C (no supply) reservation picking up TODAY and
  // spanning past midnight → pickupsToday, unassignedCount, overbookedCount
  // and shortageToday all light up.
  res.r6 = await createReservation({ ...base, reservationNumber: `R6-${TAG}`, vehicleTypeId: vtC.id, status: 'CONFIRMED', pickupAt: day(0, 12), returnAt: day(3, 12) });
  assert.ok(scope.tenantId);
});

test('assign 409s with OCCUPIED when the target vehicle has an overlapping reservation', async () => {
  await assert.rejects(
    plannerActionsService.assignVehicle({ reservationId: res.r1.id, vehicleId: ids.v1, scope }),
    (error) => {
      assert.equal(error.plannerConflictCode, 'OCCUPIED');
      assert.match(error.message, /Vehicle conflict with reservation/);
      return true;
    }
  );
  const row = await prisma.reservation.findUnique({ where: { id: res.r1.id }, select: { vehicleId: true } });
  assert.equal(row.vehicleId, null, 'conflict must not write');
});

test('assign 409s with TURNAROUND when only the turnaround buffer is violated', async () => {
  await assert.rejects(
    plannerActionsService.assignVehicle({ reservationId: res.r1.id, vehicleId: ids.v2, scope }),
    (error) => {
      assert.equal(error.plannerConflictCode, 'TURNAROUND');
      assert.match(error.message, /60-minute turnaround buffer/);
      return true;
    }
  );
});

test('assign happy path writes vehicleId + PLANNER_ASSIGN audit row', async () => {
  const out = await plannerActionsService.assignVehicle({ reservationId: res.r1.id, vehicleId: ids.v3, scope, actorUserId: null });
  assert.equal(out.ok, true);
  assert.equal(out.conflict, null);
  assert.deepEqual(out.reservation, { id: res.r1.id, vehicleId: ids.v3 });
  const row = await prisma.reservation.findUnique({ where: { id: res.r1.id }, select: { vehicleId: true } });
  assert.equal(row.vehicleId, ids.v3);
  const audit = await prisma.auditLog.findFirst({
    where: { reservationId: res.r1.id, reason: 'Planner board assignment' },
    orderBy: { createdAt: 'desc' }
  });
  assert.ok(audit, 'audit row written');
  const metadata = JSON.parse(audit.metadata);
  assert.equal(metadata.action, 'PLANNER_ASSIGN');
  assert.equal(metadata.previousVehicleId, null);
  assert.equal(metadata.nextVehicleId, ids.v3);
});

test('assign rejects a CHECKED_OUT reservation with LOCKED_STATUS', async () => {
  await assert.rejects(
    plannerActionsService.assignVehicle({ reservationId: res.r4.id, vehicleId: ids.v3, scope }),
    (error) => {
      assert.equal(error.plannerConflictCode, 'LOCKED_STATUS');
      assert.match(error.message, /locked by check-out/);
      return true;
    }
  );
});

test('strict type mismatch 409s with TYPE_MISMATCH and force:true overrides it', async () => {
  await assert.rejects(
    plannerActionsService.assignVehicle({ reservationId: res.r1.id, vehicleId: ids.v4, scope }),
    (error) => {
      assert.equal(error.plannerConflictCode, 'TYPE_MISMATCH');
      return true;
    }
  );
  const out = await plannerActionsService.assignVehicle({ reservationId: res.r1.id, vehicleId: ids.v4, force: true, scope });
  assert.equal(out.ok, true);
  assert.equal(out.reservation.vehicleId, ids.v4);
});

test('cross-location 409s with CROSS_LOCATION and force:true overrides it (Innovation 2026-07-14)', async () => {
  // Vehicle homed at a DIFFERENT location, same class (isolates the location rule).
  const loc2 = await prisma.location.create({
    data: { code: `L2-${TAG}`.slice(0, 12), name: 'Elsewhere', tenantId: ids.tenant }
  });
  ids.location2 = loc2.id;
  const v5 = await prisma.vehicle.create({
    data: {
      tenantId: ids.tenant,
      internalNumber: `V5-${TAG}`.slice(0, 18),
      plate: `V5${TAG.slice(-6)}`,
      status: 'AVAILABLE',
      vehicleTypeId: ids.vtA,
      homeLocationId: loc2.id
    }
  });
  ids.v5 = v5.id;

  await assert.rejects(
    plannerActionsService.assignVehicle({ reservationId: res.r1.id, vehicleId: ids.v5, scope }),
    (error) => {
      assert.equal(error.plannerConflictCode, 'CROSS_LOCATION');
      return true;
    }
  );
  const out = await plannerActionsService.assignVehicle({ reservationId: res.r1.id, vehicleId: ids.v5, force: true, scope });
  assert.equal(out.ok, true);
  assert.equal(out.reservation.vehicleId, ids.v5);
});

test('force never bypasses occupancy conflicts', async () => {
  await assert.rejects(
    plannerActionsService.assignVehicle({ reservationId: res.r1.id, vehicleId: ids.v1, force: true, scope }),
    (error) => {
      assert.equal(error.plannerConflictCode, 'OCCUPIED');
      return true;
    }
  );
});

test('assign with vehicleId null unassigns', async () => {
  const out = await plannerActionsService.assignVehicle({ reservationId: res.r1.id, vehicleId: null, scope });
  assert.equal(out.ok, true);
  assert.equal(out.reservation.vehicleId, null);
  const row = await prisma.reservation.findUnique({ where: { id: res.r1.id }, select: { vehicleId: true } });
  assert.equal(row.vehicleId, null);
  const audit = await prisma.auditLog.findFirst({
    where: { reservationId: res.r1.id, reason: 'Planner board assignment' },
    orderBy: { createdAt: 'desc' }
  });
  const metadata = JSON.parse(audit.metadata);
  // r1's last assignment was the forced cross-location move onto v5.
  assert.equal(metadata.previousVehicleId, ids.v5);
  assert.equal(metadata.nextVehicleId, null);
});

test('suggest returns a ranked, reasoned list capped at 5 and persists no scenario', async () => {
  const out = await plannerRecommendationService.suggestForReservation({ reservationId: res.r5.id }, scope);
  assert.equal(out.reservationId, res.r5.id);
  assert.ok(Array.isArray(out.suggestions));
  assert.ok(out.suggestions.length >= 1 && out.suggestions.length <= 5);
  const typeAVehicles = new Set([ids.v1, ids.v2, ids.v3]);
  out.suggestions.forEach((suggestion) => {
    assert.ok(typeAVehicles.has(suggestion.vehicleId), 'strict type match excludes vt-B vehicles');
    assert.equal(typeof suggestion.score, 'number');
    assert.ok(typeof suggestion.label === 'string' && suggestion.label.length > 0);
    assert.ok('plate' in suggestion);
    assert.ok(Array.isArray(suggestion.reasons) && suggestion.reasons.length > 0);
  });
  for (let index = 1; index < out.suggestions.length; index += 1) {
    assert.ok(out.suggestions[index - 1].score >= out.suggestions[index].score, 'sorted by score desc');
  }
  const scenarios = await prisma.plannerScenario.count({ where: { tenantId: ids.tenant } });
  assert.equal(scenarios, 0, 'suggest is read-only — no PlannerScenario persisted');
});

test('snapshot counters include the 5 board KPIs without dropping legacy counters', async () => {
  const snapshot = await plannerService.getSnapshot({ start: new Date(), end: day(7, 0) }, scope);
  const counters = snapshot.counters;
  // New KPIs.
  assert.ok(counters.unassignedCount >= 1, `unassignedCount (got ${counters.unassignedCount})`);
  assert.ok(counters.overbookedCount >= 1, `overbookedCount (got ${counters.overbookedCount})`);
  assert.ok(counters.pickupsToday >= 1, `pickupsToday (got ${counters.pickupsToday})`);
  assert.equal(typeof counters.returnsToday, 'number');
  assert.ok(counters.shortageToday, 'shortageToday present');
  assert.equal(counters.shortageToday.count, 1);
  assert.equal(counters.shortageToday.vehicleTypeId, ids.vtC);
  assert.equal(counters.shortageToday.vehicleType, 'Van');
  // Legacy counters the deployed UI still reads.
  for (const key of ['pickups', 'returns', 'checkedOut', 'serviceHolds', 'unassigned', 'overbooked']) {
    assert.ok(key in counters, `legacy counter ${key} preserved`);
  }
});
