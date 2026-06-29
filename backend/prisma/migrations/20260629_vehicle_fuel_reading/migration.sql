-- Vehicle fuel + odometer history (2026-06-29). Per-vehicle fuel-level timeline:
-- every check-out (fuelOut) / check-in (fuelIn) / admin correction / manual
-- refuel / import that captures a fuel reading appends one row. Sibling to
-- VehicleMileageEntry; the two are paired by reservationId on the vehicle
-- profile so the history reads as one out->in row per rental. Append-only
-- (corrections are new CORRECTION rows, never edits). fuelFraction is 0..1.
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor (we apply there, not via `prisma db push`).
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

-- 1. Enum ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FuelReadingSource') THEN
    CREATE TYPE "FuelReadingSource" AS ENUM ('CHECKOUT', 'CHECKIN', 'MANUAL', 'CORRECTION', 'REFUEL', 'IMPORT');
  END IF;
END $$;

-- 2. VehicleFuelReading -------------------------------------------------------
CREATE TABLE IF NOT EXISTS "VehicleFuelReading" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT,
  "vehicleId"         TEXT NOT NULL,
  "fuelFraction"      DECIMAL(4,2) NOT NULL,
  "source"            "FuelReadingSource" NOT NULL,
  "reservationId"     TEXT,
  "rentalAgreementId" TEXT,
  "reservationNumber" TEXT,
  "note"              TEXT,
  "actorUserId"       TEXT,
  "recordedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VehicleFuelReading_pkey" PRIMARY KEY ("id")
);

-- 3. Indexes ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "VehicleFuelReading_vehicleId_recordedAt_idx" ON "VehicleFuelReading"("vehicleId", "recordedAt");
CREATE INDEX IF NOT EXISTS "VehicleFuelReading_tenantId_vehicleId_idx" ON "VehicleFuelReading"("tenantId", "vehicleId");

-- 4. Foreign keys (guarded) ---------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VehicleFuelReading_tenantId_fkey') THEN
    ALTER TABLE "VehicleFuelReading" ADD CONSTRAINT "VehicleFuelReading_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VehicleFuelReading_vehicleId_fkey') THEN
    ALTER TABLE "VehicleFuelReading" ADD CONSTRAINT "VehicleFuelReading_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
