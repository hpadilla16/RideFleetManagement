-- 2026-07-25 - local vs non-local renter deposit rule (MONEY).
--
-- WHY: locations (first: LAX / Corpusa) charge a different security deposit
-- and mileage allowance depending on whether the renter is local to the
-- branch (California licence or CA resident at LAX -> up to $2,000 deposit
-- and 150 mi/day; everyone else -> up to $1,000, unlimited mileage). The
-- rule's decision must be FROZEN per reservation so a later licence edit
-- never re-prices a decided reservation, and so check-in mileage billing
-- reads the same decision the deposit was based on.
--
-- WHAT: one nullable TEXT column on ReservationPricingSnapshot holding the
-- decision JSON (locality, basis, localStates, securityDepositAmount,
-- milesPerDay, unlimitedMileage, evaluatedAt). NULL = no rule ran.
--
-- Additive + idempotent (IF NOT EXISTS is REQUIRED: startup-migrate is
-- fail-open and retries a failed migration every boot, and multiple workers
-- race to apply it). A nullable ADD COLUMN with no default is metadata-only
-- in PG 11+, so this does not rewrite the table.
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

ALTER TABLE "ReservationPricingSnapshot"
  ADD COLUMN IF NOT EXISTS "securityDepositRuleJson" TEXT;
