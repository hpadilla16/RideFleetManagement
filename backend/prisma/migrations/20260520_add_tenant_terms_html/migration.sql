-- Per-tenant override for the canonical Terms & Conditions HTML.
-- When NULL or empty, the rental-agreement renderer falls back to the
-- file-based canonical T&C (backend/src/lib/terms/tc-<TC_VERSION>.html).
-- Idempotent so reruns / replays on the same DB are safe.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "termsHtml" TEXT;
