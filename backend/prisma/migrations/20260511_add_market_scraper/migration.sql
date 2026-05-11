-- Market scraper schema: MarketScrapeProfile + MarketScrapeRun + MarketObservation
-- + 4 supporting enums.
--
-- This is the Rate Highway-style pipeline: per-tenant profiles configure scrape
-- jobs (location + lookahead window + LOR + schedule + strategy), runs record
-- each execution, observations record per-(date, sipp, vendor) prices seen.
--
-- Idempotent: IF NOT EXISTS guards on every CREATE TABLE / INDEX. Enum types
-- use a DO block with EXCEPTION handling because Postgres doesn't have
-- CREATE TYPE IF NOT EXISTS.
--
-- Apply via Supabase SQL editor (prisma db push hangs on the pgbouncer pooler,
-- per project_supabase_migration_pattern memory).

-- ============================================================================
-- Enum types
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "MarketScrapeFrequency" AS ENUM ('DAILY', 'WEEKLY');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "MarketScrapeRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "MarketObservationStatus" AS ENUM ('FOUND', 'CLOSED', 'UNMAPPED', 'ERROR');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "MarketPricingStrategy" AS ENUM ('CHEAPEST_MINUS_AMOUNT', 'MATCH_CHEAPEST', 'CHEAPEST_PLUS_PCT', 'STATIC_FLOOR');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- MarketScrapeProfile — the config table.
-- One row per (tenant, named profile). Tenants can have many profiles to
-- cover different windows (1-14 vs 15-30 days out) or different LORs (Daily
-- vs Weekly), matching Rate Highway's typical 4-profile-per-location setup.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "MarketScrapeProfile" (
  "id"              TEXT                    NOT NULL,
  "tenantId"        TEXT                    NOT NULL,
  "name"            TEXT                    NOT NULL,
  "locationCode"    TEXT                    NOT NULL,

  "windowStartDay"  INTEGER                 NOT NULL,
  "windowEndDay"    INTEGER                 NOT NULL,
  "lorDays"         INTEGER                 NOT NULL DEFAULT 3,

  "frequency"       "MarketScrapeFrequency" NOT NULL DEFAULT 'DAILY',
  "scheduleHour"    INTEGER                 NOT NULL DEFAULT 4,
  "scheduleMinute"  INTEGER                 NOT NULL DEFAULT 1,
  "runTimezone"     TEXT                    NOT NULL DEFAULT 'America/Puerto_Rico',

  "sources"         JSONB                   NOT NULL,
  "active"          BOOLEAN                 NOT NULL DEFAULT TRUE,

  "strategy"        "MarketPricingStrategy" NOT NULL DEFAULT 'CHEAPEST_MINUS_AMOUNT',
  "strategyAmount"  DECIMAL(10, 2),
  "strategyPct"     DECIMAL(5, 2),
  "strategyFloor"   DECIMAL(10, 2),

  "targetRateId"    TEXT,
  "autoApply"       BOOLEAN                 NOT NULL DEFAULT FALSE,

  "lastRunAt"       TIMESTAMP(3),
  "lastSuccessAt"   TIMESTAMP(3),
  "lastRunStatus"   "MarketScrapeRunStatus",
  "lastRunError"    TEXT,

  "createdAt"       TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)            NOT NULL,

  CONSTRAINT "MarketScrapeProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MarketScrapeProfile_tenantId_name_key"
  ON "MarketScrapeProfile"("tenantId", "name");

CREATE INDEX IF NOT EXISTS "MarketScrapeProfile_tenantId_active_idx"
  ON "MarketScrapeProfile"("tenantId", "active");

CREATE INDEX IF NOT EXISTS "MarketScrapeProfile_targetRateId_idx"
  ON "MarketScrapeProfile"("targetRateId");

-- Foreign keys. Wrapped in DO blocks to be idempotent (Postgres doesn't have
-- ADD CONSTRAINT IF NOT EXISTS in older versions; this is the portable form).
DO $$ BEGIN
  ALTER TABLE "MarketScrapeProfile"
    ADD CONSTRAINT "MarketScrapeProfile_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "MarketScrapeProfile"
    ADD CONSTRAINT "MarketScrapeProfile_targetRateId_fkey"
    FOREIGN KEY ("targetRateId") REFERENCES "Rate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- MarketScrapeRun — one execution of a profile.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "MarketScrapeRun" (
  "id"                TEXT                    NOT NULL,
  "profileId"         TEXT                    NOT NULL,
  "status"            "MarketScrapeRunStatus" NOT NULL DEFAULT 'PENDING',

  "startedAt"         TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"        TIMESTAMP(3),
  "durationSec"       INTEGER,

  "requestsOk"        INTEGER                 NOT NULL DEFAULT 0,
  "requestsErr"       INTEGER                 NOT NULL DEFAULT 0,
  "observationsCount" INTEGER                 NOT NULL DEFAULT 0,
  "pricesApplied"     INTEGER                 NOT NULL DEFAULT 0,

  "errorMessage"      TEXT,

  CONSTRAINT "MarketScrapeRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MarketScrapeRun_profileId_startedAt_idx"
  ON "MarketScrapeRun"("profileId", "startedAt");

DO $$ BEGIN
  ALTER TABLE "MarketScrapeRun"
    ADD CONSTRAINT "MarketScrapeRun_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "MarketScrapeProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- MarketObservation — the unit fact. One row per (run, pickupDate, sipp,
-- vendor). profileId is denormalized so we can query "30-day price history
-- for IFAR pickup 2026-05-20 at SJU" without joining through runs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "MarketObservation" (
  "id"                  TEXT                      NOT NULL,
  "runId"               TEXT                      NOT NULL,
  "profileId"           TEXT                      NOT NULL,

  "observedAt"          TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pickupDate"          DATE                      NOT NULL,
  "returnDate"          DATE                      NOT NULL,
  "lorDays"             INTEGER                   NOT NULL,

  "sipp"                TEXT                      NOT NULL,
  "rawCategory"         TEXT,
  "vendor"              TEXT,

  "source"              TEXT                      NOT NULL DEFAULT 'EXPEDIA',

  "dailyPrice"          DECIMAL(10, 2),
  "totalPrice"          DECIMAL(10, 2),
  "effectiveDailyPrice" DECIMAL(10, 2),
  "currency"            TEXT                      NOT NULL DEFAULT 'USD',

  "status"              "MarketObservationStatus" NOT NULL DEFAULT 'FOUND',

  CONSTRAINT "MarketObservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MarketObservation_profileId_pickupDate_sipp_idx"
  ON "MarketObservation"("profileId", "pickupDate", "sipp");

CREATE INDEX IF NOT EXISTS "MarketObservation_runId_idx"
  ON "MarketObservation"("runId");

CREATE INDEX IF NOT EXISTS "MarketObservation_pickupDate_sipp_idx"
  ON "MarketObservation"("pickupDate", "sipp");

DO $$ BEGIN
  ALTER TABLE "MarketObservation"
    ADD CONSTRAINT "MarketObservation_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "MarketScrapeRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "MarketObservation"
    ADD CONSTRAINT "MarketObservation_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "MarketScrapeProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
