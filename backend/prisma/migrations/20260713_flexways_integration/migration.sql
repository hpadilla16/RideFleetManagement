-- Flexways (MobilityPS) booking-source integration — per-tenant, per-sede
-- location config (2026-07-13).
--
-- Third autonomous booking-source (after TL → Economy → NU). ExternalReservation
-- / ExternalSyncRun / IntegrationCredential / AcrissCategoryMap are reused as-is
-- (their sourceSystem is a free string → 'FLEXWAYS'). The ONLY new table is
-- FlexwaysLocationConfig.
--
-- Unlike NU (1:1 FLL), Flexways is MULTI-SEDE: inventory is keyed by `idSede`
-- (portal branch, e.g. "383"). A tenant maps N portal sedes → N Ride locations,
-- so the unique is (tenantId, idSede) — Economy's multi-row shape.
--
-- Additive + idempotent — CREATE TABLE IF NOT EXISTS / guarded FK, safe to re-run
-- and safe under the multi-worker boot-apply (startup-migrate) race. Migrate via
-- the SESSION port 5432, never pgbouncer.

-- 1. FlexwaysLocationConfig table --------------------------------------------
CREATE TABLE IF NOT EXISTS "FlexwaysLocationConfig" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "idSede"        TEXT NOT NULL,
  "locationId"    TEXT NOT NULL,
  "enabled"       BOOLEAN NOT NULL DEFAULT true,
  "lookbackDays"  INTEGER,
  "lookaheadDays" INTEGER,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FlexwaysLocationConfig_pkey" PRIMARY KEY ("id")
);

-- 2. Unique (tenantId, idSede) — one config row per portal sede per tenant -----
CREATE UNIQUE INDEX IF NOT EXISTS "FlexwaysLocationConfig_tenantId_idSede_key"
  ON "FlexwaysLocationConfig" ("tenantId", "idSede");

-- 3. Scheduler lookup index (enabled sedes per tenant) ------------------------
CREATE INDEX IF NOT EXISTS "FlexwaysLocationConfig_tenantId_enabled_idx"
  ON "FlexwaysLocationConfig" ("tenantId", "enabled");

-- 4. FK to Tenant (guarded — ADD CONSTRAINT is not IF NOT EXISTS-able) --------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FlexwaysLocationConfig_tenantId_fkey'
  ) THEN
    ALTER TABLE "FlexwaysLocationConfig"
      ADD CONSTRAINT "FlexwaysLocationConfig_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
