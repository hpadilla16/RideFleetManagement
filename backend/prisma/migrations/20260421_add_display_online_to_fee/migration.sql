-- Add displayOnline column to Fee model
ALTER TABLE "Fee" ADD COLUMN "displayOnline" BOOLEAN NOT NULL DEFAULT false;

-- Index for public checkout queries: fetch active, mandatory, online fees for a tenant
CREATE INDEX IF NOT EXISTS "Fee_tenantId_isActive_mandatory_displayOnline_idx" ON "Fee"("tenantId", "isActive", "mandatory", "displayOnline") WHERE ("isActive" = true AND "mandatory" = true AND "displayOnline" = true);
