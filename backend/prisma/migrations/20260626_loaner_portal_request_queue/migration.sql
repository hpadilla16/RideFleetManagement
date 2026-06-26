-- Loaner Customer Requests queue (2026-06-26). Additive, idempotent. Migrate via SESSION port 5432.
ALTER TABLE "LoanerAgreement" ADD COLUMN IF NOT EXISTS "portalRequestAt" TIMESTAMP(3);
ALTER TABLE "LoanerAgreement" ADD COLUMN IF NOT EXISTS "portalRequestKind" TEXT;
ALTER TABLE "LoanerAgreement" ADD COLUMN IF NOT EXISTS "portalRequestHandledAt" TIMESTAMP(3);
