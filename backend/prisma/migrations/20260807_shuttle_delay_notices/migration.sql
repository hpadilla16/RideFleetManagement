-- 2026-08-07 (Hector, shuttle module spec) — the delay-notification log:
-- who was told the bus is late, when, why, by which user. A JSON array on the
-- request (not a new table) because the consumer is the request's own row in
-- the UI, and the write is always request-scoped.
-- Additive + idempotent: safe under AUTO_MIGRATE_ON_BOOT re-runs.
ALTER TABLE "ShuttleRequest" ADD COLUMN IF NOT EXISTS "delayNoticesJson" TEXT;
