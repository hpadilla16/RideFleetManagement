-- CreateEnum
CREATE TYPE "TripIncidentPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TripIncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TripIncidentResolutionCode" AS ENUM ('CUSTOMER_CHARGED', 'WAIVED', 'INVALID_REPORT', 'DUPLICATE', 'GOODWILL', 'OTHER');

-- AlterTable
ALTER TABLE "TripIncident"
ADD COLUMN "priority" "TripIncidentPriority" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN "severity" "TripIncidentSeverity" NOT NULL DEFAULT 'LOW',
ADD COLUMN "ownerUserId" TEXT,
ADD COLUMN "dueAt" TIMESTAMP(3),
ADD COLUMN "resolutionCode" "TripIncidentResolutionCode";

-- AddForeignKey
ALTER TABLE "TripIncident"
ADD CONSTRAINT "TripIncident_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "TripIncident_ownerUserId_status_priority_idx" ON "TripIncident"("ownerUserId", "status", "priority");

-- CreateIndex
CREATE INDEX "TripIncident_status_priority_dueAt_idx" ON "TripIncident"("status", "priority", "dueAt");
