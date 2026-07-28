-- 2026-07-28 (LAX #5) — insurance policy expiration on Customer.
-- Additive + idempotent: safe under AUTO_MIGRATE_ON_BOOT re-runs.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "insuranceExpiry" TIMESTAMP(3);
