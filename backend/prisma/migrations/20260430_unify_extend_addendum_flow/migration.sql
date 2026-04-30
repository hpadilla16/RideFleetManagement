-- Unify reservation extension and rental agreement addendum flow.
--
-- 1. Reservation.originalReturnAt: captured the FIRST time a reservation
--    is extended. Stays immutable across subsequent extensions so the UI
--    can render "Originally returned X · Now returns Y". Deleting the
--    only/last extension clears it back to NULL.
--
-- 2. RentalAgreementAddendum.extensionChargeId: soft FK linking an
--    auto-created addendum to the EXTENSION_RATE ReservationCharge that
--    triggered it. Indexed for fast lookup during deleteExtension. NOT a
--    hard FK — we want the addendum to outlive its extension charge as a
--    historical record after delete (the charge is removed but the void'd
--    addendum stays for audit).

ALTER TABLE "Reservation"
  ADD COLUMN IF NOT EXISTS "originalReturnAt" TIMESTAMP(3);

ALTER TABLE "RentalAgreementAddendum"
  ADD COLUMN IF NOT EXISTS "extensionChargeId" TEXT;

CREATE INDEX IF NOT EXISTS "RentalAgreementAddendum_extensionChargeId_idx"
  ON "RentalAgreementAddendum"("extensionChargeId");
