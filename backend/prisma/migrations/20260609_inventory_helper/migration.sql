-- Inventory Helper (2026-06-09). Guided fleet-inventory wizard: resumable
-- session per tenant, per-vehicle items, saved PDF report, and persisted
-- reconciliation flags for deferred status mismatches.
-- See doc/inventory-helper-plan-2026-06-09.md.
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor. Migrate via the SESSION port 5432, never pgbouncer 6543.

-- 1. Enums --------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InventorySessionStatus') THEN
    CREATE TYPE "InventorySessionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'ABANDONED', 'CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InventoryItemState') THEN
    CREATE TYPE "InventoryItemState" AS ENUM ('PENDING', 'CONFIRMED', 'EXCEPTION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InventoryLocatedStatus') THEN
    CREATE TYPE "InventoryLocatedStatus" AS ENUM ('AT_LOT', 'IN_MAINTENANCE', 'OUT_OF_SERVICE', 'ON_RENT', 'NOT_FOUND');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InventoryConfirmMethod') THEN
    CREATE TYPE "InventoryConfirmMethod" AS ENUM ('QR', 'PLATE', 'VIN', 'MANUAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InventoryMismatchType') THEN
    CREATE TYPE "InventoryMismatchType" AS ENUM ('ON_RENT_OVERDUE', 'SHOULD_BE_ON_RENT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReconciliationFlagStatus') THEN
    CREATE TYPE "ReconciliationFlagStatus" AS ENUM ('OPEN', 'RESOLVED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReconciliationResolvedReason') THEN
    CREATE TYPE "ReconciliationResolvedReason" AS ENUM ('CHECKED_IN', 'SWEEP', 'MANUAL');
  END IF;
END $$;

-- 2. InventorySession ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS "InventorySession" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "status"            "InventorySessionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "startedByUserId"   TEXT,
  "startedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActivityAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedByUserId" TEXT,
  "completedAt"       TIMESTAMP(3),
  "abandonedAt"       TIMESTAMP(3),
  "abandonedReason"   TEXT,
  "totalsJson"        JSONB,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventorySession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "InventorySession_tenantId_status_idx" ON "InventorySession"("tenantId", "status");

-- 3. InventoryItem ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "InventoryItem" (
  "id"                     TEXT NOT NULL,
  "sessionId"              TEXT NOT NULL,
  "tenantId"               TEXT,
  "vehicleId"              TEXT NOT NULL,
  "expectedStatus"         "VehicleStatus" NOT NULL,
  "expectedMileage"        INTEGER,
  "state"                  "InventoryItemState" NOT NULL DEFAULT 'PENDING',
  "locatedStatus"          "InventoryLocatedStatus",
  "confirmMethod"          "InventoryConfirmMethod",
  "confirmReason"          TEXT,
  "tiresOk"                BOOLEAN,
  "brakesOk"               BOOLEAN,
  "lightsOk"               BOOLEAN,
  "fluidsOk"               BOOLEAN,
  "cleanOk"                BOOLEAN,
  "mileageConfirmed"       BOOLEAN,
  "reportedMileage"        INTEGER,
  "photosJson"             JSONB,
  "note"                   TEXT,
  "maintenanceNote"        TEXT,
  "mismatchType"           "InventoryMismatchType",
  "mismatchResolved"       BOOLEAN NOT NULL DEFAULT false,
  "mismatchResolutionNote" TEXT,
  "reservationId"          TEXT,
  "confirmedByUserId"      TEXT,
  "confirmedAt"            TIMESTAMP(3),
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryItem_sessionId_vehicleId_key" ON "InventoryItem"("sessionId", "vehicleId");
CREATE INDEX IF NOT EXISTS "InventoryItem_sessionId_state_idx" ON "InventoryItem"("sessionId", "state");
CREATE INDEX IF NOT EXISTS "InventoryItem_tenantId_vehicleId_idx" ON "InventoryItem"("tenantId", "vehicleId");

-- 4. InventoryReport ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "InventoryReport" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "sessionId"         TEXT NOT NULL,
  "title"             TEXT NOT NULL,
  "generatedByUserId" TEXT,
  "generatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "storageBucket"     TEXT,
  "storagePath"       TEXT,
  "summaryJson"       JSONB,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryReport_sessionId_key" ON "InventoryReport"("sessionId");
CREATE INDEX IF NOT EXISTS "InventoryReport_tenantId_generatedAt_idx" ON "InventoryReport"("tenantId", "generatedAt");

-- 5. FleetReconciliationFlag --------------------------------------------------
CREATE TABLE IF NOT EXISTS "FleetReconciliationFlag" (
  "id"                         TEXT NOT NULL,
  "tenantId"                   TEXT NOT NULL,
  "vehicleId"                  TEXT NOT NULL,
  "reservationId"              TEXT,
  "type"                       "InventoryMismatchType" NOT NULL,
  "status"                     "ReconciliationFlagStatus" NOT NULL DEFAULT 'OPEN',
  "note"                       TEXT,
  "raisedByInventorySessionId" TEXT,
  "raisedByUserId"             TEXT,
  "raisedAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"                 TIMESTAMP(3),
  "resolvedByUserId"           TEXT,
  "resolvedReason"             "ReconciliationResolvedReason",
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FleetReconciliationFlag_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "FleetReconciliationFlag_tenantId_status_idx" ON "FleetReconciliationFlag"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "FleetReconciliationFlag_vehicleId_status_idx" ON "FleetReconciliationFlag"("vehicleId", "status");

-- 6. Foreign keys (guarded) ---------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventorySession_tenantId_fkey') THEN
    ALTER TABLE "InventorySession" ADD CONSTRAINT "InventorySession_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_sessionId_fkey') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "InventorySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryItem_vehicleId_fkey') THEN
    ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryReport_tenantId_fkey') THEN
    ALTER TABLE "InventoryReport" ADD CONSTRAINT "InventoryReport_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryReport_sessionId_fkey') THEN
    ALTER TABLE "InventoryReport" ADD CONSTRAINT "InventoryReport_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "InventorySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FleetReconciliationFlag_tenantId_fkey') THEN
    ALTER TABLE "FleetReconciliationFlag" ADD CONSTRAINT "FleetReconciliationFlag_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FleetReconciliationFlag_vehicleId_fkey') THEN
    ALTER TABLE "FleetReconciliationFlag" ADD CONSTRAINT "FleetReconciliationFlag_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
