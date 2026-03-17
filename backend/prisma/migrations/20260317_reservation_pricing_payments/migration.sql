-- Extend payment method enum to support the frontend payment method set.
ALTER TYPE "AgreementPaymentMethod" ADD VALUE 'BANK_TRANSFER';

-- Create enum for reservation-level payment origin tracking.
CREATE TYPE "ReservationPaymentOrigin" AS ENUM ('OTC', 'PORTAL', 'IMPORTED', 'MIGRATED_NOTE');

-- CreateTable
CREATE TABLE "ReservationPricingSnapshot" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "dailyRate" DECIMAL(10,2),
    "taxRate" DECIMAL(5,2),
    "selectedInsuranceCode" TEXT,
    "selectedInsuranceName" TEXT,
    "depositRequired" BOOLEAN NOT NULL DEFAULT false,
    "depositMode" TEXT,
    "depositValue" DECIMAL(10,2),
    "depositBasisJson" TEXT,
    "depositAmountDue" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "securityDepositRequired" BOOLEAN NOT NULL DEFAULT false,
    "securityDepositAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationPricingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationCharge" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "chargeType" "ChargeType" NOT NULL DEFAULT 'UNIT',
    "quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "rate" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT,
    "sourceRefId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationPayment" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "method" "AgreementPaymentMethod" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reference" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PAID',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "origin" "ReservationPaymentOrigin" NOT NULL DEFAULT 'OTC',
    "gateway" TEXT,
    "notes" TEXT,
    "rentalAgreementPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReservationPricingSnapshot_reservationId_key" ON "ReservationPricingSnapshot"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationCharge_reservationId_selected_sortOrder_idx" ON "ReservationCharge"("reservationId", "selected", "sortOrder");

-- CreateIndex
CREATE INDEX "ReservationPayment_reservationId_paidAt_idx" ON "ReservationPayment"("reservationId", "paidAt");

-- CreateIndex
CREATE INDEX "ReservationPayment_reference_idx" ON "ReservationPayment"("reference");

-- AddForeignKey
ALTER TABLE "ReservationPricingSnapshot" ADD CONSTRAINT "ReservationPricingSnapshot_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationCharge" ADD CONSTRAINT "ReservationCharge_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationPayment" ADD CONSTRAINT "ReservationPayment_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
