-- Report Damage flow (Feature 3, 2026-07-10).
--
-- Additive columns on VehicleDamageReport that let a reservation-launched
-- "Report Damage" wizard cross-link the permanent vehicle damage record to
--   (a) the RentalAgreementCharge it put on the contract (reservationChargeId),
--   (b) the ReservationIncident DRAFT it auto-created (incidentId),
-- and carry the estimate + who-pays money context (estimatePhotoJson,
-- damageCostCents, ourDeductibleCents, responsibleParty).
--
-- All ADD COLUMN IF NOT EXISTS → idempotent and safe to re-run, safe under the
-- multi-worker boot-apply (startup-migrate) race. Every column is NULLABLE and
-- additive: existing rows (customer-inspection reports + vehicle-profile manual
-- damages) keep NULL and behave exactly as before. Migrate via the SESSION port
-- 5432, never pgbouncer.
--
-- MONEY: these columns are LINKS + context only. No money moves here — the damage
-- charge is written exactly once by addManualCharge (source 'DAMAGE_CHARGE') and
-- balance recomputes solely through syncAgreementCharges.
ALTER TABLE "VehicleDamageReport"
  ADD COLUMN IF NOT EXISTS "reservationChargeId" TEXT,
  ADD COLUMN IF NOT EXISTS "incidentId"          TEXT,
  ADD COLUMN IF NOT EXISTS "estimatePhotoJson"   JSONB,
  ADD COLUMN IF NOT EXISTS "damageCostCents"     INTEGER,
  ADD COLUMN IF NOT EXISTS "ourDeductibleCents"  INTEGER,
  ADD COLUMN IF NOT EXISTS "responsibleParty"    TEXT;
