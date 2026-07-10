-- NU Car Rentals (affiliates portal) booking-source integration — per-tenant
-- location config + the additive isPrepaid flag on ExternalReservation
-- (2026-07-09).
--
-- Clones the Economy integration. ExternalReservation / ExternalSyncRun /
-- IntegrationCredential / AcrissCategoryMap are reused as-is (their sourceSystem
-- is a free string → 'NU'). The ONLY new table is NuLocationConfig: the
-- per-tenant enable switch that maps the NU credential to a Ride location.
-- NU → FLL is 1:1, so the unique is (tenantId, locationId); externalCenter
-- (e.g. "100") is nullable metadata kept for future multi-center accounts.
--
-- Additive + idempotent — CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
-- / guarded FK, safe to re-run and safe under the multi-worker boot-apply
-- (startup-migrate) race. Migrate via the SESSION port 5432, never pgbouncer.

-- 1. isPrepaid flag on ExternalReservation (additive, nullable) --------------
-- PP/OP → true (prepaid), blank Code → false (pay-at-destination). NULL for
-- sources that don't carry the signal (TL/Economy). Never touches the money
-- posture — estimatedTotal only, no charge.
ALTER TABLE "ExternalReservation"
  ADD COLUMN IF NOT EXISTS "isPrepaid" BOOLEAN;

-- 2. NuLocationConfig table --------------------------------------------------
CREATE TABLE IF NOT EXISTS "NuLocationConfig" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "locationId"     TEXT NOT NULL,
  "externalCenter" TEXT,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "lookbackDays"   INTEGER,
  "lookaheadDays"  INTEGER,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NuLocationConfig_pkey" PRIMARY KEY ("id")
);

-- 3. Unique (tenantId, locationId) — 1:1 FLL, one Ride location per tenant ----
CREATE UNIQUE INDEX IF NOT EXISTS "NuLocationConfig_tenantId_locationId_key"
  ON "NuLocationConfig" ("tenantId", "locationId");

-- 4. Scheduler lookup index (enabled configs per tenant) ----------------------
CREATE INDEX IF NOT EXISTS "NuLocationConfig_tenantId_enabled_idx"
  ON "NuLocationConfig" ("tenantId", "enabled");

-- 5. FK to Tenant (guarded — ADD CONSTRAINT is not IF NOT EXISTS-able) --------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'NuLocationConfig_tenantId_fkey'
  ) THEN
    ALTER TABLE "NuLocationConfig"
      ADD CONSTRAINT "NuLocationConfig_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
