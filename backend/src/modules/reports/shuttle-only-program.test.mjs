/**
 * SHUTTLE_ONLY vehicle program category (2026-08-24).
 *
 * Dedicated shuttle units were polluting rental inventory numbers: they sat
 * in every utilization denominator, every availability count and every fleet
 * total while never being bookable (LOANER_ONLY already had the same
 * problem in the report denominators). This suite covers the pieces the
 * per-report suites don't:
 *
 *   - the enum value exists end-to-end (generated Prisma client + schema)
 *   - the migration is the single-statement shape the startup-migrate
 *     runner requires (ALTER TYPE ... ADD VALUE cannot run inside an
 *     explicit transaction block)
 *   - the optional programCategory allowlists accept SHUTTLE_ONLY
 *   - availability (right-now) and utilization exclude LOANER_ONLY +
 *     SHUTTLE_ONLY from their fleet bases (their legacy suites are
 *     grandfathered-unrun in npm-test-chain — this one IS chained)
 *
 * Run: npm run test:shuttle-only-program
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { _availabilitySnapshotInternal } from './availability.report.js';
import { _utilizationInternal } from './utilization.report.js';

const TZ = 'America/Puerto_Rico';

// ---------------------------------------------------------------------------
// Enum exists end-to-end
// ---------------------------------------------------------------------------

test('generated Prisma client exposes VehicleProgramCategory.SHUTTLE_ONLY', async () => {
  const { VehicleProgramCategory } = await import('@prisma/client');
  assert.equal(VehicleProgramCategory.SHUTTLE_ONLY, 'SHUTTLE_ONLY');
  // The two legacy sides are still there — the enum expanded, nothing renamed.
  assert.equal(VehicleProgramCategory.RENTAL_ONLY, 'RENTAL_ONLY');
  assert.equal(VehicleProgramCategory.LOANER_ONLY, 'LOANER_ONLY');
  assert.equal(VehicleProgramCategory.BOTH, 'BOTH');
});

test('schema.prisma declares SHUTTLE_ONLY inside VehicleProgramCategory', () => {
  const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');
  const m = schema.match(/enum VehicleProgramCategory \{([^}]*)\}/);
  assert.ok(m, 'VehicleProgramCategory enum missing from schema');
  const values = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(values, ['RENTAL_ONLY', 'LOANER_ONLY', 'BOTH', 'SHUTTLE_ONLY']);
});

// ---------------------------------------------------------------------------
// Migration shape — ADD VALUE cannot run in an explicit transaction
// ---------------------------------------------------------------------------

test('shuttle-only migration is a single idempotent ADD VALUE statement', () => {
  const sql = readFileSync(
    new URL('../../../prisma/migrations/20260824_shuttle_only_program/migration.sql', import.meta.url),
    'utf8',
  );
  const statements = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--') && l.trim())
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(statements.length, 1, 'must stay single-statement — ADD VALUE cannot share a multi-statement query safely');
  assert.match(statements[0], /^ALTER TYPE "VehicleProgramCategory" ADD VALUE IF NOT EXISTS 'SHUTTLE_ONLY'$/);
  assert.ok(!/\b(BEGIN|COMMIT|START TRANSACTION)\b/i.test(sql), 'no explicit transaction wrapper allowed around ADD VALUE');
});

// ---------------------------------------------------------------------------
// Optional programCategory allowlists accept the new value (source pins —
// reports.service and vehicles.routes use the module-level prisma, so their
// query paths aren't dependency-injectable from here)
// ---------------------------------------------------------------------------

test('reports.service.js user-facing programCategory allowlists accept SHUTTLE_ONLY (all 3 reports)', () => {
  const src = readFileSync(new URL('./reports.service.js', import.meta.url), 'utf8');
  const allowlists = src.match(/\['RENTAL_ONLY', 'LOANER_ONLY', 'BOTH'(?:, 'SHUTTLE_ONLY')?\]\.includes/g) || [];
  assert.equal(allowlists.length, 3, 'expected the vehicle-revenue, reservations and inventory allowlists');
  for (const a of allowlists) {
    assert.match(a, /'SHUTTLE_ONLY'/, `allowlist missing SHUTTLE_ONLY: ${a}`);
  }
});

test('vehicles bulk-program-category route accepts SHUTTLE_ONLY', () => {
  const src = readFileSync(new URL('../vehicles/vehicles.routes.js', import.meta.url), 'utf8');
  assert.match(src, /\['RENTAL_ONLY', 'LOANER_ONLY', 'BOTH', 'SHUTTLE_ONLY'\]\.includes\(programCategory\)/);
});

// ---------------------------------------------------------------------------
// Availability (right-now snapshot) — fleet base is the RENTAL fleet
// ---------------------------------------------------------------------------

function availVeh(id, programCategory, status = 'AVAILABLE') {
  return {
    id,
    tenantId: 't1',
    status,
    ...(programCategory ? { programCategory } : {}),
    plate: `PL-${id}`,
    internalNumber: id,
    homeLocationId: null,
    vehicleType: { id: 'T1', code: 'ECO', name: 'Economy' },
    homeLocation: null,
  };
}

function availabilityFakePrisma(vehicles) {
  return {
    vehicle: {
      async findMany({ where }) {
        return vehicles.filter((v) => {
          if (where.tenantId && v.tenantId !== where.tenantId) return false;
          if (where.status?.notIn && where.status.notIn.includes(v.status)) return false;
          if (where.programCategory?.in && !where.programCategory.in.includes(v.programCategory || 'BOTH')) return false;
          return true;
        });
      },
    },
    reservation: { async findMany() { return []; } },
  };
}

test('availability snapshot: LOANER_ONLY and SHUTTLE_ONLY units are not "available now"', async () => {
  const prisma = availabilityFakePrisma([
    availVeh('v-both', null),                 // BOTH (default)
    availVeh('v-rent', 'RENTAL_ONLY'),
    availVeh('v-loan', 'LOANER_ONLY'),
    availVeh('v-shut', 'SHUTTLE_ONLY'),
  ]);
  const out = await _availabilitySnapshotInternal.computeData(
    { tenantId: 't1', query: {} },
    { prisma, tenantTz: TZ, now: new Date('2026-08-24T16:00:00Z') },
  );
  assert.equal(out.totals.capacity, 2, 'fleet base = rentable units only');
  assert.equal(out.totals.AVAILABLE, 2, 'a dedicated shuttle must not sit in AVAILABLE forever');
});

// ---------------------------------------------------------------------------
// Utilization — the denominator is rentable capacity
// ---------------------------------------------------------------------------

function utilizationFakePrisma({ vehicles, reservations = [] }) {
  return {
    vehicleType: {
      async findMany({ where, select }) {
        const vehicleWhere = select?.vehicles?.where || {};
        const rows = [{ id: 'T1', code: 'ECO', name: 'Economy', tenantId: 't1' }];
        return rows
          .filter((vt) => !where?.tenantId || vt.tenantId === where.tenantId)
          .map((vt) => ({
            id: vt.id, code: vt.code, name: vt.name,
            vehicles: vehicles.filter((v) => {
              if (vehicleWhere.status?.notIn && vehicleWhere.status.notIn.includes(v.status)) return false;
              if (vehicleWhere.programCategory?.in && !vehicleWhere.programCategory.in.includes(v.programCategory || 'BOTH')) return false;
              return true;
            }).map((v) => ({ id: v.id })),
          }));
      },
    },
    reservation: { async findMany() { return reservations; } },
  };
}

test('utilization: LOANER_ONLY and SHUTTLE_ONLY units do not dilute the denominator', async () => {
  // 1 rentable unit rented for the full 2-day window + 1 loaner + 1 shuttle.
  // Before the filter this read ~33% utilization; the rentable fleet is
  // actually at 100%.
  const prisma = utilizationFakePrisma({
    vehicles: [
      { id: 'v-rent', status: 'AVAILABLE' },
      { id: 'v-loan', status: 'AVAILABLE', programCategory: 'LOANER_ONLY' },
      { id: 'v-shut', status: 'AVAILABLE', programCategory: 'SHUTTLE_ONLY' },
    ],
    reservations: [{
      id: 'r1', tenantId: 't1', status: 'CHECKED_OUT',
      vehicleTypeId: 'T1', vehicleId: 'v-rent',
      vehicle: { vehicleTypeId: 'T1' },
      pickupAt: new Date('2026-08-20T10:00:00Z'),
      returnAt: new Date('2026-08-23T10:00:00Z'),
    }],
  });
  const out = await _utilizationInternal.computeData(
    { tenantId: 't1', from: '2026-08-21', to: '2026-08-22', query: {} },
    { prisma, tenantTz: TZ, now: new Date('2026-08-24T16:00:00Z') },
  );
  assert.equal(out.fleet.capacity, 1, 'capacity = rentable units only');
  assert.ok(out.fleet.averageUtilization > 0.99, `averageUtilization=${out.fleet.averageUtilization} — expected 100% of the rentable fleet`);
});
