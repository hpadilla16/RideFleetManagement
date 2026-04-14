-- CreateTable
CREATE TABLE "Franchise" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "termsText" TEXT,
    "returnInstructionsText" TEXT,
    "agreementHtmlTemplate" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Franchise_pkey" PRIMARY KEY ("id")
);

-- Add franchiseId to Reservation
ALTER TABLE "Reservation" ADD COLUMN "franchiseId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Franchise_tenantId_code_key" ON "Franchise"("tenantId", "code");
CREATE INDEX "Franchise_tenantId_isActive_idx" ON "Franchise"("tenantId", "isActive");

-- AddForeignKey
ALTER TABLE "Franchise" ADD CONSTRAINT "Franchise_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "Franchise"("id") ON DELETE SET NULL ON UPDATE CASCADE;
