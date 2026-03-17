-- CreateTable
CREATE TABLE "ReservationAdditionalDriver" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "address" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "licenseNumber" TEXT,
    "licenseImageUploaded" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationAdditionalDriver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReservationAdditionalDriver_reservationId_createdAt_idx" ON "ReservationAdditionalDriver"("reservationId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReservationAdditionalDriver" ADD CONSTRAINT "ReservationAdditionalDriver_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
