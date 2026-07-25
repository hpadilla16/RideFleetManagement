-- 2026-07-25 - customer damage acknowledgement signature (LAX meeting #3).
--
-- WHY: when a renter is present at the counter and accepts responsibility
-- for damage, the branch wants a signed acknowledgement captured with the
-- damage report itself, and that signature must appear on the incident
-- report PDF beside the staff certification. Optional: unsigned damage
-- reports keep working exactly as before.
--
-- WHAT: five nullable columns on "VehicleDamageReport". SignatureDataUrl is
-- a base64 PNG data URL (same convention as every other signature column in
-- this schema - none live in Storage). StatementText snapshots the EXACT
-- wording signed (canonical or the branch override from
-- Location."termsSectionsJson") so later wording edits never rewrite a
-- signed acknowledgement.
--
-- Additive + idempotent (IF NOT EXISTS is REQUIRED: startup-migrate is
-- fail-open and retries every boot; multiple workers race to apply it).
-- Nullable ADD COLUMN is metadata-only in PG 11+, no table rewrite.
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

ALTER TABLE "VehicleDamageReport"
  ADD COLUMN IF NOT EXISTS "customerAckSignatureDataUrl" TEXT;

ALTER TABLE "VehicleDamageReport"
  ADD COLUMN IF NOT EXISTS "customerAckSignerName" TEXT;

ALTER TABLE "VehicleDamageReport"
  ADD COLUMN IF NOT EXISTS "customerAckSignedAt" TIMESTAMPTZ;

ALTER TABLE "VehicleDamageReport"
  ADD COLUMN IF NOT EXISTS "customerAckIp" TEXT;

ALTER TABLE "VehicleDamageReport"
  ADD COLUMN IF NOT EXISTS "customerAckStatementText" TEXT;

-- The incident PDF looks the acknowledgement up by incidentId at print time;
-- without this it is a sequential scan per print.
CREATE INDEX IF NOT EXISTS "VehicleDamageReport_incidentId_idx"
  ON "VehicleDamageReport"("incidentId");
