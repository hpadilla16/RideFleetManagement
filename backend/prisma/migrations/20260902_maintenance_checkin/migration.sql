-- Maintenance detection at check-in (Feature A, 2026-09-01) — the decision
-- stamp + per-vehicle snooze marker (NOTES §3 gap A1). One table carries both:
-- every Step-3 decision (SEND / SNOOZE) is a stamped audit row, and the snooze
-- MARKER is the latest SNOOZE row with "clearedAt" IS NULL, consumed (cleared)
-- by the vehicle's next check-out or check-in wizard open. ADDITIVE AND
-- IDEMPOTENT per the migration rules (startup-migrate applies this on boot;
-- mirrors 20260901_notification_center): one new table with no rows, no
-- changes to any existing table, nothing reads it until the first decision is
-- recorded. No foreign keys on purpose — loose ids, observation-table style:
-- a deleted vehicle/reservation/user must never cascade into the audit trail.

CREATE TABLE IF NOT EXISTS "MaintenanceCheckinDecision" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "vehicleId"         TEXT NOT NULL,
  "reservationId"     TEXT,
  "rentalAgreementId" TEXT,
  "reservationNumber" TEXT,
  "decision"          TEXT NOT NULL,
  "odometer"          INTEGER,
  "note"              TEXT,
  "serviceTypesJson"  TEXT,
  "repairOrderId"     TEXT,
  "lastError"         TEXT,
  "byUserId"          TEXT,
  "byName"            TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "clearedAt"         TIMESTAMP(3),
  "clearedEvent"      TEXT,
  CONSTRAINT "MaintenanceCheckinDecision_pkey" PRIMARY KEY ("id")
);

-- The audit trail: a vehicle's decisions, newest-first within a tenant.
CREATE INDEX IF NOT EXISTS "MaintenanceCheckinDecision_tenantId_vehicleId_createdAt_idx"
  ON "MaintenanceCheckinDecision"("tenantId", "vehicleId", "createdAt");
-- The marker lookup: active (uncleared) snoozes for one vehicle.
CREATE INDEX IF NOT EXISTS "MaintenanceCheckinDecision_vehicleId_decision_clearedAt_idx"
  ON "MaintenanceCheckinDecision"("vehicleId", "decision", "clearedAt");
