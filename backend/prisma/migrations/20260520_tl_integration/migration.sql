-- TL International franchise integration — round 5 (2026-05-20)
--
-- Idempotent migration (safe to run twice). Adds:
--   - ReservationStatus enum value PENDING_FRANCHISE_IMPORT
--   - ExternalPromotionStatus enum
--   - Tenant.integrationConfig JSONB
--   - ExternalReservation, ExternalSyncRun, IntegrationCredential,
--     AcrissCategoryMap, LocationCodeMap, FranchisePayoutPeriod tables
--
-- Companion design: doc/tl-integration-design-2026-05-19.md

-- ============================================================================
-- Enum additions
-- ============================================================================
-- Postgres restricts ALTER TYPE ADD VALUE inside a transaction in some
-- versions. We run it standalone here so the rest can be batched safely.
ALTER TYPE "ReservationStatus" ADD VALUE IF NOT EXISTS 'PENDING_FRANCHISE_IMPORT';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ExternalPromotionStatus') THEN
    CREATE TYPE "ExternalPromotionStatus" AS ENUM
      ('PENDING','AUTO_PROMOTED','MANUAL_REVIEW','PROMOTED','REJECTED');
  END IF;
END$$;

-- ============================================================================
-- Tenant.integrationConfig
-- ============================================================================
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "integrationConfig" JSONB;

-- ============================================================================
-- ExternalReservation — staging table for franchise reservations
-- ============================================================================
CREATE TABLE IF NOT EXISTS "ExternalReservation" (
  "id"                      TEXT PRIMARY KEY,
  "tenantId"                TEXT NOT NULL REFERENCES "Tenant"("id"),
  "sourceSystem"            TEXT NOT NULL,
  "externalRef"             TEXT NOT NULL,
  "subBrand"                TEXT,
  "channel"                 TEXT,
  "supplierRef"             TEXT,
  "status"                  TEXT,
  "customerFirstName"       TEXT,
  "customerLastName"        TEXT,
  "customerEmail"           TEXT,
  "customerPhone"           TEXT,
  "customerCountry"         TEXT,
  "flightNumber"            TEXT,
  "vehicleAcriss"           TEXT,
  "vehicleDescription"      TEXT,
  "pickupAt"                TIMESTAMPTZ,
  "pickupLocation"          TEXT,
  "dropoffAt"               TIMESTAMPTZ,
  "dropoffLocation"         TEXT,
  "totalAmount"             NUMERIC(12, 2),
  "currency"                TEXT DEFAULT 'USD',
  "rawJson"                 JSONB NOT NULL,
  "firstSeenAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lastSyncedAt"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "syncRunCount"            INTEGER NOT NULL DEFAULT 1,
  "promotionStatus"         "ExternalPromotionStatus" NOT NULL DEFAULT 'PENDING',
  "needsReviewReason"       TEXT,
  "promotedToReservationId" TEXT REFERENCES "Reservation"("id"),
  "promotedAt"              TIMESTAMPTZ,
  "promotedByUserId"        TEXT,
  "rejectedReason"          TEXT,
  "rejectedAt"              TIMESTAMPTZ,
  "createdAt"               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExternalReservation_source_ref_unique"
  ON "ExternalReservation"("sourceSystem", "externalRef");
CREATE UNIQUE INDEX IF NOT EXISTS "ExternalReservation_promotedToReservationId_key"
  ON "ExternalReservation"("promotedToReservationId");
CREATE INDEX IF NOT EXISTS "ExternalReservation_tenant_pickup_idx"
  ON "ExternalReservation"("tenantId", "pickupAt");
CREATE INDEX IF NOT EXISTS "ExternalReservation_tenant_promotion_idx"
  ON "ExternalReservation"("tenantId", "promotionStatus");
CREATE INDEX IF NOT EXISTS "ExternalReservation_promotion_idx"
  ON "ExternalReservation"("promotionStatus");
CREATE INDEX IF NOT EXISTS "ExternalReservation_promoted_res_idx"
  ON "ExternalReservation"("promotedToReservationId");

-- ============================================================================
-- ExternalSyncRun — audit of every sync run
-- ============================================================================
CREATE TABLE IF NOT EXISTS "ExternalSyncRun" (
  "id"              TEXT PRIMARY KEY,
  "tenantId"        TEXT NOT NULL REFERENCES "Tenant"("id"),
  "sourceSystem"    TEXT NOT NULL,
  "startedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "finishedAt"      TIMESTAMPTZ,
  "durationMs"      INTEGER,
  "status"          TEXT NOT NULL,
  "pickupsFound"    INTEGER NOT NULL DEFAULT 0,
  "newlyInserted"   INTEGER NOT NULL DEFAULT 0,
  "updatedExisting" INTEGER NOT NULL DEFAULT 0,
  "autoPromoted"    INTEGER NOT NULL DEFAULT 0,
  "needsReview"     INTEGER NOT NULL DEFAULT 0,
  "errorsCount"     INTEGER NOT NULL DEFAULT 0,
  "notes"           TEXT
);
CREATE INDEX IF NOT EXISTS "ExternalSyncRun_tenant_started_idx"
  ON "ExternalSyncRun"("tenantId", "startedAt" DESC);

-- ============================================================================
-- IntegrationCredential — encrypted cookie / API key storage
-- ============================================================================
CREATE TABLE IF NOT EXISTS "IntegrationCredential" (
  "id"               TEXT PRIMARY KEY,
  "tenantId"         TEXT NOT NULL REFERENCES "Tenant"("id"),
  "sourceSystem"     TEXT NOT NULL,
  "encryptedPayload" TEXT NOT NULL,
  "rotatedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "rotatedByUserId"  TEXT,
  "lastTestedAt"     TIMESTAMPTZ,
  "lastTestStatus"   TEXT,
  "notes"            TEXT,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationCredential_tenant_source_unique"
  ON "IntegrationCredential"("tenantId", "sourceSystem");

-- ============================================================================
-- AcrissCategoryMap — ACRISS code (CCAR, etc.) → internal vehicle category
-- tenantId nullable → null row acts as the global default mapping
-- ============================================================================
CREATE TABLE IF NOT EXISTS "AcrissCategoryMap" (
  "id"              TEXT PRIMARY KEY,
  "tenantId"        TEXT REFERENCES "Tenant"("id"),
  "acrissCode"      TEXT NOT NULL,
  "vehicleCategory" TEXT NOT NULL,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "AcrissCategoryMap_tenant_code_unique"
  ON "AcrissCategoryMap"("tenantId", "acrissCode");

-- ============================================================================
-- LocationCodeMap — TL location code (SJUA01) → our Location.id
-- ============================================================================
CREATE TABLE IF NOT EXISTS "LocationCodeMap" (
  "id"           TEXT PRIMARY KEY,
  "tenantId"     TEXT NOT NULL REFERENCES "Tenant"("id"),
  "externalCode" TEXT NOT NULL,
  "locationId"   TEXT NOT NULL REFERENCES "Location"("id"),
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "LocationCodeMap_tenant_ext_unique"
  ON "LocationCodeMap"("tenantId", "externalCode");

-- ============================================================================
-- FranchisePayoutPeriod — monthly payout ledger per (tenant, source)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "FranchisePayoutPeriod" (
  "id"             TEXT PRIMARY KEY,
  "tenantId"       TEXT NOT NULL REFERENCES "Tenant"("id"),
  "sourceSystem"   TEXT NOT NULL,
  "year"           INTEGER NOT NULL,
  "month"          INTEGER NOT NULL,
  "expectedAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "receivedAmount" NUMERIC(12, 2),
  "receivedAt"     TIMESTAMPTZ,
  "notes"          TEXT,
  "closedAt"       TIMESTAMPTZ,
  "closedByUserId" TEXT,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "FranchisePayoutPeriod_tenant_source_year_month_unique"
  ON "FranchisePayoutPeriod"("tenantId", "sourceSystem", "year", "month");
