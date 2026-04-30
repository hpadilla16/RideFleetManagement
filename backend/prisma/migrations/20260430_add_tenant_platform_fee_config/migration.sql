-- Add tenant-configurable platform fee fields
ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "platformFeeEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "platformFeePct"     DECIMAL(6, 3) NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "platformFeeMin"     DECIMAL(10, 2) NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS "platformFeeMax"     DECIMAL(10, 2) NOT NULL DEFAULT 35;
