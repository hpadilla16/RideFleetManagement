-- Tax-aware pricing config per (tenant, location) — 2026-06-19.
-- Lets the pricing engine back-solve the BASE rate to upload from a target ALL-IN
-- price (undoing Expedia taxes + fees + brokerage). connectionType picks the formula.
-- Plan: doc/market-pricing-tax-aware-plan-2026-06-19.md. Additive only. Idempotent.
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

CREATE TABLE IF NOT EXISTS "MarketPricingConfig" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "locationCode"   TEXT NOT NULL,
  "connectionType" TEXT NOT NULL DEFAULT 'TITANIUM',
  "taxes"          JSONB NOT NULL DEFAULT '[]',
  "brokeragePct"   DECIMAL(6,3) NOT NULL DEFAULT 0,
  "floorBase"      DECIMAL(10,2),
  "currency"       TEXT NOT NULL DEFAULT 'USD',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketPricingConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MarketPricingConfig_tenantId_locationCode_key"
  ON "MarketPricingConfig" ("tenantId", "locationCode");

CREATE INDEX IF NOT EXISTS "MarketPricingConfig_tenantId_idx"
  ON "MarketPricingConfig" ("tenantId");

DO $$ BEGIN
  ALTER TABLE "MarketPricingConfig"
    ADD CONSTRAINT "MarketPricingConfig_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
