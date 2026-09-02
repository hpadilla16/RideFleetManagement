-- Audit/baseline closers (2026-09-06) — the seed-from-history job's
-- idempotence column. A ledger entry created by "Seed from history" records
-- the stable ref of the source it was derived from ('insp:<inspectionId>',
-- 'inc:<incidentId>', 'vdr:<damageReportId>') so a re-run creates nothing new.
-- Additive + idempotent; no new tables (RLS not applicable).
ALTER TABLE "VehicleDamageReport" ADD COLUMN IF NOT EXISTS "seedSourceRef" TEXT;
CREATE INDEX IF NOT EXISTS "VehicleDamageReport_vehicleId_seedSourceRef_idx" ON "VehicleDamageReport"("vehicleId", "seedSourceRef");
