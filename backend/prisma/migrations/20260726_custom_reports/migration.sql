-- 2026-07-26 - Report Builder: saved custom reports (Hector: users build
-- their own reports from any data in the system, TSD-style categories).
-- A saved report is DATA (definition JSON) executed by one engine that
-- injects tenant+location scope fail-closed and role-gates every field.
--
-- Additive + idempotent (IF NOT EXISTS REQUIRED: startup-migrate is
-- fail-open, workers race). Migrate via SESSION port 5432, never 6543.

DO $$ BEGIN
  CREATE TYPE "CustomReportVisibility" AS ENUM ('PRIVATE', 'TENANT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CustomReport" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "dataset" TEXT NOT NULL,
  "definition" JSONB NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "visibility" "CustomReportVisibility" NOT NULL DEFAULT 'PRIVATE',
  "lastRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomReport_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "CustomReport"
    ADD CONSTRAINT "CustomReport_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "CustomReport_tenantId_ownerUserId_name_key"
  ON "CustomReport"("tenantId", "ownerUserId", "name");

CREATE INDEX IF NOT EXISTS "CustomReport_tenantId_visibility_idx"
  ON "CustomReport"("tenantId", "visibility");
