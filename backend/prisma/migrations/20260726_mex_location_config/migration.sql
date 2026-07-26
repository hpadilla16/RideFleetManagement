-- 2026-07-26 - MEX Rent a Car integration: per-(TSD account, branch) location
-- mapping, identical shape to AdvantageLocationConfig because MEX's portal is
-- the same TSD RezCentral software. Own table so a tenant can run Advantage
-- and MEX side by side without config collisions.
--
-- Additive + idempotent (IF NOT EXISTS REQUIRED: startup-migrate is
-- fail-open, workers race). Migrate via SESSION port 5432, never 6543.

CREATE TABLE IF NOT EXISTS "MexLocationConfig" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "tsdNumber" TEXT NOT NULL,
  "branch" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lookbackDays" INTEGER,
  "lookaheadDays" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MexLocationConfig_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "MexLocationConfig"
    ADD CONSTRAINT "MexLocationConfig_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "MexLocationConfig_tenantId_tsdNumber_branch_key"
  ON "MexLocationConfig"("tenantId", "tsdNumber", "branch");

CREATE INDEX IF NOT EXISTS "MexLocationConfig_tenantId_enabled_idx"
  ON "MexLocationConfig"("tenantId", "enabled");
