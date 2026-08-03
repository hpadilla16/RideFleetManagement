-- 2026-08-03 — per-tenant Turn-Ready scoring rules (dashboard v2).
-- Rules live in a JSON column rather than 30 typed columns so adding a factor
-- later stays a code change, not a migration. Absent row = frozen defaults,
-- which reproduce the pre-2026-08-03 formula exactly.
-- Additive + idempotent: safe under AUTO_MIGRATE_ON_BOOT re-runs.
CREATE TABLE IF NOT EXISTS "TurnReadyRuleSet" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "rulesJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TurnReadyRuleSet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TurnReadyRuleSet_tenantId_key" ON "TurnReadyRuleSet"("tenantId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TurnReadyRuleSet_tenantId_fkey'
  ) THEN
    ALTER TABLE "TurnReadyRuleSet"
      ADD CONSTRAINT "TurnReadyRuleSet_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
