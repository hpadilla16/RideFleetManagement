-- Field-level PII encryption Phase 1 — encrypted date-of-birth companion
-- columns. 2026-08-23 (doc/field-level-pii-encryption-design-2026-08-23.md).
--
-- Additive + idempotent per the migration rules (startup-migrate applies this
-- on boot; mirrors 20260823_retention_sweep). dateOfBirth is a DateTime and
-- cannot hold ciphertext, so each DOB model gets a nullable TEXT companion:
-- with FIELD_ENCRYPTION_ENABLED + FIELD_ENC_KEY set, writes store the
-- AES-256-GCM ciphertext (encf:v1:... — see src/lib/field-crypto.js) here and
-- null the DateTime; reads dual-read (prefer Enc, fall back to plaintext).
-- Nullable, no default, no backfill → ZERO behavior change until the flag is
-- turned on and scripts/backfill-field-encryption.mjs is run by hand.
--
-- The in-place string encryption (licence, address, signature data URLs)
-- needs NO migration — ciphertext lives in the same TEXT/varchar columns.
-- Re-running this migration is a no-op.

ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "dateOfBirthEnc" TEXT;
ALTER TABLE "RentalAgreement"
  ADD COLUMN IF NOT EXISTS "dateOfBirthEnc" TEXT;
ALTER TABLE "AgreementDriver"
  ADD COLUMN IF NOT EXISTS "dateOfBirthEnc" TEXT;
ALTER TABLE "ReservationAdditionalDriver"
  ADD COLUMN IF NOT EXISTS "dateOfBirthEnc" TEXT;
ALTER TABLE "LoanerAgreement"
  ADD COLUMN IF NOT EXISTS "dateOfBirthEnc" TEXT;
