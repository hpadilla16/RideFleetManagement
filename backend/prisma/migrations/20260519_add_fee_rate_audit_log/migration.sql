-- V2 (pillar2 followup): FeeRateAuditLog
--
-- Persistent audit trail for every change to a tenant's FeeRate row(s).
-- Writes happen from `fee-rate-audit.service.recordChange` inside the same
-- Prisma transaction as the underlying CREATE / UPDATE / TOGGLE / DELETE on
-- FeeRate. If the audit insert itself fails the service degrades to a
-- logger.warn — audit is best-effort, not a barrier to the user-facing flow.
--
-- No FK to FeeRate intentionally: DELETEs must not cascade away the audit
-- record. `feeRateId` carries the id as a plain TEXT ref (nullable when the
-- underlying row has since been deleted).
--
-- Idempotent (IF NOT EXISTS) so it is safe to run via the Supabase SQL
-- editor on top of an environment that may already have part of the schema.

-- ============================================================================
-- FeeRateAuditLog
-- ============================================================================

CREATE TABLE IF NOT EXISTS "FeeRateAuditLog" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "feeRateId"   TEXT,
  "feeType"     TEXT NOT NULL,
  "locationId"  TEXT,
  "actorUserId" TEXT,
  "actorEmail"  TEXT,
  "actorRole"   TEXT,
  "changeType"  TEXT NOT NULL,
  "before"      JSONB,
  "after"       JSONB,
  "changedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "FeeRateAuditLog_tenantId_changedAt_idx"
  ON "FeeRateAuditLog" ("tenantId", "changedAt");

CREATE INDEX IF NOT EXISTS "FeeRateAuditLog_feeRateId_idx"
  ON "FeeRateAuditLog" ("feeRateId");

CREATE INDEX IF NOT EXISTS "FeeRateAuditLog_changedAt_idx"
  ON "FeeRateAuditLog" ("changedAt");
