-- SHUTTLE_ONLY vehicle program category (2026-08-24).
--
-- Dedicated shuttle units get their own VehicleProgramCategory value so they
-- stop counting as rentable inventory (search / availability / utilization)
-- and never surface as loaner-pool candidates. Both canonical program filters
-- (backend/src/lib/program-category.js) are allowlists (`in:` lists), so the
-- new value is excluded from both sides with no filter change.
--
-- Additive + idempotent per the migration rules (startup-migrate applies this
-- on boot). Postgres quirk: ALTER TYPE ... ADD VALUE cannot run inside an
-- explicit transaction block — startup-migrate executes this file as a plain
-- simple-protocol query with NO wrapping transaction, so a single-statement
-- file is safe. Keep it single-statement. Re-running is a no-op
-- (IF NOT EXISTS).

ALTER TYPE "VehicleProgramCategory" ADD VALUE IF NOT EXISTS 'SHUTTLE_ONLY';
