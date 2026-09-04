-- The agreement ledger gets the same idempotency floor beta.343 gave the
-- reservation ledger. Without it, two concurrent hits on the kiosk's public
-- payment-return (the reference is visible in the guest's own URL) both passed
-- verification, both saw "no agreement row yet", and both wrote one: paidAmount
-- doubled, balance clamped to zero, and staff saw a phantom overpayment they might
-- refund. Proven against Postgres in review.
--
-- PARTIAL on purpose, exactly like ReservationPayment_reservationId_gatewayRef_key:
-- only machine-minted gateway references are unique. Staff-typed references are
-- legitimately repeated (prod has 72 groups of them on the reservation side) and
-- a blanket unique would break real bookkeeping.
--
-- Safe to apply: prod measured 33 machine-ref rows and ZERO duplicate
-- (rentalAgreementId, reference) pairs on 2026-09-04. Prisma cannot express a
-- filtered unique, so this is raw SQL, like its sibling.
CREATE UNIQUE INDEX IF NOT EXISTS "RentalAgreementPayment_agreementId_gatewayRef_key"
  ON "RentalAgreementPayment" ("rentalAgreementId", "reference")
  WHERE "reference" LIKE 'IPOS:%' OR "reference" LIKE 'AUTHNET:%' OR "reference" LIKE 'SPIN:%';
