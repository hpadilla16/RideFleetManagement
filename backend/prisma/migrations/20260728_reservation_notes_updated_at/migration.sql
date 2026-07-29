-- 2026-07-28 (LAX #12) — "new note" marker for the notes-visibility banner.
-- Additive + idempotent: safe under AUTO_MIGRATE_ON_BOOT re-runs.
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "notesUpdatedAt" TIMESTAMP(3);
