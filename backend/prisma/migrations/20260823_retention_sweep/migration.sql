-- GDPR Wave 2 Phase C — automatic retention sweep + log rotation. 2026-08-23.
--
-- Additive + idempotent per the migration rules (startup-migrate applies this
-- on boot; mirrors 20260822_staff_two_factor). The two new columns are
-- nullable with no default, so NO backfill is required and every existing row
-- stays valid — ZERO behavior change until the sweep runs and stamps them.
-- The new table is create-if-not-exists. Re-running this migration is a no-op.

-- Per-record retention-sweep idempotency markers. NULL = never swept.
ALTER TABLE "RentalAgreement"
  ADD COLUMN IF NOT EXISTS "piiPurgedAt" TIMESTAMP(3);
ALTER TABLE "LoanerAgreement"
  ADD COLUMN IF NOT EXISTS "piiPurgedAt" TIMESTAMP(3);

-- Run history for the sweep scheduler. AuditLog cannot hold it (required
-- non-null reservationId), so it gets its own table.
CREATE TABLE IF NOT EXISTS "RetentionSweepRun" (
  "id"                TEXT NOT NULL,
  "startedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"        TIMESTAMP(3),
  "mode"              TEXT NOT NULL,
  "perCategoryCounts" JSONB NOT NULL,
  "aborted"           BOOLEAN NOT NULL DEFAULT false,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RetentionSweepRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RetentionSweepRun_startedAt_idx"
  ON "RetentionSweepRun" ("startedAt");
