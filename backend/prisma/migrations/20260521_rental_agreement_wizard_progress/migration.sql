-- Round 23 — RentalAgreement wizard progress tracking.
--
-- Idempotent. Adds six columns so the checkout / checkin wizards can resume
-- on a different device (desktop → phone → tablet) without losing progress.
--
-- - checkout/checkinWizardStep: integer cursor 0..6 (see schema doc)
-- - checkout/checkinInspectionSigPath: Storage path for the customer's
--   signature PNG on the inspection findings (new Step 5 in the reordered
--   wizard — agent gets the sig at the vehicle on phone/tablet)
-- - checkout/checkinInspectionSignedAt: timestamp the sig was captured

ALTER TABLE "RentalAgreement"
  ADD COLUMN IF NOT EXISTS "checkoutWizardStep"           INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "checkinWizardStep"            INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "checkoutInspectionSigPath"    TEXT,
  ADD COLUMN IF NOT EXISTS "checkinInspectionSigPath"     TEXT,
  ADD COLUMN IF NOT EXISTS "checkoutInspectionSignedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "checkinInspectionSignedAt"    TIMESTAMP(3);

-- Index for /api/vehicles/:id/active-wizard (perf-critical: runs on every
-- staff visit to the vehicle detail page). Without it, the lookup walks
-- the whole tenant's agreements. With it, it's an indexed point lookup.
CREATE INDEX IF NOT EXISTS "RentalAgreement_tenantId_vehicleId_finalizedAt_closedAt_idx"
  ON "RentalAgreement" ("tenantId", "vehicleId", "finalizedAt", "closedAt");
