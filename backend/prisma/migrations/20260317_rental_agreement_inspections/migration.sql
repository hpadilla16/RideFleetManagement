-- CreateEnum
CREATE TYPE "InspectionPhase" AS ENUM ('CHECKOUT', 'CHECKIN');

-- CreateTable
CREATE TABLE "RentalAgreementInspection" (
    "id" TEXT NOT NULL,
    "rentalAgreementId" TEXT NOT NULL,
    "phase" "InspectionPhase" NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "actorIp" TEXT,
    "exterior" TEXT,
    "interior" TEXT,
    "tires" TEXT,
    "lights" TEXT,
    "windshield" TEXT,
    "fuelLevel" TEXT,
    "odometer" INTEGER,
    "damages" TEXT,
    "notes" TEXT,
    "photosJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalAgreementInspection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RentalAgreementInspection_rentalAgreementId_phase_key" ON "RentalAgreementInspection"("rentalAgreementId", "phase");

-- CreateIndex
CREATE INDEX "RentalAgreementInspection_rentalAgreementId_capturedAt_idx" ON "RentalAgreementInspection"("rentalAgreementId", "capturedAt");

-- AddForeignKey
ALTER TABLE "RentalAgreementInspection" ADD CONSTRAINT "RentalAgreementInspection_rentalAgreementId_fkey" FOREIGN KEY ("rentalAgreementId") REFERENCES "RentalAgreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
