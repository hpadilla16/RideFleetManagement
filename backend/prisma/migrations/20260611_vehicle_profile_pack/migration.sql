-- Vehicle Profile pack (2026-06-10/11). Plan: doc/vehicle-profile-pack-plan-2026-06-10.md
-- (1) registration expiration tracker (+ document), (2) acquisition/value tracker
-- (declining-balance depreciation, computed — never stored), (3) fleet-rotation
-- targets (time-in-fleet months OR mileage; the per-tenant rule lives in AppSetting).
-- All informational — none of these columns feed billing.
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor. Migrate via the SESSION port 5432, never pgbouncer 6543.

ALTER TABLE "Vehicle"
  ADD COLUMN IF NOT EXISTS "registrationExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "registrationDocumentUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "acquisitionCost" DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "acquisitionDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "depreciationAnnualPct" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "targetFleetMonths" INTEGER,
  ADD COLUMN IF NOT EXISTS "targetFleetMiles" INTEGER;
