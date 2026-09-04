-- Who holds the remote assist grant, as asserted by Valet. Additive, nullable,
-- no backfill: an existing grant simply reads as "held, holder unknown", which
-- is the truth for grants taken before this column existed.
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "assistAgentRef" TEXT;
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "assistAgentName" TEXT;
