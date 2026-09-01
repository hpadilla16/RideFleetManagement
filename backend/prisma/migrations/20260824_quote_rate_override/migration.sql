-- Staff-editable daily rate on quote creation. 2026-08-24.
--
-- Additive + idempotent per the migration rules (startup-migrate applies this
-- on boot; mirrors 20260823_retention_sweep / 20260823_field_encryption_dob).
-- All four columns are nullable with no default, so NO backfill is required and
-- every existing Quote row stays valid — ZERO behavior change until an
-- ADMIN/OPS agent actually overrides a rate. No type changes, no drops.
-- Re-running this migration is a no-op.
--
-- The money columns themselves (dailyRate/subtotal/fees/taxes/total) are
-- untouched: an override REPLACES their values with recomputed ones, and the
-- engine's original row stays readable in engineSnapshotJson.

ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "rateOverrideOriginalDaily" DECIMAL(10,2);
ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "rateOverrideReason" TEXT;
ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "rateOverrideByUserId" TEXT;
ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "rateOverrideAt" TIMESTAMP(3);
