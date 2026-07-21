-- Market Intelligence auto-apply guardrails + price-change audit (2026-07-20).
-- ADDITIVE ONLY. Two nullable guardrail columns on MarketPricingConfig and a new
-- PriceChangeLog audit table. Reversible with DROP COLUMN / DROP TABLE.

ALTER TABLE "MarketPricingConfig" ADD COLUMN IF NOT EXISTS "ceilingBase" DECIMAL(10,2);
ALTER TABLE "MarketPricingConfig" ADD COLUMN IF NOT EXISTS "maxDeltaPct" DECIMAL(6,3);

-- Guard the 15-min AUTO trigger from re-processing an already-applied run.
ALTER TABLE "MarketScrapeRun" ADD COLUMN IF NOT EXISTS "autoApplyAt" TIMESTAMP(3);

-- Authorship of a per-date override so the engine only clears its OWN overrides
-- and never wipes an operator-set holiday/event surge (source null = operator).
ALTER TABLE "RateDailyPrice" ADD COLUMN IF NOT EXISTS "source" TEXT;

CREATE TABLE IF NOT EXISTS "PriceChangeLog" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT,
  "locationCode"    TEXT,
  "rateId"          TEXT NOT NULL,
  "vehicleTypeId"   TEXT,
  "date"            TIMESTAMP(3) NOT NULL,
  "oldDaily"        DECIMAL(10,2),
  "newDaily"        DECIMAL(10,2),
  "deltaPct"        DECIMAL(10,3),
  "runId"           TEXT,
  "competitorBasis" TEXT,
  "engine"          TEXT NOT NULL,
  "outcome"         TEXT NOT NULL,
  "reason"          TEXT,
  "oldFromFallback" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceChangeLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PriceChangeLog_tenantId_createdAt_idx" ON "PriceChangeLog"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "PriceChangeLog_rateId_date_idx" ON "PriceChangeLog"("rateId", "date");
CREATE INDEX IF NOT EXISTS "PriceChangeLog_runId_idx" ON "PriceChangeLog"("runId");
