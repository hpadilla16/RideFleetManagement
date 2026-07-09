-- Economy (RezLight) — per-area import-window override (2026-07-09, Fase 5).
--
-- Hector approved making the near-term date window "editable por área": each
-- EconomyLocationConfig row can carry its own lookback/lookahead in DAYS. When
-- a column is NULL the worker falls back to the env defaults
-- ECONOMY_DATE_WINDOW_LOOKBACK_DAYS / ECONOMY_DATE_WINDOW_LOOKAHEAD_DAYS.
--
-- The worker fetches the UNION window (max lookback + max lookahead across the
-- tenant's ENABLED configs, env-fallback per null) in ONE list call — keeping
-- the M1 DESC-sort + paginate + cap — then applies each area's own
-- [lookback, lookahead] as a precision filter per row.
--
-- Additive only. Idempotent — ADD COLUMN IF NOT EXISTS, safe to re-run and to
-- paste into the Supabase SQL editor. Migrate via the SESSION port 5432, never
-- pgbouncer 6543.

ALTER TABLE "EconomyLocationConfig"
  ADD COLUMN IF NOT EXISTS "lookbackDays" INTEGER;

ALTER TABLE "EconomyLocationConfig"
  ADD COLUMN IF NOT EXISTS "lookaheadDays" INTEGER;
