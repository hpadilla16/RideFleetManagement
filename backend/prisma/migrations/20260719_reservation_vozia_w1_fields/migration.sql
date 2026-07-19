-- VozIA Cap 6 / W1 (2026-07-19) — caller-editable non-money reservation fields.
-- ADDITIVE ONLY: two nullable columns. Reversible with DROP COLUMN.
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "flightNumber" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "pickupInstructions" TEXT;
