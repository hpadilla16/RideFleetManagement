-- Vehicle mileage history (2026-06-09). Per-vehicle odometer timeline: every
-- check-out / check-in / manual correction / telematics ping that touches the
-- odometer appends one row. "Last entry wins" mirrors the most recent row onto
-- Vehicle.mileage + Vehicle.lastOdometerSource. Append-only (corrections are
-- new MANUAL rows, never edits).
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor (we apply there, not via `prisma db push`).
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

-- 1. Enum ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MileageEntrySource') THEN
    CREATE TYPE "MileageEntrySource" AS ENUM ('CHECKOUT', 'CHECKIN', 'MANUAL', 'TELEMATICS', 'IMPORT');
  END IF;
END $$;

-- 2. VehicleMileageEntry ------------------------------------------------------
CREATE TABLE IF NOT EXISTS "VehicleMileageEntry" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT,
  "vehicleId"         TEXT NOT NULL,
  "mileage"           INTEGER NOT NULL,
  "source"            "MileageEntrySource" NOT NULL,
  "reservationId"     TEXT,
  "rentalAgreementId" TEXT,
  "reservationNumber" TEXT,
  "note"              TEXT,
  "actorUserId"       TEXT,
  "recordedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VehicleMileageEntry_pkey" PRIMARY KEY ("id")
);

-- 3. Indexes ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "VehicleMileageEntry_vehicleId_recordedAt_idx" ON "VehicleMileageEntry"("vehicleId", "recordedAt");
CREATE INDEX IF NOT EXISTS "VehicleMileageEntry_tenantId_vehicleId_idx" ON "VehicleMileageEntry"("tenantId", "vehicleId");

-- 4. Foreign keys (guarded) ---------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VehicleMileageEntry_tenantId_fkey') THEN
    ALTER TABLE "VehicleMileageEntry" ADD CONSTRAINT "VehicleMileageEntry_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VehicleMileageEntry_vehicleId_fkey') THEN
    ALTER TABLE "VehicleMileageEntry" ADD CONSTRAINT "VehicleMileageEntry_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
