-- 16g — Add Reservation.termsVersion
--
-- Captures the canonical T&C version string accepted by the customer at
-- signature submission time. NULL is allowed because:
--
--   1. Every existing row was signed before this column existed and we
--      do NOT want to back-fill them with the current TC_VERSION — the
--      legal reality is that those customers accepted older language.
--   2. The 281 reservations currently sitting with autochargeBlocked=true
--      keep termsVersion=NULL. The unblock script
--      (backend/scripts/unblock-pre-terms-reservations.mjs) operates on
--      autochargeBlocked + pre-effective-date createdAt and is a
--      one-shot operational step, not a data migration.
--
-- Idempotent: `IF NOT EXISTS` guards match the convention used elsewhere
-- in this migrations folder so re-running against an already-migrated
-- environment is a no-op.

ALTER TABLE "Reservation"
  ADD COLUMN IF NOT EXISTS "termsVersion" TEXT;

-- Optional supporting index. The unblock script + reporting both filter
-- by autochargeBlocked first (already indexed); this index is a small
-- helper for "show me everyone on the latest terms" queries in admin.
-- Partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS "Reservation_termsVersion_idx"
  ON "Reservation" ("termsVersion")
  WHERE "termsVersion" IS NOT NULL;
