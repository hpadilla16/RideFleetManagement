-- Public booking website token (2026-06-24). Additive, idempotent.
-- Plan: doc/public-website-token-scoping-plan-2026-06-24.md
-- websiteTokenHash = sha256 of the X-Tenant-Token the public site sends (plaintext never stored).
-- companyLogoUrl = optional branding for the public site.
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "websiteTokenHash" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "companyLogoUrl" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_websiteTokenHash_key" ON "Tenant"("websiteTokenHash");
