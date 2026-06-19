-- Per-tenant competitor exclusion list for Market Intelligence (2026-06-19).
-- Each tenant lists their own brand(s) + any vendors to drop from the competitor
-- pool, set from Settings → Market Intelligence → "Excluded competitors".
-- Additive only. Idempotent. Migrate via the SESSION port 5432, never pgbouncer 6543.

ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "marketExcludedVendors" JSONB;
