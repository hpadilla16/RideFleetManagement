-- TenantAuditLog — tenant-level audit events (2026-05-21)
--
-- Idempotent migration (safe to run twice). Adds:
--   - TenantAuditLog table + indexes + FKs
--
-- Companion: doc/feature-flag-convention.md

-- ============================================================================
-- Table: TenantAuditLog
-- ============================================================================
CREATE TABLE IF NOT EXISTS "TenantAuditLog" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "actorUserId" TEXT,
  "action"      TEXT NOT NULL,
  "resource"    TEXT,
  "payload"     JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "TenantAuditLog_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TenantAuditLog_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TenantAuditLog_tenantId_createdAt_idx"
  ON "TenantAuditLog"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "TenantAuditLog_action_createdAt_idx"
  ON "TenantAuditLog"("action", "createdAt");
