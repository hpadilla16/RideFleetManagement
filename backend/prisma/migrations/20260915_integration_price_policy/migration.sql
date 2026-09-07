-- Which price a writeback publishes, per sede and per integration (2026-09-07).
--
-- Hector: "para cada integracion que nosotros apuntamos que precio queremos
-- empujar, para que la sede tenga control si quieren poner precios manual en el
-- sistema de Ride y empujarlos, o si quieren que market intelligence lo haga".
--
-- MANUAL = base rate + only operator-authored RateDailyPrice overrides.
-- MARKET = base rate + every override, including MI auto-apply ('MARKET_A').
--
-- Re-runnable: IF NOT EXISTS everywhere, and the seed below is ON CONFLICT
-- DO NOTHING so a second run never rewrites a choice somebody has since made.
CREATE TABLE IF NOT EXISTS "IntegrationPricePolicy" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "locationId"      TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  "priceSource"     TEXT NOT NULL DEFAULT 'MANUAL',
  "updatedByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationPricePolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationPricePolicy_tenantId_locationId_provider_key"
  ON "IntegrationPricePolicy"("tenantId", "locationId", "provider");
CREATE INDEX IF NOT EXISTS "IntegrationPricePolicy_tenantId_provider_idx"
  ON "IntegrationPricePolicy"("tenantId", "provider");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'IntegrationPricePolicy_tenantId_fkey'
  ) THEN
    ALTER TABLE "IntegrationPricePolicy"
      ADD CONSTRAINT "IntegrationPricePolicy_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'IntegrationPricePolicy_locationId_fkey'
  ) THEN
    ALTER TABLE "IntegrationPricePolicy"
      ADD CONSTRAINT "IntegrationPricePolicy_locationId_fkey"
      FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Seed every ALREADY-CONFIGURED sede with the posture it has TODAY, so this
-- deploy changes nothing about what we write into a partner's live system. The
-- switch starts as a description of current behaviour; changing it is then a
-- deliberate act in the UI.
--
--   Economy reads only RateItem.daily  -> MANUAL (MI never reached it)
--   MEX reads base + all overrides     -> MARKET (MI did reach it)
--
-- New sedes configured after this migration get the MANUAL default instead.
-- ---------------------------------------------------------------------------
INSERT INTO "IntegrationPricePolicy" ("id", "tenantId", "locationId", "provider", "priceSource", "createdAt", "updatedAt")
SELECT
  'ipp_eco_' || substr(md5(c."id"), 1, 20),
  c."tenantId", c."locationId", 'ECONOMY', 'MANUAL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "EconomyLocationConfig" c
ON CONFLICT ("tenantId", "locationId", "provider") DO NOTHING;

INSERT INTO "IntegrationPricePolicy" ("id", "tenantId", "locationId", "provider", "priceSource", "createdAt", "updatedAt")
SELECT
  'ipp_mex_' || substr(md5(c."id"), 1, 20),
  c."tenantId", c."locationId", 'MEX', 'MARKET', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MexLocationConfig" c
ON CONFLICT ("tenantId", "locationId", "provider") DO NOTHING;
