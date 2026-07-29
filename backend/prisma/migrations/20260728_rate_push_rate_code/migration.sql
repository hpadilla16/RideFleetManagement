-- 2026-07-28 (LAX #2) — rate-code dimension on the rate-push audit log.
-- Additive + idempotent. Default STND is historically correct: every pre-fix
-- write targeted only the STND rate plan.
ALTER TABLE "RatePushLog" ADD COLUMN IF NOT EXISTS "rateCode" TEXT NOT NULL DEFAULT 'STND';
