-- 2026-07-28 - rate push F4: approval queue for out-of-band moves.
-- MONEY-ADJACENT: these rows authorise price changes on a franchise's system.
--
-- WHY: the delta band (default 60%) exists so a large repricing never goes out
-- unattended. But a HELD move is a real business decision, not noise -- the
-- first live dry run surfaced LAX classes priced at $11-16 against RFM's
-- $20-32 (+82% to +104%), exactly the moves an operator must see. Until now
-- they were skipped and left to rot in the log with nobody notified.
--
-- Now such a cell is recorded PENDING_APPROVAL. A human approves or rejects
-- it, and an APPROVED row authorises exactly ONE push of that
-- (class, date, value) on the next sweep -- the band is bypassed for that cell
-- only, never globally, and the approval is consumed when the push is sent.
--
-- Additive + idempotent: three nullable columns and one partial index.

ALTER TABLE "RatePushLog"
  ADD COLUMN IF NOT EXISTS "decidedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "decidedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "decisionNote" TEXT;

-- The approval queue and the "is this cell already authorised?" lookup are the
-- only hot reads, so index the pending/approved slice rather than the whole
-- (large, append-only) audit table.
CREATE INDEX IF NOT EXISTS "RatePushLog_approval_queue_idx"
  ON "RatePushLog"("tenantId", "status", "rateDate")
  WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED');
