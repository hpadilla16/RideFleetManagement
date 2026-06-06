-- 2026-06-04 — per-user screen-lock exemption.
-- Allows specific accounts (e.g. the read-only ops/reporting agent login)
-- to skip the 2-minute idle screen lock. Default stays locked for everyone.
-- Additive + idempotent.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "screenLockExempt" BOOLEAN NOT NULL DEFAULT false;
