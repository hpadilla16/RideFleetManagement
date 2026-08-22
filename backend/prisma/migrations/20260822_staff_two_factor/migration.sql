-- Staff two-factor auth (TOTP) — 2026-08-22.
--
-- Additive + idempotent per the migration rules (startup-migrate applies this
-- on boot). Every User column is nullable or defaulted, so no backfill is
-- required and existing rows stay valid — ZERO behavior change until a policy
-- exists or a user enrolls. Independent of the lockPin* screen-lock columns.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "twoFactorSecret" TEXT;
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "twoFactorPendingSecret" TEXT;
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "twoFactorEnrolledAt" TIMESTAMP(3);

-- One row per issued backup code. bcrypt-hashed (cost 10), single-use:
-- consuming a code stamps usedAt. Regenerating replaces the whole set.
CREATE TABLE IF NOT EXISTS "TwoFactorBackupCode" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "codeHash"  TEXT NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TwoFactorBackupCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TwoFactorBackupCode_userId_idx"
  ON "TwoFactorBackupCode" ("userId");

-- FK with cascade delete. Guarded so re-running the migration never errors.
DO $$
BEGIN
  ALTER TABLE "TwoFactorBackupCode"
    ADD CONSTRAINT "TwoFactorBackupCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
