-- Where ONE scrape's suggestions land, per brand (2026-09-09).
--
-- Hector: "los precios que son de MEX, escriban a MEX directamente y que los de
-- zezgo escriban al de zezgo cuando prendemos el rate writeback".
--
-- The scrape is the expensive half and the market data at one airport is the
-- same for every brand selling there, so one profile fans out to several
-- targets rather than being cloned per franchise.
--
-- INERT: a profile with no rows here keeps using MarketScrapeProfile.targetRateId
-- and its own strategy, which is every profile that exists today.
--
-- Re-runnable.
CREATE TABLE IF NOT EXISTS "MarketScrapeProfileTarget" (
  "id"             TEXT PRIMARY KEY,
  "profileId"      TEXT NOT NULL,
  "franchiseId"    TEXT,
  "rateId"         TEXT NOT NULL,
  "strategy"       TEXT,
  "strategyAmount" DECIMAL(10,2),
  "strategyPct"    DECIMAL(5,2),
  "strategyFloor"  DECIMAL(10,2),
  "autoApply"      BOOLEAN NOT NULL DEFAULT false,
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketScrapeProfileTarget_profileId_fkey') THEN
    ALTER TABLE "MarketScrapeProfileTarget"
      ADD CONSTRAINT "MarketScrapeProfileTarget_profileId_fkey"
      FOREIGN KEY ("profileId") REFERENCES "MarketScrapeProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketScrapeProfileTarget_franchiseId_fkey') THEN
    ALTER TABLE "MarketScrapeProfileTarget"
      ADD CONSTRAINT "MarketScrapeProfileTarget_franchiseId_fkey"
      FOREIGN KEY ("franchiseId") REFERENCES "Franchise"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketScrapeProfileTarget_rateId_fkey') THEN
    ALTER TABLE "MarketScrapeProfileTarget"
      ADD CONSTRAINT "MarketScrapeProfileTarget_rateId_fkey"
      FOREIGN KEY ("rateId") REFERENCES "Rate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- One target per (profile, brand). Postgres treats NULLs as DISTINCT here, so
-- this does NOT stop two house targets on one profile — the service enforces
-- that, and this index covers the branded case.
CREATE UNIQUE INDEX IF NOT EXISTS "MarketScrapeProfileTarget_profileId_franchiseId_key"
  ON "MarketScrapeProfileTarget"("profileId", "franchiseId");
CREATE INDEX IF NOT EXISTS "MarketScrapeProfileTarget_profileId_active_idx"
  ON "MarketScrapeProfileTarget"("profileId", "active");
CREATE INDEX IF NOT EXISTS "MarketScrapeProfileTarget_rateId_idx"
  ON "MarketScrapeProfileTarget"("rateId");
