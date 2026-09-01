/**
 * VehicleProgramCategory filter helpers.
 *
 * Triangle-style tenants need to partition their fleet into rental-only and
 * loaner-only pools — and, since 2026-08-24, a dedicated-shuttle pool. The
 * Vehicle.programCategory enum (RENTAL_ONLY | LOANER_ONLY | BOTH |
 * SHUTTLE_ONLY) implements that partition. These constants are the
 * canonical Prisma `where` filters per consumption side:
 *
 *   - RENTAL_PROGRAM_FILTER → use in public rental search, rental
 *     availability counts, rental fleet reports. Excludes vehicles that
 *     are exclusively dedicated to a loaner program or to shuttle duty.
 *
 *   - LOANER_PROGRAM_FILTER → use in dealership-loaner intake, vehicle
 *     pickers for loaner workflows, loaner fleet reports. Excludes
 *     vehicles in the regular rental pool and dedicated shuttles.
 *
 *   - SHUTTLE_PROGRAM_FILTER → for future shuttle-side consumers
 *     (dedicated-shuttle rosters, shuttle fleet pickers). SHUTTLE_ONLY —
 *     the enum expansion this doc anticipated — marks vehicles that exist
 *     solely to move customers: they belong to NEITHER rental nor loaner
 *     inventory. Dual-use vehicles that merely also run shuttle duty keep
 *     RENTAL_ONLY/BOTH and get tracked as shuttles on the side, so they
 *     are deliberately NOT in this filter — dedicated units only.
 *
 * The asymmetric `BOTH` value lands in the rental and loaner filters, so
 * flexible vehicles surface in either of those contexts. Default for new
 * vehicles is `BOTH` (set in the Prisma schema), so existing tenants
 * without a loaner program see zero behavior change until they explicitly
 * tag a vehicle.
 *
 * Always import from here rather than hardcoding the array — keeps the
 * filter consistent across services and gives us one place to update if
 * the enum ever expands again (e.g. a future SUBSCRIPTION_ONLY category).
 * Every filter is an `in:` allowlist, so a newly added enum value is
 * automatically excluded from all existing sides until deliberately added.
 */

export const RENTAL_PROGRAM_FILTER = { in: ['RENTAL_ONLY', 'BOTH'] };
export const LOANER_PROGRAM_FILTER = { in: ['LOANER_ONLY', 'BOTH'] };
export const SHUTTLE_PROGRAM_FILTER = { in: ['SHUTTLE_ONLY'] };

// Convenience for Prisma `where` clauses that need to be sometimes-applied:
//   prisma.vehicle.findMany({ where: { ...rentalProgramWhere() } })
// vs always inlining `programCategory: { in: [...] }`. Pure stylistic — same
// shape either way.
export function rentalProgramWhere() {
  return { programCategory: RENTAL_PROGRAM_FILTER };
}

export function loanerProgramWhere() {
  return { programCategory: LOANER_PROGRAM_FILTER };
}

export function shuttleProgramWhere() {
  return { programCategory: SHUTTLE_PROGRAM_FILTER };
}

/**
 * Per-employee program visibility (2026-07-02). These map a resolved
 * scope.programScope (see userProgramScope in lib/tenant-scope.js —
 * 'RENTAL_ONLY' | 'LOANER_ONLY' | null) to Prisma `where` fragments, so
 * services can compose them exactly like the allowedLocationIds blocks:
 *
 *   where: { ...baseWhere, ...vehicleProgramWhereForScope(scope) }
 *
 * null / unknown scope → {} (spread no-op), so BOTH/admin users see zero
 * behavior change. Pure functions — unit-tested in program-category.test.mjs.
 */
export function vehicleProgramWhereForScope(scope) {
  const programScope = scope?.programScope;
  if (programScope === 'RENTAL_ONLY') return { programCategory: RENTAL_PROGRAM_FILTER };
  if (programScope === 'LOANER_ONLY') return { programCategory: LOANER_PROGRAM_FILTER };
  return {};
}

export function reservationProgramWhereForScope(scope) {
  const programScope = scope?.programScope;
  // Reservations partition on workflowMode. Rental side = everything that is
  // NOT a dealership loaner (RENTAL + CAR_SHARING + legacy null); loaner side
  // = DEALERSHIP_LOANER only.
  if (programScope === 'RENTAL_ONLY') return { NOT: { workflowMode: 'DEALERSHIP_LOANER' } };
  if (programScope === 'LOANER_ONLY') return { workflowMode: 'DEALERSHIP_LOANER' };
  return {};
}
