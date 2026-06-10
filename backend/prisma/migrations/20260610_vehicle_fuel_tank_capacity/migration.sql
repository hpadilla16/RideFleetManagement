-- Vehicle fuel tank capacity (2026-06-10). Fixes backlog #51 / bug
-- fleet-backend-prod__checkin-close-tank-capacity-select-invalid:
-- resolveTankCapacity() selected columns that never existed, so EVERY vehicle
-- charged fuel as a 15-gallon tank. This adds the real column; the resolver
-- reads it and only falls back to 15 (with a warn) when unset.
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor. Migrate via the SESSION port 5432, never pgbouncer 6543.

ALTER TABLE "Vehicle"
  ADD COLUMN IF NOT EXISTS "fuelTankCapacityGallons" DECIMAL(4,1);
