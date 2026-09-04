-- B5 Phase 2: persist the minted hosted-page LINK and the amount it was minted
-- for, so a retried press returns the same link instead of putting a second live
-- one into the world. Additive, nullable, no backfill: a session from before this
-- column simply mints on its next press, exactly as it did.
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "paymentIntentUrl" TEXT;
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "paymentIntentAmount" DECIMAL(12,2);
