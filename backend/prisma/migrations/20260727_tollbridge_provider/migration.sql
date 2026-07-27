-- 2026-07-27 - TollBridge partner-feed provider. RFM polls TollBridge's
-- GET /api/partner/tolls and ingests through the same TollProviderAccount +
-- TollTransaction pipeline as the AutoExpreso/SunPass scrapers.
--
-- Additive + idempotent (IF NOT EXISTS pattern via the DO block: enum value
-- adds are not transactional-safe to repeat otherwise; startup-migrate is
-- fail-open and workers race). Migrate via SESSION port 5432, never 6543.

DO $$ BEGIN
  ALTER TYPE "TollProvider" ADD VALUE IF NOT EXISTS 'TOLLBRIDGE';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
