-- Long-Term (Monthly) Reservations P1 (2026-06-03). Additive only.
CREATE TYPE "BillingCycleStatus" AS ENUM ('DUE', 'PAID', 'FAILED', 'WAIVED');

CREATE TABLE "LongTermPlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "reservationId" TEXT NOT NULL,
    "rateId" TEXT,
    "cycleLengthDays" INTEGER NOT NULL DEFAULT 30,
    "cycleRate" DECIMAL(10,2) NOT NULL,
    "includedMilesPerCycle" INTEGER DEFAULT 3000,
    "overagePerMile" DECIMAL(10,2) DEFAULT 0,
    "milesRollOver" BOOLEAN NOT NULL DEFAULT false,
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "swapsPerCycle" INTEGER NOT NULL DEFAULT 1,
    "nextCycleStartsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LongTermPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LongTermPlan_reservationId_key" ON "LongTermPlan"("reservationId");
CREATE INDEX "LongTermPlan_tenantId_status_idx" ON "LongTermPlan"("tenantId", "status");
CREATE INDEX "LongTermPlan_status_nextCycleStartsAt_idx" ON "LongTermPlan"("status", "nextCycleStartsAt");
ALTER TABLE "LongTermPlan" ADD CONSTRAINT "LongTermPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LongTermPlan" ADD CONSTRAINT "LongTermPlan_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BillingCycle" (
    "id" TEXT NOT NULL,
    "longTermPlanId" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "milesStart" INTEGER,
    "milesEnd" INTEGER,
    "overageMiles" INTEGER NOT NULL DEFAULT 0,
    "status" "BillingCycleStatus" NOT NULL DEFAULT 'DUE',
    "chargeId" TEXT,
    "paymentId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BillingCycle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BillingCycle_longTermPlanId_cycleNumber_key" ON "BillingCycle"("longTermPlanId", "cycleNumber");
CREATE INDEX "BillingCycle_status_periodEnd_idx" ON "BillingCycle"("status", "periodEnd");
ALTER TABLE "BillingCycle" ADD CONSTRAINT "BillingCycle_longTermPlanId_fkey" FOREIGN KEY ("longTermPlanId") REFERENCES "LongTermPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
