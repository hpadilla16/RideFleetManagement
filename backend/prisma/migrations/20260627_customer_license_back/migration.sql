-- Driver-license back image for storefront document upload (2026-06-27). Additive, idempotent. Migrate via SESSION port 5432.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "licenseBackUrl" TEXT;
