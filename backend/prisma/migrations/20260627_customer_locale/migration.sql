-- Customer preferred language for bilingual email (2026-06-27). Additive, idempotent.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "locale" TEXT;
