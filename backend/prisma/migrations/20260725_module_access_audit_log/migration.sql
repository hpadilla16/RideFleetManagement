-- Module-access grant/revoke audit trail (2026-07-25).
-- ADDITIVE ONLY: creates one new table, touches nothing existing.
--
-- Standalone rather than reusing "AuditLog": that table's reservationId is a
-- REQUIRED String with a required FK, and a permission change has no
-- reservation to attach to.
CREATE TABLE IF NOT EXISTS "ModuleAccessAuditLog" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT,
  "scope"        TEXT NOT NULL,
  "targetUserId" TEXT,
  "actorUserId"  TEXT,
  "actorRole"    TEXT,
  "changed"      JSONB NOT NULL,
  "changedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModuleAccessAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ModuleAccessAuditLog_tenantId_changedAt_idx"
  ON "ModuleAccessAuditLog" ("tenantId", "changedAt");
CREATE INDEX IF NOT EXISTS "ModuleAccessAuditLog_targetUserId_changedAt_idx"
  ON "ModuleAccessAuditLog" ("targetUserId", "changedAt");
CREATE INDEX IF NOT EXISTS "ModuleAccessAuditLog_changedAt_idx"
  ON "ModuleAccessAuditLog" ("changedAt");
