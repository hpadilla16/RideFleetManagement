-- Administrative / security audit trail (Wave 3, 2026-08-24).
--
-- Additive + idempotent per the migration rules: startup-migrate applies this
-- on boot, so every statement is IF NOT EXISTS and re-running is a no-op. This
-- migration only CREATES a new table + its indexes; it touches no existing
-- table and requires no backfill.
--
-- WHY A NEW TABLE (not AuditLog): AuditLog."reservationId" is NOT NULL with a
-- required FK — it is reservation-scoped. Admin/security events (logins, 2FA,
-- role changes, DSAR export/erase, sensitive reads, impersonation) have no
-- reservation, so they cannot live in AuditLog without every insert throwing.
--
-- SURVIVES ERASURE: "actorUserId" and "tenantId" are PLAIN TEXT with NO foreign
-- key, so a GDPR erasure or tenant teardown never cascades away the audit row
-- recording that it happened. "action" is TEXT (not an enum) so new event types
-- need no migration.
--
-- RETENTION (documented intent, NOT wired here): AdminAuditLog rows are aged out
-- by the Wave 2 retention sweep at ~24 months (RETENTION_AUDIT_MONTHS,
-- counsel-confirmable). That sweep lives on the unmerged Wave 2 branch; wiring it
-- here would create a cross-branch dependency, so it is deliberately deferred.

CREATE TABLE IF NOT EXISTS "AdminAuditLog" (
  "id"                   TEXT NOT NULL,
  "at"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"             TEXT,
  "actorUserId"          TEXT,
  "actorEmail"           TEXT,
  "actorRole"            TEXT,
  "impersonatedByUserId" TEXT,
  "action"               TEXT NOT NULL,
  "targetType"           TEXT,
  "targetId"             TEXT,
  "ip"                   TEXT,
  "userAgent"            TEXT,
  "metadata"             JSONB,
  "outcome"              TEXT NOT NULL DEFAULT 'SUCCESS',
  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdminAuditLog_tenantId_at_idx"
  ON "AdminAuditLog" ("tenantId", "at");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_actorUserId_at_idx"
  ON "AdminAuditLog" ("actorUserId", "at");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_action_at_idx"
  ON "AdminAuditLog" ("action", "at");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_impersonatedByUserId_at_idx"
  ON "AdminAuditLog" ("impersonatedByUserId", "at");
