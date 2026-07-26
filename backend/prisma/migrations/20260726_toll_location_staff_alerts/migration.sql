-- 2026-07-26 - toll sede stamp + staff alerts (TollBridge findings a+b and
-- Hector's point 9). MONEY-ADJACENT: matching decides who gets billed.
--
-- WHY (a): TollTransaction was tenant-wide - a CA toll could evaluate against
-- a FL vehicle when both sedes live in one tenant. Accounts get a locationId
-- and every imported transaction inherits the stamp; the matcher then never
-- offers a vehicle homed at a different sede.
-- WHY (b): CA statements post up to a month late. The re-match sweep retries
-- unmatched tolls inside a PER-LOCATION window (locationConfig.tolls
-- .rematchWindowDays, default 14, LAX 45) instead of raising it globally,
-- which would reopen closed contracts at other sedes.
-- WHY (9): tolls arrive after the renter left; if nobody is told, nobody
-- collects. staffNotifiedAt is the one-email-per-toll idempotency claim,
-- staffAckAt the in-app "seen/collected" mark.
--
-- BACKFILL: existing rows get both stamps set to now() so shipping this does
-- NOT email/alert months of already-billed history - only tolls that arrive
-- after the deploy notify.
--
-- Additive + idempotent (IF NOT EXISTS REQUIRED: startup-migrate is
-- fail-open, workers race). Migrate via SESSION port 5432, never 6543.

ALTER TABLE "TollProviderAccount"
  ADD COLUMN IF NOT EXISTS "locationId" TEXT;

ALTER TABLE "TollTransaction"
  ADD COLUMN IF NOT EXISTS "locationId" TEXT;

ALTER TABLE "TollTransaction"
  ADD COLUMN IF NOT EXISTS "staffNotifiedAt" TIMESTAMP(3);

ALTER TABLE "TollTransaction"
  ADD COLUMN IF NOT EXISTS "staffAckAt" TIMESTAMP(3);

ALTER TABLE "TollTransaction"
  ADD COLUMN IF NOT EXISTS "staffAckByUserId" TEXT;

-- Human parked-for-review flag: RESET_MATCH sets it, the re-match sweep
-- excludes it, bulk-auto-match (a human) clears it. Without this the sweep
-- would resurrect and re-bill matches a human explicitly reset.
ALTER TABLE "TollTransaction"
  ADD COLUMN IF NOT EXISTS "manualHoldAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "TollTransaction_tenantId_staffAckAt_idx"
  ON "TollTransaction"("tenantId", "staffAckAt");

-- Backfill guard: mark pre-existing tolls as already notified+acked so the
-- alert pipeline starts clean and months of billed history never email.
-- ONCE-ONLY, double-fenced (QA 2026-07-26): startup-migrate is fail-open so
-- re-execution is expected, and a bare re-run would silence launch-day tolls
-- that are legitimately pending (fresh imports; released email claims). The
-- NOT EXISTS makes any run after the first a no-op: once a single row has
-- ever been stamped (by this backfill or by the runtime claim), the backfill
-- refuses to touch anything.
UPDATE "TollTransaction"
  SET "staffNotifiedAt" = CURRENT_TIMESTAMP,
      "staffAckAt" = CURRENT_TIMESTAMP
  WHERE "staffNotifiedAt" IS NULL
    AND "staffAckAt" IS NULL
    AND "createdAt" < TIMESTAMP '2026-07-27 00:00:00'
    AND NOT EXISTS (
      SELECT 1 FROM "TollTransaction" WHERE "staffNotifiedAt" IS NOT NULL
    );
