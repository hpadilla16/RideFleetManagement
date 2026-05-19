-- PR-5: EndpointLoadObservation + EndpointLoadObservationDaily
--
-- Per-request PERF telemetry. Sampled at 1% by default by the
-- `endpoint-load-sampler` middleware. Daily rollup is produced by
-- `backend/src/jobs/endpoint-load-rollup.js`.
--
-- Idempotent (IF NOT EXISTS) so it is safe to run via Supabase SQL editor
-- on top of an environment that may already have part of the schema.

-- ============================================================================
-- EndpointLoadObservation — raw sampled rows
-- ============================================================================

CREATE TABLE IF NOT EXISTS "EndpointLoadObservation" (
  "id"         TEXT PRIMARY KEY,
  "tenantId"   TEXT,
  "method"     TEXT NOT NULL,
  "route"      TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "dbTimeMs"   INTEGER,
  "cacheHit"   BOOLEAN,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "EndpointLoadObservation_tenantId_observedAt_idx"
  ON "EndpointLoadObservation" ("tenantId", "observedAt");

CREATE INDEX IF NOT EXISTS "EndpointLoadObservation_route_observedAt_idx"
  ON "EndpointLoadObservation" ("route", "observedAt");

CREATE INDEX IF NOT EXISTS "EndpointLoadObservation_observedAt_idx"
  ON "EndpointLoadObservation" ("observedAt");

-- ============================================================================
-- EndpointLoadObservationDaily — rollup (one row per tenant+route+day)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "EndpointLoadObservationDaily" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT,
  "route"         TEXT NOT NULL,
  "day"           TIMESTAMP(3) NOT NULL,
  "requestCount"  INTEGER NOT NULL,
  "p50DurationMs" INTEGER NOT NULL,
  "p95DurationMs" INTEGER NOT NULL,
  "p99DurationMs" INTEGER NOT NULL,
  "errorCount"    INTEGER NOT NULL,
  "cacheHitRate"  DOUBLE PRECISION
);

CREATE UNIQUE INDEX IF NOT EXISTS "EndpointLoadObservationDaily_tenantId_route_day_key"
  ON "EndpointLoadObservationDaily" ("tenantId", "route", "day");

CREATE INDEX IF NOT EXISTS "EndpointLoadObservationDaily_day_idx"
  ON "EndpointLoadObservationDaily" ("day");
