-- Market-intelligence RateOffer ingest table (2026-07-02). The direct-Expedia
-- scraper has been down (blocked) since Jul 1; the new scraper hits the Kayak
-- metasearch engine instead, which returns offers from many OTAs per query.
-- Each offer is identified by the canonical (source, provider, supplier)
-- triple; the scraper upserts on the "rateoffer_identity_key" unique index
-- and "id" is DB-generated. supplier is NOT NULL ('' when unknown) so the
-- dedup unique works — Postgres treats NULLs as distinct in unique indexes.
-- Reuses the existing "MarketObservationStatus" enum for status.
--
-- Additive only. Idempotent — safe to re-run. Normally applied AUTOMATICALLY
-- at boot by the startup-migrate runner (backend/src/lib/startup-migrate.js,
-- AUTO_MIGRATE_ON_BOOT, pgbouncer-safe), so deploy = build + recreate with no
-- manual step. It is also safe to pre-apply by pasting into the Supabase SQL
-- editor (e.g. so the scraper droplet can write before the backend deploy) —
-- the runner will re-execute the idempotent SQL and record it.

-- 1. Enum ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RateSource') THEN
    CREATE TYPE "RateSource" AS ENUM ('KAYAK', 'EXPEDIA_DIRECT', 'CARRENTALS');
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Table --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "RateOffer" (
    -- DB-side default so the droplet's raw-SQL INSERTs can omit id entirely
    -- (Prisma's @default(cuid()) is client-side only — Innovation 2026-07-02).
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "runId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "RateSource" NOT NULL,
    "provider" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "pickupDate" DATE NOT NULL,
    "returnDate" DATE NOT NULL,
    "lorDays" INTEGER NOT NULL,
    "sipp" TEXT NOT NULL,
    "rawCategory" TEXT NOT NULL,
    "carExample" TEXT,
    "dailyPrice" DECIMAL(10,2),
    "totalPrice" DECIMAL(10,2),
    "effectiveDailyPrice" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "MarketObservationStatus" NOT NULL DEFAULT 'FOUND',

    CONSTRAINT "RateOffer_pkey" PRIMARY KEY ("id")
);

-- 3. Indexes ------------------------------------------------------------------
-- Dedup/upsert identity: one offer per (run, source, provider, supplier,
-- rawCategory, sipp, pickupDate, returnDate). rawCategory is in the key
-- because the SIPP mapping is lossy.
CREATE UNIQUE INDEX IF NOT EXISTS "rateoffer_identity_key"
  ON "RateOffer"("runId", "source", "provider", "supplier", "rawCategory", "sipp", "pickupDate", "returnDate");

CREATE INDEX IF NOT EXISTS "RateOffer_source_provider_pickupDate_sipp_idx"
  ON "RateOffer"("source", "provider", "pickupDate", "sipp");

CREATE INDEX IF NOT EXISTS "RateOffer_profileId_observedAt_idx"
  ON "RateOffer"("profileId", "observedAt");

-- 4. Foreign keys -------------------------------------------------------------
-- ADD CONSTRAINT has no IF NOT EXISTS, so guard via DO blocks.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'RateOffer_runId_fkey' AND conrelid = '"RateOffer"'::regclass
  ) THEN
    ALTER TABLE "RateOffer"
      ADD CONSTRAINT "RateOffer_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "MarketScrapeRun"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'RateOffer_profileId_fkey' AND conrelid = '"RateOffer"'::regclass
  ) THEN
    ALTER TABLE "RateOffer"
      ADD CONSTRAINT "RateOffer_profileId_fkey"
      FOREIGN KEY ("profileId") REFERENCES "MarketScrapeProfile"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
