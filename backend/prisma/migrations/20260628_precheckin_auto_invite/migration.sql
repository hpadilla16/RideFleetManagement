-- Pre-check-in auto-email scheduler dedupe stamps (2026-06-28). Additive, idempotent.
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "precheckinAutoInviteSentAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "precheckinAutoReminderSentAt" TIMESTAMP(3);
