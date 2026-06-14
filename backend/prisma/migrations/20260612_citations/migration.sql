-- Citations / traffic-ticket ingestion (Manuel Shop P1, 2026-06-12).
-- Plan: doc/citations-tolls-fase-a-spec-2026-06-12.md
-- New: Tenant.citationsEnabled; enums CitationSource / CitationStatus /
-- CitationBillingStatus / CitationMatchStatus; tables CitationSourceAccount +
-- CitationImportRun + Citation + CitationAssignment. Mirrors the Toll* models.
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor. Migrate via the SESSION port 5432, never pgbouncer 6543.

-- 1) Tenant feature gate -----------------------------------------------------
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "citationsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- 2) Enums -------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CitationSource') THEN
    CREATE TYPE "CitationSource" AS ENUM ('CITATION_PROCESSING_CENTER', 'T2', 'OCSO_COMPTROLLER', 'VIOLATIONINFO', 'MANUAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CitationStatus') THEN
    CREATE TYPE "CitationStatus" AS ENUM ('IMPORTED', 'MATCHED', 'NEEDS_REVIEW', 'BILLED', 'DISPUTED', 'VOID');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CitationBillingStatus') THEN
    CREATE TYPE "CitationBillingStatus" AS ENUM ('PENDING', 'POSTED_TO_AGREEMENT', 'WAIVED', 'DISPUTED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CitationMatchStatus') THEN
    CREATE TYPE "CitationMatchStatus" AS ENUM ('SUGGESTED', 'CONFIRMED', 'REJECTED', 'AUTO_CONFIRMED');
  END IF;
END $$;

-- 3) CitationSourceAccount ---------------------------------------------------
CREATE TABLE IF NOT EXISTS "CitationSourceAccount" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "source" "CitationSource" NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "authMode" TEXT NOT NULL DEFAULT 'GUEST',
  "username" TEXT,
  "passwordEncrypted" TEXT,
  "slug" TEXT,
  "settingsJson" TEXT,
  "lastSyncAt" TIMESTAMP(3),
  "lastSyncStatus" TEXT,
  "lastSyncMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CitationSourceAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CitationSourceAccount_tenantId_source_slug_key" ON "CitationSourceAccount"("tenantId", "source", "slug");
CREATE INDEX IF NOT EXISTS "CitationSourceAccount_tenantId_source_isActive_idx" ON "CitationSourceAccount"("tenantId", "source", "isActive");

-- 4) CitationImportRun -------------------------------------------------------
CREATE TABLE IF NOT EXISTS "CitationImportRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sourceAccountId" TEXT,
  "source" "CitationSource" NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "sourceType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "importedCount" INTEGER NOT NULL DEFAULT 0,
  "matchedCount" INTEGER NOT NULL DEFAULT 0,
  "reviewCount" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "metadataJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CitationImportRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CitationImportRun_tenantId_startedAt_idx" ON "CitationImportRun"("tenantId", "startedAt");

-- 5) Citation ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Citation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sourceAccountId" TEXT,
  "importRunId" TEXT,
  "source" "CitationSource" NOT NULL,
  "citationNo" TEXT NOT NULL,
  "agency" TEXT NOT NULL,
  "violationType" TEXT,
  "plateRaw" TEXT,
  "plateNormalized" TEXT,
  "plateState" TEXT,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "dueAt" TIMESTAMP(3),
  "location" TEXT,
  "externalUrl" TEXT,
  "documentPath" TEXT,
  "vehicleId" TEXT,
  "reservationId" TEXT,
  "status" "CitationStatus" NOT NULL DEFAULT 'IMPORTED',
  "billingStatus" "CitationBillingStatus" NOT NULL DEFAULT 'PENDING',
  "matchConfidence" DECIMAL(5,2),
  "needsReview" BOOLEAN NOT NULL DEFAULT false,
  "sourcePayloadJson" TEXT,
  "reviewNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Citation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Citation_tenantId_source_citationNo_key" ON "Citation"("tenantId", "source", "citationNo");
CREATE INDEX IF NOT EXISTS "Citation_tenantId_plateNormalized_plateState_issuedAt_idx" ON "Citation"("tenantId", "plateNormalized", "plateState", "issuedAt");
CREATE INDEX IF NOT EXISTS "Citation_tenantId_status_issuedAt_idx" ON "Citation"("tenantId", "status", "issuedAt");
CREATE INDEX IF NOT EXISTS "Citation_tenantId_vehicleId_issuedAt_idx" ON "Citation"("tenantId", "vehicleId", "issuedAt");

-- 6) CitationAssignment ------------------------------------------------------
CREATE TABLE IF NOT EXISTS "CitationAssignment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "citationId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "vehicleId" TEXT,
  "status" "CitationMatchStatus" NOT NULL,
  "confidence" DECIMAL(5,2),
  "matchedByUserId" TEXT,
  "matchReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CitationAssignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CitationAssignment_tenantId_reservationId_status_idx" ON "CitationAssignment"("tenantId", "reservationId", "status");
CREATE INDEX IF NOT EXISTS "CitationAssignment_citationId_status_idx" ON "CitationAssignment"("citationId", "status");

-- 7) Foreign keys (guarded) --------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationSourceAccount_tenantId_fkey') THEN
    ALTER TABLE "CitationSourceAccount" ADD CONSTRAINT "CitationSourceAccount_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationImportRun_tenantId_fkey') THEN
    ALTER TABLE "CitationImportRun" ADD CONSTRAINT "CitationImportRun_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationImportRun_sourceAccountId_fkey') THEN
    ALTER TABLE "CitationImportRun" ADD CONSTRAINT "CitationImportRun_sourceAccountId_fkey"
      FOREIGN KEY ("sourceAccountId") REFERENCES "CitationSourceAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Citation_tenantId_fkey') THEN
    ALTER TABLE "Citation" ADD CONSTRAINT "Citation_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Citation_sourceAccountId_fkey') THEN
    ALTER TABLE "Citation" ADD CONSTRAINT "Citation_sourceAccountId_fkey"
      FOREIGN KEY ("sourceAccountId") REFERENCES "CitationSourceAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Citation_importRunId_fkey') THEN
    ALTER TABLE "Citation" ADD CONSTRAINT "Citation_importRunId_fkey"
      FOREIGN KEY ("importRunId") REFERENCES "CitationImportRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Citation_vehicleId_fkey') THEN
    ALTER TABLE "Citation" ADD CONSTRAINT "Citation_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Citation_reservationId_fkey') THEN
    ALTER TABLE "Citation" ADD CONSTRAINT "Citation_reservationId_fkey"
      FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationAssignment_tenantId_fkey') THEN
    ALTER TABLE "CitationAssignment" ADD CONSTRAINT "CitationAssignment_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationAssignment_citationId_fkey') THEN
    ALTER TABLE "CitationAssignment" ADD CONSTRAINT "CitationAssignment_citationId_fkey"
      FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationAssignment_reservationId_fkey') THEN
    ALTER TABLE "CitationAssignment" ADD CONSTRAINT "CitationAssignment_reservationId_fkey"
      FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationAssignment_vehicleId_fkey') THEN
    ALTER TABLE "CitationAssignment" ADD CONSTRAINT "CitationAssignment_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationAssignment_matchedByUserId_fkey') THEN
    ALTER TABLE "CitationAssignment" ADD CONSTRAINT "CitationAssignment_matchedByUserId_fkey"
      FOREIGN KEY ("matchedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
