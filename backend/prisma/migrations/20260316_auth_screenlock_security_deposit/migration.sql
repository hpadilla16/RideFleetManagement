ALTER TABLE "User"
ADD COLUMN "lockPinHash" TEXT,
ADD COLUMN "lockPinUpdatedAt" TIMESTAMP(3);

ALTER TABLE "RentalAgreement"
ADD COLUMN "securityDepositAmount" DECIMAL(10, 2) NOT NULL DEFAULT 0,
ADD COLUMN "securityDepositCaptured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "securityDepositCapturedAt" TIMESTAMP(3),
ADD COLUMN "securityDepositReleasedAt" TIMESTAMP(3),
ADD COLUMN "securityDepositReference" TEXT;
