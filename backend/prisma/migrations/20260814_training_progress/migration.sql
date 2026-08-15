-- Ride University: progress, and who took a payment (2026-08-14).
--
-- Additive + idempotent per the migration rules. Both changes are nullable or
-- defaulted, so no backfill is required and existing rows stay valid.

-- Who ran this charge. Previously unanswerable from the payment row itself:
-- the only actor near a payment was on an audit row describing a STATUS
-- change, which attributes a balance-settling payment to a check-in.
ALTER TABLE "ReservationPayment"
  ADD COLUMN IF NOT EXISTS "recordedByUserId" TEXT;

CREATE INDEX IF NOT EXISTS "ReservationPayment_recordedByUserId_paidAt_idx"
  ON "ReservationPayment" ("recordedByUserId", "paidAt");

-- One row per person per module. Modules themselves live in the curriculum
-- file, not here — only progress is state.
CREATE TABLE IF NOT EXISTS "TrainingProgress" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "moduleKey"     TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'ARMED',
  "armedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt"   TIMESTAMPTZ,
  "pointsAwarded" INTEGER NOT NULL DEFAULT 0,
  "provenBy"      TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingProgress_userId_moduleKey_key"
  ON "TrainingProgress" ("userId", "moduleKey");
CREATE INDEX IF NOT EXISTS "TrainingProgress_tenantId_status_idx"
  ON "TrainingProgress" ("tenantId", "status");
CREATE INDEX IF NOT EXISTS "TrainingProgress_tenantId_userId_idx"
  ON "TrainingProgress" ("tenantId", "userId");
