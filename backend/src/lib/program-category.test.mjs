import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RENTAL_PROGRAM_FILTER,
  LOANER_PROGRAM_FILTER,
  SHUTTLE_PROGRAM_FILTER,
  shuttleProgramWhere,
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

// ── SHUTTLE_ONLY (2026-08-24) ────────────────────────────────────────────────
// Dedicated shuttle units belong to NEITHER consumption side. The filters are
// `in:` allowlists, so exclusion is automatic — these tests pin that fact so a
// future refactor to a notIn/denylist shape can't silently re-include them.

test('SHUTTLE_ONLY is excluded from BOTH the rental and the loaner filter', () => {
  assert.ok(!RENTAL_PROGRAM_FILTER.in.includes('SHUTTLE_ONLY'),
    'a dedicated shuttle must never be rentable inventory');
  assert.ok(!LOANER_PROGRAM_FILTER.in.includes('SHUTTLE_ONLY'),
    'a dedicated shuttle must never be a loaner-pool candidate');
});

test('rental/loaner filters stay allowlists (in:) — the shape the exclusion relies on', () => {
  assert.deepEqual(RENTAL_PROGRAM_FILTER, { in: ['RENTAL_ONLY', 'BOTH'] });
  assert.deepEqual(LOANER_PROGRAM_FILTER, { in: ['LOANER_ONLY', 'BOTH'] });
});

test('SHUTTLE_PROGRAM_FILTER is dedicated units only (no BOTH — dual-use stays rental-side)', () => {
  assert.deepEqual(SHUTTLE_PROGRAM_FILTER, { in: ['SHUTTLE_ONLY'] });
  assert.deepEqual(shuttleProgramWhere(), { programCategory: { in: ['SHUTTLE_ONLY'] } });
});

test('booking-engine search still consumes the canonical rental filter (source pin)', () => {
  // rentalAvailabilityCount is not dependency-injectable, so pin the source:
  // as long as the public-search vehicle query goes through
  // RENTAL_PROGRAM_FILTER, a SHUTTLE_ONLY unit can never surface as bookable
  // capacity. If this fails, the search filter was rewritten — re-verify the
  // shuttle exclusion there before touching this test.
  const src = readFileSync(new URL('../modules/booking-engine/booking-engine.service.js', import.meta.url), 'utf8');
  assert.match(src, /programCategory:\s*RENTAL_PROGRAM_FILTER/,
    'booking-engine.service.js no longer applies RENTAL_PROGRAM_FILTER to its vehicle query');
  assert.match(src, /import\s*\{[^}]*RENTAL_PROGRAM_FILTER[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/program-category\.js'/,
    'booking-engine.service.js must import the canonical filter, not hardcode the list');
});

test('loaner intake services still consume the canonical loaner filter (source pin)', () => {
  for (const rel of [
    '../modules/dealership-loaner/dealership-loaner.service.js',
    '../modules/dealership-loaner/public-loaner.service.js',
  ]) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(src, /programCategory:\s*LOANER_PROGRAM_FILTER/, `${rel} must use LOANER_PROGRAM_FILTER`);
  }
});
