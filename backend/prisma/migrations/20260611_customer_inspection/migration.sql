-- Customer-led inspection + damage approval (2026-06-11).
-- Plan: doc/customer-inspection-plan-2026-06-11.md
-- New: HandoffTokenKind.CUSTOMER_INSPECTION, enums VehicleView /
-- CustomerInspectionStatus / DamageReportStatus, tables CustomerInspection +
-- VehicleDamageReport.
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor. Migrate via the SESSION port 5432, never pgbouncer 6543.
-- (Supabase is PG 15: ALTER TYPE ... ADD VALUE inside a transaction is OK as
-- long as the new value isn't used in the same transaction — it isn't.)

ALTER TYPE "HandoffTokenKind" ADD VALUE IF NOT EXISTS 'CUSTOMER_INSPECTION';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VehicleView') THEN
    CREATE TYPE "VehicleView" AS ENUM ('FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CustomerInspectionStatus') THEN
    CREATE TYPE "CustomerInspectionStatus" AS ENUM ('SENT', 'SUBMITTED', 'REVIEWED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DamageReportStatus') THEN
    CREATE TYPE "DamageReportStatus" AS ENUM ('REPORTED', 'SOFT_APPROVED', 'HARD_APPROVED', 'FIXED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CustomerInspection" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "vehicleId" TEXT NOT NULL,
  "reservationId" TEXT,
  "rentalAgreementId" TEXT,
  "reservationNumber" TEXT,
  "phase" "InspectionPhase" NOT NULL,
  "status" "CustomerInspectionStatus" NOT NULL DEFAULT 'SENT',
  "emailTo" TEXT,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentByUserId" TEXT,
  "openedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "reviewedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerInspection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CustomerInspection_tenantId_status_idx" ON "CustomerInspection"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "CustomerInspection_vehicleId_idx" ON "CustomerInspection"("vehicleId");
CREATE INDEX IF NOT EXISTS "CustomerInspection_reservationId_idx" ON "CustomerInspection"("reservationId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerInspection_vehicleId_fkey') THEN
    ALTER TABLE "CustomerInspection"
      ADD CONSTRAINT "CustomerInspection_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "VehicleDamageReport" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "vehicleId" TEXT NOT NULL,
  "customerInspectionId" TEXT,
  "reservationId" TEXT,
  "reservationNumber" TEXT,
  "phase" "InspectionPhase" NOT NULL,
  "view" "VehicleView" NOT NULL,
  "xPct" DECIMAL(5,2) NOT NULL,
  "yPct" DECIMAL(5,2) NOT NULL,
  "description" TEXT,
  "photoJson" JSONB,
  "status" "DamageReportStatus" NOT NULL DEFAULT 'REPORTED',
  "source" TEXT NOT NULL DEFAULT 'CUSTOMER',
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "fixedByUserId" TEXT,
  "fixedAt" TIMESTAMP(3),
  "fixedPhotoJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VehicleDamageReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VehicleDamageReport_vehicleId_status_idx" ON "VehicleDamageReport"("vehicleId", "status");
CREATE INDEX IF NOT EXISTS "VehicleDamageReport_customerInspectionId_idx" ON "VehicleDamageReport"("customerInspectionId");
CREATE INDEX IF NOT EXISTS "VehicleDamageReport_tenantId_status_idx" ON "VehicleDamageReport"("tenantId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VehicleDamageReport_vehicleId_fkey') THEN
    ALTER TABLE "VehicleDamageReport"
      ADD CONSTRAINT "VehicleDamageReport_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VehicleDamageReport_customerInspectionId_fkey') THEN
    ALTER TABLE "VehicleDamageReport"
      ADD CONSTRAINT "VehicleDamageReport_customerInspectionId_fkey"
      FOREIGN KEY ("customerInspectionId") REFERENCES "CustomerInspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
