-- 2026-06-04 — debit-aware deposit handling.
-- Stores the best-effort card funding type ('DEBIT' | 'CREDIT', null when
-- the gateway didn't disclose it) captured alongside the card-on-file
-- token at the checkout sale tap. Additive + idempotent.
ALTER TABLE "RentalAgreement" ADD COLUMN IF NOT EXISTS "cardOnFileType" TEXT;
