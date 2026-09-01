-- Post-check-in audit — Tier 1 rules (2026-09-03) + the damage-baseline
-- smallest slice. Design: design/mockups/checkin-audit-NOTES.md (T1 table,
-- pipeline §2) + design/mockups/damage-baseline-NOTES.md (§4.1).
--
-- ADDITIVE AND IDEMPOTENT per the migration rules (startup-migrate applies
-- this on boot; mirrors 20260902_maintenance_checkin): one new observation
-- table with no rows plus four NULLABLE columns on VehicleDamageReport.
-- Nothing reads any of it until the first check-in closes after deploy.
--
-- CheckinAuditFinding is an OBSERVATION table, not a workflow owner: loose
-- ids, no foreign keys on purpose (MaintenanceCheckinDecision precedent) — a
-- deleted reservation/vehicle/user must never cascade into the audit trail.
-- One row per (reservation, checkKey); re-running the audit for the same
-- close upserts into the same row (dedupe per reservation+check). A clean
-- run writes the single checkKey='PASS' row so the queue's "Passed clean"
-- lane and the KPI strip count real audits, not absences.

CREATE TABLE IF NOT EXISTS "CheckinAuditFinding" (
  "id"                   TEXT NOT NULL,
  "tenantId"             TEXT NOT NULL,
  "reservationId"        TEXT NOT NULL,
  "rentalAgreementId"    TEXT,
  "vehicleId"            TEXT,
  "locationId"           TEXT,
  "reservationNumber"    TEXT,
  "vehicleLabel"         TEXT,
  -- ODO_IMPOSSIBLE | MILES_OUTLIER | FUEL_UP_NO_RECORD | FUEL_DROP_NO_FEE |
  -- ENTRIES_INCOMPLETE | BACKDATED_RETURN | PASS
  "checkKey"             TEXT NOT NULL,
  -- ENTRY | MILEAGE_FUEL | DAMAGE | PASS (lane routing; DAMAGE arrives with T2)
  "category"             TEXT NOT NULL,
  -- ERROR | WARN | INFO | NONE
  "severity"             TEXT NOT NULL,
  "tier"                 TEXT NOT NULL DEFAULT 'T1',
  -- OPEN | DISMISSED_NOT_ISSUE | RESOLVED
  "status"               TEXT NOT NULL DEFAULT 'OPEN',
  -- The fields the check read + the numbers it compared (JSON string).
  "detailsJson"          TEXT,
  -- RESOLVED provenance: e.g. PREEXISTING_BASELINED (dismiss fork verb 2).
  "resolution"           TEXT,
  -- The HARD_APPROVED VehicleDamageReport born from a "real but pre-existing"
  -- dismissal (mirror of VehicleDamageReport.sourceAuditFindingId).
  "linkedDamageReportId" TEXT,
  "dismissedByUserId"    TEXT,
  "dismissedByName"      TEXT,
  "dismissedAt"          TIMESTAMP(3),
  "closedByUserId"       TEXT,
  "closedByName"         TEXT,
  "returnedAt"           TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CheckinAuditFinding_pkey" PRIMARY KEY ("id")
);

-- Dedupe per reservation+check: the same condition re-detected on a re-close
-- lands on the same row (upsert), never a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS "CheckinAuditFinding_reservationId_checkKey_key"
  ON "CheckinAuditFinding"("reservationId", "checkKey");
-- The queue: a tenant's open findings, newest first.
CREATE INDEX IF NOT EXISTS "CheckinAuditFinding_tenantId_status_createdAt_idx"
  ON "CheckinAuditFinding"("tenantId", "status", "createdAt");
-- Lane counts: category × status per tenant.
CREATE INDEX IF NOT EXISTS "CheckinAuditFinding_tenantId_category_status_idx"
  ON "CheckinAuditFinding"("tenantId", "category", "status");

-- Damage baseline slice (damage-baseline-NOTES.md §4.1): four additive
-- nullable columns on the existing ledger. Existing rows keep NULLs.
ALTER TABLE "VehicleDamageReport" ADD COLUMN IF NOT EXISTS "sourceAuditFindingId" TEXT;
ALTER TABLE "VehicleDamageReport" ADD COLUMN IF NOT EXISTS "lastVerifiedAt" TIMESTAMP(3);
ALTER TABLE "VehicleDamageReport" ADD COLUMN IF NOT EXISTS "lastVerifiedPhotoRef" JSONB;
ALTER TABLE "VehicleDamageReport" ADD COLUMN IF NOT EXISTS "clearedReason" TEXT;
