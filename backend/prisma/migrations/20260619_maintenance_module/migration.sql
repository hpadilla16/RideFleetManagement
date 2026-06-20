-- Maintenance Module — Fase 1 (2026-06-19).
-- Plan: doc/maintenance-module-plan-2026-06-18.md.
-- RepairOrder (per-unit numbered) + lines + ServiceSchedule + links to damage/incident.
-- Replaces MaintenanceJob (rows migrated in a later step). Additive only. Idempotent.
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

-- Enums (guarded so re-runs don't fail).
DO $$ BEGIN CREATE TYPE "RepairOrderStatus" AS ENUM ('OPEN','IN_PROGRESS','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RepairOrderSource" AS ENUM ('SCHEDULED','DAMAGE','INCIDENT','MANUAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RepairOrderLineType" AS ENUM ('PART','LABOR','OTHER','TAX'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ServiceType" AS ENUM ('LOF','TIRE_ROTATION','BRAKES','INSPECTION','OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RepairOrder
CREATE TABLE IF NOT EXISTS "RepairOrder" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "vehicleId"       TEXT NOT NULL,
  "roNumber"        INTEGER NOT NULL,
  "locationId"      TEXT,
  "status"          "RepairOrderStatus" NOT NULL DEFAULT 'OPEN',
  "source"          "RepairOrderSource" NOT NULL DEFAULT 'MANUAL',
  "odometerAtOpen"  INTEGER,
  "openedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"     TIMESTAMP(3),
  "enteredByUserId" TEXT,
  "vendor"          TEXT,
  "poNumber"        TEXT,
  "notes"           TEXT,
  "incidentId"      TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RepairOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RepairOrder_vehicleId_roNumber_key" ON "RepairOrder" ("vehicleId","roNumber");
CREATE INDEX IF NOT EXISTS "RepairOrder_tenantId_status_idx"   ON "RepairOrder" ("tenantId","status");
CREATE INDEX IF NOT EXISTS "RepairOrder_locationId_status_idx" ON "RepairOrder" ("locationId","status");
CREATE INDEX IF NOT EXISTS "RepairOrder_vehicleId_idx"         ON "RepairOrder" ("vehicleId");

-- RepairOrderLine
CREATE TABLE IF NOT EXISTS "RepairOrderLine" (
  "id"            TEXT NOT NULL,
  "repairOrderId" TEXT NOT NULL,
  "type"          "RepairOrderLineType" NOT NULL DEFAULT 'PART',
  "description"   TEXT NOT NULL,
  "qty"           DECIMAL(10,2) NOT NULL DEFAULT 1,
  "unitCost"      DECIMAL(10,2) NOT NULL DEFAULT 0,
  "amount"        DECIMAL(10,2) NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepairOrderLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "RepairOrderLine_repairOrderId_idx" ON "RepairOrderLine" ("repairOrderId");

-- ServiceSchedule
CREATE TABLE IF NOT EXISTS "ServiceSchedule" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "vehicleId"        TEXT NOT NULL,
  "serviceType"      "ServiceType" NOT NULL,
  "intervalMiles"    INTEGER,
  "intervalDays"     INTEGER,
  "lastServiceMiles" INTEGER,
  "lastServiceAt"    TIMESTAMP(3),
  "nextDueMiles"     INTEGER,
  "nextDueAt"        TIMESTAMP(3),
  "active"           BOOLEAN NOT NULL DEFAULT true,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServiceSchedule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceSchedule_vehicleId_serviceType_key" ON "ServiceSchedule" ("vehicleId","serviceType");
CREATE INDEX IF NOT EXISTS "ServiceSchedule_tenantId_active_idx" ON "ServiceSchedule" ("tenantId","active");

-- Link from a damage report to the RO it was rolled into.
ALTER TABLE "VehicleDamageReport" ADD COLUMN IF NOT EXISTS "repairOrderId" TEXT;
CREATE INDEX IF NOT EXISTS "VehicleDamageReport_repairOrderId_idx" ON "VehicleDamageReport" ("repairOrderId");

-- Foreign keys (guarded).
DO $$ BEGIN ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "ReservationIncident"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "RepairOrderLine" ADD CONSTRAINT "RepairOrderLine_repairOrderId_fkey" FOREIGN KEY ("repairOrderId") REFERENCES "RepairOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ServiceSchedule" ADD CONSTRAINT "ServiceSchedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ServiceSchedule" ADD CONSTRAINT "ServiceSchedule_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "VehicleDamageReport" ADD CONSTRAINT "VehicleDamageReport_repairOrderId_fkey" FOREIGN KEY ("repairOrderId") REFERENCES "RepairOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
