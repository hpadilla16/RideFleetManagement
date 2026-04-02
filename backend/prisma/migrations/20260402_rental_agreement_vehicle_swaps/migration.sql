CREATE TABLE "RentalAgreementVehicleSwap" (
  "id" TEXT NOT NULL,
  "rentalAgreementId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "previousVehicleId" TEXT,
  "previousVehicleLabel" TEXT,
  "nextVehicleId" TEXT NOT NULL,
  "nextVehicleLabel" TEXT,
  "note" TEXT,
  "previousCheckedInAt" TIMESTAMP(3),
  "nextCheckedOutAt" TIMESTAMP(3),
  "previousInspectionJson" TEXT,
  "nextInspectionJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RentalAgreementVehicleSwap_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RentalAgreementVehicleSwap_rentalAgreementId_createdAt_idx"
ON "RentalAgreementVehicleSwap"("rentalAgreementId", "createdAt");

ALTER TABLE "RentalAgreementVehicleSwap"
ADD CONSTRAINT "RentalAgreementVehicleSwap_rentalAgreementId_fkey"
FOREIGN KEY ("rentalAgreementId") REFERENCES "RentalAgreement"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
