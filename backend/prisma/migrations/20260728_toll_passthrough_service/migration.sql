-- 2026-07-28 (LAX #10) — "Toll Activation" service flag: bill actual tolls
-- at cost with NO policy/admin fee. Additive + idempotent (startup-migrate
-- re-runs migrations).
ALTER TABLE "AdditionalService" ADD COLUMN IF NOT EXISTS "tollPassthrough" BOOLEAN NOT NULL DEFAULT false;
