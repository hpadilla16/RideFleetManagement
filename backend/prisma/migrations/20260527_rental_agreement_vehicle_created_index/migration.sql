-- 2026-05-27 — Supports buildVehicleOperationalSignalsMap's
--   SELECT DISTINCT ON ("vehicleId") ... ORDER BY "vehicleId", "createdAt" DESC
-- Without this index the planner snapshot endpoint timed out at the 15s
-- statement_timeout when scanning RentalAgreement for ~125 vehicles' worth
-- of historical rows. RentalAgreement is a small-medium table; a plain
-- (non-concurrent) CREATE INDEX takes ms and Prisma migrations require it
-- non-concurrent so the transaction can wrap the DDL.

CREATE INDEX IF NOT EXISTS "RentalAgreement_vehicleId_createdAt_idx"
  ON "RentalAgreement" ("vehicleId", "createdAt");
