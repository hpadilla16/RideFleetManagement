-- Per-language walking directions (2026-08-25, owner-approved): the pickup
-- walking text grows an explicit Spanish variant so the tracker's ES/EN
-- toggle switches CONTENT, not just UI strings. Additive + idempotent per the
-- migration rules (startup-migrate applies this on boot; mirrors
-- 20260825_shuttle_phase3_core). Inert on deploy: the column is nullable, no
-- backfill, and every reader falls back to the existing English text until a
-- sede actually writes the Spanish one.
--
-- The location-level twin (shuttleWalkingDirectionsEs) lives inside
-- Location.locationConfig JSON — no migration needed there.

ALTER TABLE "ShuttleZone"
  ADD COLUMN IF NOT EXISTS "walkingDirectionsEs" TEXT;
