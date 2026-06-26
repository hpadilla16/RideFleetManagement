-- Loaner class-upgrade pricing + entitlement anchor (2026-06-25). Additive, idempotent. Migrate via SESSION port 5432.
DO $$ BEGIN
  CREATE TYPE "RatePurpose" AS ENUM ('RENTAL', 'LOANER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "Rate" ADD COLUMN IF NOT EXISTS "purpose" "RatePurpose" NOT NULL DEFAULT 'RENTAL';

ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "serviceVehicleTypeId" TEXT;

DO $$ BEGIN
  ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_serviceVehicleTypeId_fkey"
    FOREIGN KEY ("serviceVehicleTypeId") REFERENCES "VehicleType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
