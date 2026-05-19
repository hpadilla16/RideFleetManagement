-- 16l: add photoStorageRefs (JSONB) to RentalAgreementInspection so we can
-- migrate inspection photos from base64-in-`photosJson` to Supabase Storage.
--
-- Idempotent: safe to re-run. The `photosJson` column is intentionally kept
-- in place for one release as a fallback during the migration window. A
-- separate later migration (clear-migrated-photos-json.mjs) will null it out
-- after the backfill has been verified.

ALTER TABLE "RentalAgreementInspection"
    ADD COLUMN IF NOT EXISTS "photoStorageRefs" JSONB;
