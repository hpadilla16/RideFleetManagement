-- A per-sede rate-push switch, and provenance on every pushed value (2026-09-07).
--
-- Hector: "que todas las integraciones tengan un switch para prender o apagar
-- rate pushing para asi no tener que apagar una integracion completa por lo del
-- rate". Stopping MEX's writeback used to mean disabling MexLocationConfig,
-- which ALSO stopped the inbound reservation sync — two unrelated things behind
-- one switch. Economy had its own per-area flag with no UI and no write path.
-- Both now live on IntegrationPricePolicy, one row per (sede, provider).
--
-- Re-runnable: IF NOT EXISTS + ON CONFLICT DO NOTHING throughout.
ALTER TABLE "IntegrationPricePolicy"
  ADD COLUMN IF NOT EXISTS "ratePushEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "RatePushLog"
  ADD COLUMN IF NOT EXISTS "priceSource" TEXT;

-- ---------------------------------------------------------------------------
-- Backfill the switch from what each sede does TODAY.
--
-- Economy: its own per-area ratePushEnabled column, which nothing in the app
-- ever wrote — it was set by hand. Carry it over verbatim.
-- ---------------------------------------------------------------------------
INSERT INTO "IntegrationPricePolicy" ("id", "tenantId", "locationId", "provider", "priceSource", "ratePushEnabled", "createdAt", "updatedAt")
SELECT
  'ipp_eco_' || substr(md5(c."id"), 1, 20),
  c."tenantId", c."locationId", 'ECONOMY', 'MANUAL', COALESCE(c."ratePushEnabled", false), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "EconomyLocationConfig" c
ON CONFLICT ("tenantId", "locationId", "provider") DO UPDATE
  SET "ratePushEnabled" = EXCLUDED."ratePushEnabled"
  -- Never stomp a choice a person already made. updatedByUserId is set only by
  -- the panel, so a NULL here means the row is still exactly what a migration
  -- seeded and is safe to re-seed.
  WHERE "IntegrationPricePolicy"."updatedByUserId" IS NULL;

-- ---------------------------------------------------------------------------
-- MEX: it had no rate-push switch at all — it pushed whenever the sede's config
-- row was enabled and the env gate was LIVE. That is what we carry over, with
-- ONE correction that is a bug fix, not a behaviour change we are choosing:
-- the enqueue never consulted the tenant's own MEX master switch
-- (Tenant.integrationConfig.mex.enabled), so a tenant with the integration
-- switched OFF could still have prices written into MEX's live system. A sede
-- whose tenant has MEX off seeds OFF.
-- ---------------------------------------------------------------------------
INSERT INTO "IntegrationPricePolicy" ("id", "tenantId", "locationId", "provider", "priceSource", "ratePushEnabled", "createdAt", "updatedAt")
SELECT
  'ipp_mex_' || substr(md5(c."id"), 1, 20),
  c."tenantId", c."locationId", 'MEX', 'MARKET',
  COALESCE(c."enabled", false)
    AND COALESCE((t."integrationConfig" -> 'mex' ->> 'enabled') = 'true', false),
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MexLocationConfig" c
JOIN "Tenant" t ON t."id" = c."tenantId"
ON CONFLICT ("tenantId", "locationId", "provider") DO UPDATE
  SET "ratePushEnabled" = EXCLUDED."ratePushEnabled"
  -- Never stomp a choice a person already made. updatedByUserId is set only by
  -- the panel, so a NULL here means the row is still exactly what a migration
  -- seeded and is safe to re-seed.
  WHERE "IntegrationPricePolicy"."updatedByUserId" IS NULL;
