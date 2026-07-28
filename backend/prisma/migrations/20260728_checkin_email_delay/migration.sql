-- 2026-07-28 (LAX #8) — delayed post-check-in email.
-- Additive + idempotent: safe under AUTO_MIGRATE_ON_BOOT re-runs.
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "checkinEmailDueAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "checkinEmailSentAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Reservation_checkinEmailDueAt_idx" ON "Reservation"("checkinEmailDueAt");
