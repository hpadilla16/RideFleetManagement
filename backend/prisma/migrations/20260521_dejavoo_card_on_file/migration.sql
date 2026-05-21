-- Round 20 — Dejavoo card-on-file (2026-05-21)
--
-- Idempotent. Adds 5 columns to Customer for Dejavoo SPIn token-vault
-- card-on-file. The orchestrators populate these when the terminal returns
-- IPosToken after a successful AUTH/SALE. Used for post-rental card-not-present
-- charges (tolls, late fees, damage assessments).

ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "dejavooIposToken"      TEXT,
  ADD COLUMN IF NOT EXISTS "dejavooCardLast4"      TEXT,
  ADD COLUMN IF NOT EXISTS "dejavooCardBrand"      TEXT,
  ADD COLUMN IF NOT EXISTS "dejavooCardEntryType"  TEXT,
  ADD COLUMN IF NOT EXISTS "dejavooCardCapturedAt" TIMESTAMP(3);
