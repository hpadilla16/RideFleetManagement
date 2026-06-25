-- Public Vehicle Profile fields on VehicleType (2026-06-25). Additive, idempotent.
-- Exposed read-only on the public booking API (bootstrap + vehicle-classes). Generic per tenant.
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

DO $$ BEGIN
  CREATE TYPE "Transmission" AS ENUM ('AUTOMATIC', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "VehicleType" ADD COLUMN IF NOT EXISTS "passengers" INTEGER;
ALTER TABLE "VehicleType" ADD COLUMN IF NOT EXISTS "bags" INTEGER;
ALTER TABLE "VehicleType" ADD COLUMN IF NOT EXISTS "doors" INTEGER;
ALTER TABLE "VehicleType" ADD COLUMN IF NOT EXISTS "transmission" "Transmission";
ALTER TABLE "VehicleType" ADD COLUMN IF NOT EXISTS "features" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "VehicleType" ADD COLUMN IF NOT EXISTS "unlimitedMileage" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "VehicleType" ADD COLUMN IF NOT EXISTS "freeMilesPerDay" INTEGER;
ALTER TABLE "VehicleType" ADD COLUMN IF NOT EXISTS "insuranceIncluded" BOOLEAN NOT NULL DEFAULT false;
