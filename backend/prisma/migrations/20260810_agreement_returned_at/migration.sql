-- When the customer ACTUALLY returned the car (Hector, 2026-08-10).
--
-- closedAt is when staff closed the record; finalizedAt is when the rental
-- began. Nothing stored the moment the car came back, so a check-in recorded
-- days late billed the customer for the staff's delay and the contract had no
-- field to show the truth. Additive + idempotent per the migration rules.
ALTER TABLE "RentalAgreement"
  ADD COLUMN IF NOT EXISTS "returnedAt" TIMESTAMPTZ;
