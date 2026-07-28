-- 2026-07-28 - OUTBOUND rate push (F1: audit model + per-area push config).
-- MONEY-ADJACENT: this feature writes prices into a FRANCHISE'S OWN SYSTEM.
--
-- WHY: the franchise API integrations are months out, but we already hold an
-- authenticated portal session (the one that imports reservations). RezLight
-- exposes a real rate-editing surface (/RezAlliance/RateIntegration ->
-- ApplyRates), so RFM can publish Market-Intelligence-maintained prices today.
-- RFM rates are the source of truth; the franchise must mirror them.
--
-- WHY per-DATE rows: the portal grid prices per calendar day (columns = dates),
-- not a single base rate, so the audit key is (location, class, rateDate).
--
-- WHY rateCloseoutMin: the franchise BLOCKS days by pricing them absurdly high
-- (LAX uses 250.00). Overwriting one with a real rate would silently re-open
-- inventory the operator deliberately closed. The push refuses to run for a
-- location that has not declared its sentinel (NULL), and never writes over an
-- existing value at/above it.
--
-- WHY the audit table at all: ApplyRates answers
-- {"success":true,"message":"The rates have been updated."} EVEN WHEN IT
-- SILENTLY IGNORES THE VALUE (verified live 2026-07-28: writing "" to clear a
-- cell reported success and changed nothing). The success flag cannot be
-- trusted, so every push is re-read and the read-back is recorded here.
--
-- Additive + idempotent: new table + new nullable columns. Nothing reads these
-- yet (the push module ships separately, dormant behind a per-area flag that
-- defaults false).

-- ---------------------------------------------------------------------------
-- Per-area outbound push config on the existing Economy area mapping.
-- ---------------------------------------------------------------------------
ALTER TABLE "EconomyLocationConfig"
  ADD COLUMN IF NOT EXISTS "externalLocationCode" TEXT,
  ADD COLUMN IF NOT EXISTS "ratePushEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "rateClassMapJson" TEXT,
  ADD COLUMN IF NOT EXISTS "rateCloseoutMin" DECIMAL(10,2);

-- ---------------------------------------------------------------------------
-- Outbound push audit. One row per (location, class, date) value we publish.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "RatePushLog" (
  "id"                   TEXT NOT NULL,
  "tenantId"             TEXT NOT NULL,
  "provider"             TEXT NOT NULL,
  "locationId"           TEXT NOT NULL,
  "externalLocationCode" TEXT NOT NULL,
  "classCode"            TEXT NOT NULL,
  "rateDate"             DATE NOT NULL,
  "plan"                 TEXT NOT NULL DEFAULT 'DY',
  "priorValue"           DECIMAL(10,2),
  "pushedValue"          DECIMAL(10,2) NOT NULL,
  "sourceRateItemId"     TEXT,
  "trigger"              TEXT NOT NULL,
  "mode"                 TEXT NOT NULL,
  "status"               TEXT NOT NULL,
  "skipReason"           TEXT,
  "verifiedValue"        DECIMAL(10,2),
  "verifiedAt"           TIMESTAMP(3),
  "error"                TEXT,
  "createdByUserId"      TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RatePushLog_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "RatePushLog"
    ADD CONSTRAINT "RatePushLog_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "RatePushLog_tenantId_provider_createdAt_idx"
  ON "RatePushLog"("tenantId", "provider", "createdAt");
CREATE INDEX IF NOT EXISTS "RatePushLog_tenantId_locationId_classCode_rateDate_idx"
  ON "RatePushLog"("tenantId", "locationId", "classCode", "rateDate");
CREATE INDEX IF NOT EXISTS "RatePushLog_tenantId_status_idx"
  ON "RatePushLog"("tenantId", "status");
