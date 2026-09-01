-- Notification Center MVP (2026-09-01) — the envelope + per-user read state.
-- Design: design/mockups/notification-center-mockup.html + notifications-NOTES.md
-- (B1 in the gap list). ADDITIVE AND IDEMPOTENT per the migration rules
-- (startup-migrate applies this on boot; mirrors 20260828_citation_attachments):
-- two new tables with no rows, no changes to any existing table, and nothing
-- reads them until the first emitter fires. Safe under the multi-worker
-- boot-apply (startup-migrate) race. No foreign keys on purpose — loose ids,
-- observation-table style (same reasoning as OverdueVehicleAlert): a deleted
-- vehicle/reservation/user must never cascade into the notification feed, and
-- no FK keeps this purely additive.

CREATE TABLE IF NOT EXISTS "NotificationEvent" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL,
  "locationId"   TEXT,
  "severity"     TEXT NOT NULL,
  "sourceType"   TEXT NOT NULL,
  "sourceRefId"  TEXT,
  "title"        TEXT NOT NULL,
  "body"         TEXT,
  "deepLink"     TEXT,
  "dedupeKey"    TEXT NOT NULL,
  "templateKey"  TEXT,
  "paramsJson"   TEXT,
  "audienceRole" TEXT,
  "ackByUserId"  TEXT,
  "ackByName"    TEXT,
  "ackAt"        TIMESTAMP(3),
  "resolvedAt"   TIMESTAMP(3),
  "archivedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- The emitters' idempotency anchor: upsert on (tenantId, dedupeKey) turns
-- re-detection of the same condition into a no-op (same pattern as
-- ShuttleAlert (tenantId, providerRef)).
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationEvent_tenantId_dedupeKey_key"
  ON "NotificationEvent"("tenantId", "dedupeKey");
-- The feed: newest-first within the caller's tenant.
CREATE INDEX IF NOT EXISTS "NotificationEvent_tenantId_createdAt_idx"
  ON "NotificationEvent"("tenantId", "createdAt");
-- The bell badge: unread CRITICAL/NEEDS_ACTION count by severity.
CREATE INDEX IF NOT EXISTS "NotificationEvent_tenantId_severity_createdAt_idx"
  ON "NotificationEvent"("tenantId", "severity", "createdAt");

CREATE TABLE IF NOT EXISTS "NotificationRead" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "readAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationRead_userId_notificationId_key"
  ON "NotificationRead"("userId", "notificationId");
CREATE INDEX IF NOT EXISTS "NotificationRead_notificationId_idx"
  ON "NotificationRead"("notificationId");
