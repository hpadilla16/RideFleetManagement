CREATE TYPE "PlannerActionType" AS ENUM (
  'ASSIGN_VEHICLE',
  'UNASSIGN_VEHICLE',
  'MOVE_RESERVATION_TIME',
  'CREATE_WASH_BLOCK',
  'CREATE_MAINTENANCE_BLOCK',
  'CREATE_OUT_OF_SERVICE_BLOCK'
);

CREATE TYPE "PlannerRecommendationType" AS ENUM (
  'VEHICLE_ASSIGNMENT',
  'REBALANCE',
  'OVERBOOKING_ALERT',
  'FLEET_SHORTAGE',
  'MAINTENANCE_SLOT',
  'WASH_SLOT'
);

CREATE TYPE "PlannerRuleMode" AS ENUM (
  'STRICT',
  'FLEXIBLE'
);

CREATE TABLE "PlannerRuleSet" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "minTurnaroundMinutes" INTEGER NOT NULL DEFAULT 60,
  "washBufferMinutes" INTEGER NOT NULL DEFAULT 30,
  "prepBufferMinutes" INTEGER NOT NULL DEFAULT 15,
  "maintenanceBufferMinutes" INTEGER NOT NULL DEFAULT 120,
  "lockWindowMinutesBeforePickup" INTEGER NOT NULL DEFAULT 180,
  "sameDayReservationBufferMinutes" INTEGER NOT NULL DEFAULT 45,
  "allowCrossLocationReassignment" BOOLEAN NOT NULL DEFAULT false,
  "strictVehicleTypeMatch" BOOLEAN NOT NULL DEFAULT true,
  "allowUpgrade" BOOLEAN NOT NULL DEFAULT true,
  "allowDowngrade" BOOLEAN NOT NULL DEFAULT false,
  "defaultWashRequired" BOOLEAN NOT NULL DEFAULT true,
  "assignmentMode" "PlannerRuleMode" NOT NULL DEFAULT 'STRICT',
  "maintenanceMode" "PlannerRuleMode" NOT NULL DEFAULT 'FLEXIBLE',
  "vehicleTypeOverridesJson" TEXT,
  "locationOverridesJson" TEXT,
  "scoringWeightsJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlannerRuleSet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlannerScenario" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "locationId" TEXT,
  "vehicleTypeId" TEXT,
  "scenarioType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'SIMULATED',
  "summaryJson" TEXT,
  "rulesSnapshotJson" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlannerScenario_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlannerScenarioAction" (
  "id" TEXT NOT NULL,
  "scenarioId" TEXT NOT NULL,
  "reservationId" TEXT,
  "vehicleId" TEXT,
  "actionType" "PlannerActionType" NOT NULL,
  "actionPayloadJson" TEXT NOT NULL,
  "reasonSummary" TEXT,
  "score" DECIMAL(8,2),
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlannerScenarioAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlannerRecommendationAudit" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "recommendationType" "PlannerRecommendationType" NOT NULL,
  "reservationId" TEXT,
  "vehicleId" TEXT,
  "scenarioId" TEXT,
  "title" TEXT NOT NULL,
  "detail" TEXT,
  "recommendationJson" TEXT NOT NULL,
  "applied" BOOLEAN NOT NULL DEFAULT false,
  "appliedByUserId" TEXT,
  "appliedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlannerRecommendationAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlannerRuleSet_tenantId_key"
ON "PlannerRuleSet"("tenantId");

CREATE INDEX "PlannerScenario_tenantId_startAt_endAt_idx"
ON "PlannerScenario"("tenantId", "startAt", "endAt");

CREATE INDEX "PlannerScenario_tenantId_scenarioType_createdAt_idx"
ON "PlannerScenario"("tenantId", "scenarioType", "createdAt");

CREATE INDEX "PlannerScenarioAction_scenarioId_sortOrder_idx"
ON "PlannerScenarioAction"("scenarioId", "sortOrder");

CREATE INDEX "PlannerRecommendationAudit_tenantId_recommendationType_createdAt_idx"
ON "PlannerRecommendationAudit"("tenantId", "recommendationType", "createdAt");

ALTER TABLE "PlannerRuleSet"
ADD CONSTRAINT "PlannerRuleSet_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlannerScenario"
ADD CONSTRAINT "PlannerScenario_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlannerScenarioAction"
ADD CONSTRAINT "PlannerScenarioAction_scenarioId_fkey"
FOREIGN KEY ("scenarioId") REFERENCES "PlannerScenario"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlannerRecommendationAudit"
ADD CONSTRAINT "PlannerRecommendationAudit_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
