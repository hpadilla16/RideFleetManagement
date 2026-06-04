-- Loaner customer self-service portal (Phase 2, 2026-06-01).
-- Adds a long-lived portal token + customer-request fields to LoanerAgreement
-- so the borrower can view status, request an extension, and schedule a
-- return. Unlike signatureToken, portalToken is NOT consumed on use.
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor (we apply there, not via `prisma db push`).

ALTER TABLE "LoanerAgreement" ADD COLUMN IF NOT EXISTS "portalToken" TEXT;
ALTER TABLE "LoanerAgreement" ADD COLUMN IF NOT EXISTS "portalTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "LoanerAgreement" ADD COLUMN IF NOT EXISTS "requestedReturnAt" TIMESTAMP(3);
ALTER TABLE "LoanerAgreement" ADD COLUMN IF NOT EXISTS "returnScheduledAt" TIMESTAMP(3);
ALTER TABLE "LoanerAgreement" ADD COLUMN IF NOT EXISTS "portalRequestNote" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "LoanerAgreement_portalToken_key" ON "LoanerAgreement"("portalToken");
