-- Utilization-based dynamic pricing tiers (Fase 2) — 2026-06-19.
-- Per-location ladder applied on top of the base margin, using projected utilization
-- from the Availability Forecast. Plan: doc/market-pricing-tax-aware-plan-2026-06-19.md.
-- Additive only. Idempotent. Migrate via the SESSION port 5432, never pgbouncer 6543.

ALTER TABLE "MarketPricingConfig"
  ADD COLUMN IF NOT EXISTS "utilizationRules" JSONB NOT NULL DEFAULT '[]';
