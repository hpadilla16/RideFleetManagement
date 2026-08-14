-- A tenant that exists to be SHOWN, not operated (Hector, 2026-08-14).
--
-- Ride University's showcase track runs only against a demo tenant, so a
-- convention audience can never be shown a real customer's name, licence or
-- card last-four. Same flag gates "practice" training runs.
--
-- Additive + idempotent per the migration rules. Defaults false, so every
-- existing tenant is correctly NOT a demo without a backfill.
ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;
