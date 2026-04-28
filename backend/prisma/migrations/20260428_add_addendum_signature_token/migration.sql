-- Customer self-service signing flow for rental agreement addendums (BUG-001
-- follow-up). The addendum row gets its own signature token + expiry so the
-- customer can be sent a magic-link email; the token is consumed at signature
-- submission to prevent reuse.

ALTER TABLE "RentalAgreementAddendum"
  ADD COLUMN "signatureToken"          TEXT,
  ADD COLUMN "signatureTokenExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "RentalAgreementAddendum_signatureToken_key"
  ON "RentalAgreementAddendum"("signatureToken");
