/**
 * VehicleProgramCategory filter helpers.
 *
 * Triangle-style tenants need to partition their fleet into rental-only and
 * loaner-only pools. The Vehicle.programCategory enum (RENTAL_ONLY |
 * LOANER_ONLY | BOTH) implements that partition. These constants are the
 * canonical Prisma `where` filters for the two consumption sides:
 *
 *   - RENTAL_PROGRAM_FILTER → use in public rental search, rental
 *     availability counts, rental fleet reports. Excludes vehicles that
 *     are exclusively dedicated to a loaner program.
 *
 *   - LOANER_PROGRAM_FILTER → use in dealership-loaner intake, vehicle
 *     pickers for loaner workflows, loaner fleet reports. Excludes
 *     vehicles in the regular rental pool.
 *
 * The asymmetric `BOTH` value lands in both filters, so flexible vehicles
 * surface in either context. Default for new vehicles is `BOTH` (set in
 * the Prisma schema), so existing tenants without a loaner program see
 * zero behavior change until they explicitly tag a vehicle.
 *
 * Always import from here rather than hardcoding the array — keeps the
 * filter consistent across services and gives us one place to update if
 * the enum ever expands (e.g. a future SUBSCRIPTION_ONLY category).
 */

export const RENTAL_PROGRAM_FILTER = { in: ['RENTAL_ONLY', 'BOTH'] };
export const LOANER_PROGRAM_FILTER = { in: ['LOANER_ONLY', 'BOTH'] };

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
