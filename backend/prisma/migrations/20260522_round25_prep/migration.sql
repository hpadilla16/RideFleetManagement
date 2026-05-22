-- Round 25 prep — code/DB drift sync (2026-05-22)
--
-- Idempotent migration that backfills changes that were applied live to
-- production on 2026-05-21 during the v0.9.0-beta.69 smoke test but never
-- made it into the repo. Safe to re-run.
--
-- Changes:
--   1. Tenant.settingsJson : JSONB column for per-tenant operational settings
--                            (Dejavoo preAuthAmountCents, future per-tenant config).
--   2. FeeRate_feeType_check : add 'LATE_RETURN' to the allowed-values list.
--   3. FeeRate_unit_check    : add 'PER_HOUR'    to the allowed-values list.
--
-- Companion: doc/round-25-plan-2026-05-22.md

-- ============================================================================
-- 1. Tenant.settingsJson
-- ============================================================================
ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "settingsJson" JSONB DEFAULT '{}'::jsonb;

-- Backfill any existing NULLs so callers always get an object.
UPDATE "Tenant"
   SET "settingsJson" = '{}'::jsonb
 WHERE "settingsJson" IS NULL;

-- ============================================================================
-- 2. FeeRate_feeType_check — add LATE_RETURN
-- ============================================================================
ALTER TABLE "FeeRate" DROP CONSTRAINT IF EXISTS "FeeRate_feeType_check";

ALTER TABLE "FeeRate"
  ADD CONSTRAINT "FeeRate_feeType_check"
  CHECK ("feeType" IN (
    'FUEL_REFILL',
    'CLEANING_LIGHT',
    'CLEANING_MEDIUM',
    'CLEANING_HEAVY',
    'SMOKING',
    'EXCESS_MILEAGE',
    'LATE_RETURN'
  ));

-- ============================================================================
-- 3. FeeRate_unit_check — add PER_HOUR
-- ============================================================================
ALTER TABLE "FeeRate" DROP CONSTRAINT IF EXISTS "FeeRate_unit_check";

ALTER TABLE "FeeRate"
  ADD CONSTRAINT "FeeRate_unit_check"
  CHECK ("unit" IN (
    'FLAT',
    'PER_GALLON',
    'PER_MILE',
    'PER_HOUR'
  ));
