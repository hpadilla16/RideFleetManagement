import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RENTAL_PROGRAM_FILTER,
  LOANER_PROGRAM_FILTER,
  vehicleProgramWhereForScope,
  reservationProgramWhereForScope
} from './program-category.js';

// Per-employee program visibility (2026-07-02). The two *ForScope helpers map
// a resolved scope.programScope to Prisma where fragments; null/BOTH/unknown
// must be a spread no-op ({}) so admin/default users see zero behavior change.

// ── vehicleProgramWhereForScope ──────────────────────────────────────────────
test('vehicle fragment: RENTAL_ONLY → programCategory IN (RENTAL_ONLY, BOTH)', () => {
  assert.deepEqual(
    vehicleProgramWhereForScope({ programScope: 'RENTAL_ONLY' }),
    { programCategory: RENTAL_PROGRAM_FILTER }
  );
});

test('vehicle fragment: LOANER_ONLY → programCategory IN (LOANER_ONLY, BOTH)', () => {
  assert.deepEqual(
    vehicleProgramWhereForScope({ programScope: 'LOANER_ONLY' }),
    { programCategory: LOANER_PROGRAM_FILTER }
  );
});

test('vehicle fragment: null / missing / unknown scope → {} (no-op)', () => {
  assert.deepEqual(vehicleProgramWhereForScope({ programScope: null }), {});
  assert.deepEqual(vehicleProgramWhereForScope({}), {});
  assert.deepEqual(vehicleProgramWhereForScope(null), {});
  assert.deepEqual(vehicleProgramWhereForScope(undefined), {});
  // Raw 'BOTH' should never reach here (userProgramScope resolves it to null),
  // but if it does, it must also be a no-op.
  assert.deepEqual(vehicleProgramWhereForScope({ programScope: 'BOTH' }), {});
});

test('vehicle fragment composes with an existing where via spread', () => {
  const where = { tenantId: 't1', ...vehicleProgramWhereForScope({ programScope: 'LOANER_ONLY' }) };
  assert.deepEqual(where, { tenantId: 't1', programCategory: { in: ['LOANER_ONLY', 'BOTH'] } });
});

// ── reservationProgramWhereForScope ──────────────────────────────────────────
test('reservation fragment: LOANER_ONLY → workflowMode DEALERSHIP_LOANER only', () => {
  assert.deepEqual(
    reservationProgramWhereForScope({ programScope: 'LOANER_ONLY' }),
    { workflowMode: 'DEALERSHIP_LOANER' }
  );
});

test('reservation fragment: RENTAL_ONLY → NOT DEALERSHIP_LOANER (keeps RENTAL + CAR_SHARING)', () => {
  assert.deepEqual(
    reservationProgramWhereForScope({ programScope: 'RENTAL_ONLY' }),
    { NOT: { workflowMode: 'DEALERSHIP_LOANER' } }
  );
});

test('reservation fragment: null / missing / unknown scope → {} (no-op)', () => {
  assert.deepEqual(reservationProgramWhereForScope({ programScope: null }), {});
  assert.deepEqual(reservationProgramWhereForScope({}), {});
  assert.deepEqual(reservationProgramWhereForScope(null), {});
  assert.deepEqual(reservationProgramWhereForScope(undefined), {});
  assert.deepEqual(reservationProgramWhereForScope({ programScope: 'BOTH' }), {});
});

test('reservation fragment composes with an existing where via spread', () => {
  const where = { tenantId: 't1', ...reservationProgramWhereForScope({ programScope: 'RENTAL_ONLY' }) };
  assert.deepEqual(where, { tenantId: 't1', NOT: { workflowMode: 'DEALERSHIP_LOANER' } });
});

test('reservation fragment: RENTAL_ONLY composed over a loaner where yields a contradiction (empty set)', () => {
  // employee-app builds loanerWhere = { ...reservationScope, workflowMode: 'DEALERSHIP_LOANER' }.
  // For a RENTAL_ONLY user both keys survive and AND to zero rows — assert the
  // shape so a refactor can't silently drop one side of the contradiction.
  const where = {
    ...reservationProgramWhereForScope({ programScope: 'RENTAL_ONLY' }),
    workflowMode: 'DEALERSHIP_LOANER'
  };
  assert.deepEqual(where, { NOT: { workflowMode: 'DEALERSHIP_LOANER' }, workflowMode: 'DEALERSHIP_LOANER' });
});
