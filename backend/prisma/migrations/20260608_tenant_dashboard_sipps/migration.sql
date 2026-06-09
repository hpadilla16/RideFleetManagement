-- 2026-06-08 — Dashboard SIPP picker (beta.134).
-- Adds Tenant.dashboardSipps: a JSON array of up to 6 SIPP codes the tenant
-- pins to the Market Intelligence dashboard card. null → card falls back to the
-- top 6 by market volume (existing behaviour). Additive + nullable, no backfill,
-- no default → zero impact on existing tenants.

ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "dashboardSipps" JSONB;
