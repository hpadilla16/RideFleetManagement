-- Advantage (TSD RezCentral) booking-source integration — per-tenant,
-- per-(TSD account, branch) location config (2026-07-16).
--
-- FIFTH autonomous booking-source (after TL → Economy → NU → Flexways).
-- ExternalReservation / ExternalSyncRun / IntegrationCredential /
-- AcrissCategoryMap are reused as-is (their sourceSystem is a free string →
-- 'ADVANTAGE'). The ONLY new table is AdvantageLocationConfig.
--
-- TSD RezCentral keys its report screen by TWO fields — lstTSDNumber (account,
-- 61302 = Advantage Orlando) and lstBranch (MCO) — and the grid echoes the pair
-- back in one cell (`Loc` = "61302.MCO"). So the unique is
-- (tenantId, tsdNumber, branch): a tenant maps N account/branch pairs → N Ride
-- locations. No hardcoded tenant/location — every mapping is data.
--
-- Additive + idempotent — CREATE TABLE IF NOT EXISTS / guarded FK, safe to re-run
-- and safe under the multi-worker boot-apply (startup-migrate) race. Migrate via
-- the SESSION port 5432, never pgbouncer.

-- 1. AdvantageLocationConfig table --------------------------------------------
CREATE TABLE IF NOT EXISTS "AdvantageLocationConfig" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "tsdNumber"     TEXT NOT NULL,
  "branch"        TEXT NOT NULL,
  "locationId"    TEXT NOT NULL,
  "enabled"       BOOLEAN NOT NULL DEFAULT true,
  "lookbackDays"  INTEGER,
  "lookaheadDays" INTEGER,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdvantageLocationConfig_pkey" PRIMARY KEY ("id")
);

-- 2. Unique (tenantId, tsdNumber, branch) — one row per portal account/branch --
CREATE UNIQUE INDEX IF NOT EXISTS "AdvantageLocationConfig_tenantId_tsdNumber_branch_key"
  ON "AdvantageLocationConfig" ("tenantId", "tsdNumber", "branch");

-- 3. Scheduler lookup index (enabled configs per tenant) ----------------------
CREATE INDEX IF NOT EXISTS "AdvantageLocationConfig_tenantId_enabled_idx"
  ON "AdvantageLocationConfig" ("tenantId", "enabled");

-- 4. FK to Tenant (guarded — ADD CONSTRAINT is not IF NOT EXISTS-able) --------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AdvantageLocationConfig_tenantId_fkey'
  ) THEN
    ALTER TABLE "AdvantageLocationConfig"
      ADD CONSTRAINT "AdvantageLocationConfig_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
