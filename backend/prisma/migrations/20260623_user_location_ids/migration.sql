-- User location scoping (2026-06-23). Additive, idempotent.
-- Plan: doc/location-independence-plan-2026-06-23.md (Fase 1).
-- `locationIds` = JSON array (TEXT) of Location ids the user may see.
-- null/absent or empty = ALL locations (no restriction). ADMIN/SUPER_ADMIN bypass.
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "locationIds" TEXT;
