-- Economy (RezLight) booking-source integration — per-(tenant, area) enable
-- switch (2026-07-05). EconomyLocationConfig is the ONLY new table for the
-- Economy integration: ExternalReservation / ExternalSyncRun /
-- IntegrationCredential / AcrissCategoryMap / LocationCodeMap are reused as-is
-- (their sourceSystem is a free string → 'ECONOMY'). One Economy credential per
-- tenant covers every enabled area; this table decides "which reservations to
-- look at" — kept generic (externalArea is the first 3 chars of rgLocPickup,
-- e.g. MIAO01→MIA) so any future connection can reuse the shape.
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor (we apply there, not via `prisma db push`).
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

-- 1. Table -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "EconomyLocationConfig" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL,
  "locationId"   TEXT NOT NULL,
  "externalArea" TEXT NOT NULL,
  "enabled"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EconomyLocationConfig_pkey" PRIMARY KEY ("id")
);

-- 2. Unique (tenantId, externalArea) — one config row per area per tenant -----
CREATE UNIQUE INDEX IF NOT EXISTS "EconomyLocationConfig_tenantId_externalArea_key"
  ON "EconomyLocationConfig" ("tenantId", "externalArea");

-- 3. Scheduler lookup index (enabled areas per tenant) ------------------------
CREATE INDEX IF NOT EXISTS "EconomyLocationConfig_tenantId_enabled_idx"
  ON "EconomyLocationConfig" ("tenantId", "enabled");

-- 4. FK to Tenant (guarded — ADD CONSTRAINT is not IF NOT EXISTS-able) --------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EconomyLocationConfig_tenantId_fkey'
  ) THEN
    ALTER TABLE "EconomyLocationConfig"
      ADD CONSTRAINT "EconomyLocationConfig_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
