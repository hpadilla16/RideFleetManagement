-- Add VehicleProgramCategory enum + Vehicle.programCategory field.
-- Partitions inventory orthogonally to VehicleFleetMode so tenants with
-- both rental and loaner programs (e.g. Triangle, 200 loaner vehicles)
-- can keep their loaner units off the public rental search while
-- preserving their service rental fleet.
--
-- Default BOTH for backward compatibility: existing vehicles in prod
-- continue to surface in both rental search and loaner intake. Tenants
-- with a loaner program tag their loaner units as LOANER_ONLY through
-- the admin UI (bulk-tag flow shipping in a follow-up).

CREATE TYPE "VehicleProgramCategory" AS ENUM ('RENTAL_ONLY', 'LOANER_ONLY', 'BOTH');

ALTER TABLE "Vehicle"
  ADD COLUMN "programCategory" "VehicleProgramCategory" NOT NULL DEFAULT 'BOTH';

-- Composite index for fast filtering in the two hot paths:
--   public rental search:    WHERE tenantId=? AND programCategory IN ('RENTAL_ONLY','BOTH')
--   dealership-loaner intake: WHERE tenantId=? AND programCategory IN ('LOANER_ONLY','BOTH')
-- Postgres can use this index for both because the leading column is tenantId
-- and the second column is what we filter on.
CREATE INDEX "Vehicle_tenantId_programCategory_idx" ON "Vehicle"("tenantId", "programCategory");
