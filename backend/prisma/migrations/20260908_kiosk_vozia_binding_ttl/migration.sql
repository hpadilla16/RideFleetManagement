-- F3 prep: the conversation binding becomes WRITE authority, so it needs an age.
-- Additive and nullable: existing rows read as "never stamped", which the TTL
-- check treats as expired — fail-closed, which is the correct default for a
-- permit. No backfill: a binding from before this migration SHOULD be dead.
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "voziaBoundAt" TIMESTAMP(3);
