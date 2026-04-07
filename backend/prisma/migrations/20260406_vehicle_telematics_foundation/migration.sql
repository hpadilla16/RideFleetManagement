-- CreateTable
CREATE TABLE "VehicleTelematicsDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalDeviceId" TEXT NOT NULL,
    "label" TEXT,
    "serialNumber" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleTelematicsDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleTelematicsEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "deviceId" TEXT,
    "eventType" TEXT NOT NULL DEFAULT 'PING',
    "eventAt" TIMESTAMP(3) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "speedMph" DECIMAL(8,2),
    "heading" INTEGER,
    "odometer" INTEGER,
    "fuelPct" DECIMAL(5,2),
    "batteryPct" DECIMAL(5,2),
    "engineOn" BOOLEAN,
    "payloadJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleTelematicsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleTelematicsDevice_provider_externalDeviceId_key" ON "VehicleTelematicsDevice"("provider", "externalDeviceId");

-- CreateIndex
CREATE INDEX "VehicleTelematicsDevice_tenantId_vehicleId_isActive_idx" ON "VehicleTelematicsDevice"("tenantId", "vehicleId", "isActive");

-- CreateIndex
CREATE INDEX "VehicleTelematicsEvent_tenantId_vehicleId_eventAt_idx" ON "VehicleTelematicsEvent"("tenantId", "vehicleId", "eventAt");

-- CreateIndex
CREATE INDEX "VehicleTelematicsEvent_deviceId_eventAt_idx" ON "VehicleTelematicsEvent"("deviceId", "eventAt");

-- AddForeignKey
ALTER TABLE "VehicleTelematicsDevice" ADD CONSTRAINT "VehicleTelematicsDevice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTelematicsDevice" ADD CONSTRAINT "VehicleTelematicsDevice_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTelematicsEvent" ADD CONSTRAINT "VehicleTelematicsEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTelematicsEvent" ADD CONSTRAINT "VehicleTelematicsEvent_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTelematicsEvent" ADD CONSTRAINT "VehicleTelematicsEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "VehicleTelematicsDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
