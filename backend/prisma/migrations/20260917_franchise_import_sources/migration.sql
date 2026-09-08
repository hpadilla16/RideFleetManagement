-- Which import sources belong to each franchise (2026-09-08).
--
-- Hector: "si es importado con la integracion, que venga ya con la franquicia
-- asignada importado a reservations". Until now nothing in the integrations
-- ever wrote Reservation.franchiseId — IRC's 1,401 Zezgo reservations were all
-- assigned by hand, and Corpusa's 11,018 carry none at all.
--
-- Empty is the normal case: the resolver falls back to matching a franchise
-- whose CODE equals the source system, which already covers Corpusa's ECONOMY
-- and MEX. This column is for the brands whose code cannot equal the source.
-- Re-runnable.
ALTER TABLE "Franchise"
  ADD COLUMN IF NOT EXISTS "importSources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
